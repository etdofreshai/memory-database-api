# Attachments V1 — Implementation Handoff

Source of truth: `docs/attachments-v1-spec.md`

---

## 1) Ordered Implementation Checklist

| # | Task | Depends On | Est. |
|---|------|-----------|------|
| 1 | Add `multer` dependency (`npm i multer @types/multer`) | — | 5m |
| 2 | Create migration `005-attachments.sql` (tables + views + indexes) | — | 15m |
| 3 | Run migration via `tsx src/migrate.ts` | 2 | 2m |
| 4 | Create `src/routes/ingest.ts` — multipart handler + dedupe + storage + link creation | 1,3 | 2h |
| 5 | Create `src/routes/attachments.ts` — `PATCH /api/attachments/:recordId` (SCD2 update) | 3 | 45m |
| 6 | Wire routes in `src/index.ts` | 4,5 | 5m |
| 7 | Create `/memory/content/` storage directory (or env `ATTACHMENT_STORAGE_PATH`) | — | 5m |
| 8 | Unit tests for SHA-256 dedupe logic + link creation | 4 | 1h |
| 9 | Integration tests for `POST /api/messages/ingest` | 4,6 | 1h |
| 10 | Rate-limit middleware (`express-rate-limit`) | 6 | 20m |
| 11 | Manual E2E smoke test | all | 30m |

---

## 2) SQL Migration Plan

**File:** `migrations/005-attachments.sql`

```sql
-- Enable pgcrypto if not already (for gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Enable pgvector if not already
CREATE EXTENSION IF NOT EXISTS vector;

-- 2.1 attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  sha256 TEXT NOT NULL,
  size_bytes BIGINT,
  mime_type TEXT,
  file_type TEXT,
  original_file_name TEXT,
  created_at_source TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_path TEXT,
  url_local TEXT,
  url_fallback_1 TEXT,
  url_fallback_2 TEXT,
  url_fallback_3 TEXT,
  privacy_level TEXT NOT NULL DEFAULT 'private_consent'
    CHECK (privacy_level IN ('public', 'private_consent', 'private_double_consent')),
  summary_text TEXT,
  summary_model TEXT,
  summary_updated_at TIMESTAMPTZ,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  faces JSONB NOT NULL DEFAULT '[]'::jsonb,
  ocr_text TEXT,
  user_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_input TEXT,
  embedding VECTOR(1536),
  embedding_model TEXT,
  embedding_updated_at TIMESTAMPTZ,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(record_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_attachments_current ON attachments(record_id) WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_privacy ON attachments(privacy_level);
CREATE INDEX IF NOT EXISTS idx_attachments_metadata_gin ON attachments USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_attachments_labels_gin ON attachments USING GIN (labels);

CREATE OR REPLACE VIEW current_attachments AS
SELECT * FROM attachments WHERE effective_to IS NULL AND is_active = TRUE;

-- 2.2 message_attachment_links table
CREATE TABLE IF NOT EXISTS message_attachment_links (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  message_record_id UUID NOT NULL,
  attachment_record_id UUID NOT NULL,
  ordinal INTEGER,
  role TEXT,
  provider TEXT,
  provider_message_id TEXT,
  provider_attachment_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(record_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_mal_message_record_id ON message_attachment_links(message_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_attachment_record_id ON message_attachment_links(attachment_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_provider_attachment_id ON message_attachment_links(provider_attachment_id);

CREATE OR REPLACE VIEW current_message_attachment_links AS
SELECT * FROM message_attachment_links WHERE effective_to IS NULL AND is_active = TRUE;
```

---

## 3) API Contract — `POST /api/messages/ingest`

### Request (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | JSON string | Yes | Message object (same shape as existing `POST /api/messages`) |
| `files` | File(s) | No | 0–10 binary attachments |
| `attachments_meta` | JSON string | No | Array of per-file metadata, matched by index |

### Example `curl`

```bash
curl -X POST https://api.example.com/api/messages/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -F 'message={"source":"telegram","sender":"ET","content":"Check this out","timestamp":"2026-03-06T14:30:00Z","provider_message_id":"12345"}' \
  -F 'attachments_meta=[{"original_file_name":"photo.jpg","role":"original","created_at_source":"2026-03-06T14:30:00Z"}]' \
  -F 'files=@/path/to/photo.jpg'
```

### Response — 201 Created

```json
{
  "message": {
    "id": 99001,
    "record_id": "a1b2c3d4-...",
    "source": "telegram",
    "content": "Check this out"
  },
  "attachments": [
    {
      "record_id": "e5f6g7h8-...",
      "sha256": "abc123...",
      "deduplicated": false,
      "storage_path": "/memory/content/e5f6g7h8-....jpg",
      "link_id": 501
    }
  ]
}
```

### Response — 201 (with dedupe hit)

```json
{
  "message": { "id": 99002, "record_id": "..." },
  "attachments": [
    {
      "record_id": "e5f6g7h8-...",
      "sha256": "abc123...",
      "deduplicated": true,
      "storage_path": "/memory/content/e5f6g7h8-....jpg",
      "link_id": 502
    }
  ]
}
```

---

## 4) Internal Processing Flow

```
POST /api/messages/ingest
│
├─ 1. Auth check (existing middleware)
├─ 2. Parse multipart (multer, memory storage, 50MB limit)
├─ 3. Validate `message` JSON field (required fields: source, content|sender)
├─ 4. Parse `attachments_meta` JSON (default: [])
│
├─ 5. BEGIN transaction
│   │
│   ├─ 5a. Upsert message row (existing message creation logic)
│   │      → returns message_record_id
│   │
│   ├─ 5b. For each uploaded file (index i):
│   │   ├─ Compute SHA-256 from buffer
│   │   ├─ Query: SELECT record_id, storage_path FROM current_attachments WHERE sha256 = $1
│   │   ├─ IF found:
│   │   │   └─ reuse existing attachment_record_id (deduplicated=true)
│   │   ├─ ELSE:
│   │   │   ├─ Generate new record_id
│   │   │   ├─ Determine ext from mime_type or original_file_name
│   │   │   ├─ storage_path = `/memory/content/<record_id>.<ext>`
│   │   │   ├─ Write file bytes to disk
│   │   │   └─ INSERT INTO attachments (sha256, size_bytes, mime_type, file_type,
│   │   │       original_file_name, storage_path, url_local, created_at_source, ...)
│   │   │
│   │   └─ INSERT INTO message_attachment_links
│   │       (message_record_id, attachment_record_id, ordinal=i, role, provider, ...)
│   │
│   └─ 5c. COMMIT
│
└─ 6. Return 201 { message, attachments[] }
```

**Rollback:** If any step fails after BEGIN, ROLLBACK transaction. If file was written to disk during a failed tx, delete it in catch block (best-effort cleanup).

---

## 5) Error Handling Matrix

| Condition | HTTP | Response Body | Action |
|-----------|------|---------------|--------|
| Missing `message` field | 400 | `{ error: "message field required" }` | Reject |
| Invalid `message` JSON | 400 | `{ error: "invalid message JSON" }` | Reject |
| File exceeds 50MB | 413 | `{ error: "file too large" }` | multer limit |
| >10 files | 400 | `{ error: "max 10 files per request" }` | multer limit |
| SHA-256 compute fails | 500 | `{ error: "internal error" }` | Rollback tx |
| Disk write fails (ENOSPC/EPERM) | 500 | `{ error: "storage write failed" }` | Rollback tx, log |
| DB constraint violation | 409 | `{ error: "conflict", detail }` | Rollback tx |
| Auth missing/invalid | 401 | `{ error: "unauthorized" }` | Reject |
| Rate limit exceeded | 429 | `{ error: "rate limit exceeded" }` | Reject |
| Unexpected error | 500 | `{ error: "internal error" }` | Rollback, log |

---

## 6) Rate-Limiting & Backfill Strategy

### Rate Limits (via `express-rate-limit`)

| Path | Window | Max | Notes |
|------|--------|-----|-------|
| `POST /api/messages/ingest` | 1 min | 30 | Normal real-time ingest |
| `POST /api/messages/ingest` (backfill) | 1 min | 120 | When `X-Backfill: true` header + write token |
| `PATCH /api/attachments/:id` | 1 min | 60 | Enrichment updates |

### Backfill Strategy

- Caller sets header `X-Backfill: true` → relaxed rate limit
- Backfill requests are otherwise identical to normal ingest
- Caller is responsible for throttling (e.g., 5 concurrent, 100ms delay between)
- No special bulk endpoint in V1; batch via sequential calls
- Future V2 consideration: `POST /api/messages/ingest/batch` accepting NDJSON + tar

---

## 7) Test Plan

### Unit Tests (`src/__tests__/`)

| Test | What |
|------|------|
| `dedupe.test.ts` | SHA-256 computation returns correct hash for known input |
| `dedupe.test.ts` | Duplicate hash reuses existing record_id |
| `dedupe.test.ts` | New hash creates new attachment row |
| `ingest-validation.test.ts` | Missing `message` → 400 |
| `ingest-validation.test.ts` | Invalid JSON in `message` → 400 |
| `ingest-validation.test.ts` | File > 50MB → 413 |
| `ingest-validation.test.ts` | >10 files → 400 |
| `file-type.test.ts` | MIME → file_type mapping (image/jpeg→image, application/pdf→document, etc.) |

### Integration Tests (`src/__tests__/integration/`)

Require: test DB + test storage dir (use `tmp/test-storage/`)

| Test | What |
|------|------|
| `ingest-happy.test.ts` | Message + 1 file → 201, attachment row exists, file on disk, link row exists |
| `ingest-dedupe.test.ts` | Same file uploaded twice → 1 attachment row, 2 link rows, 1 file on disk |
| `ingest-no-files.test.ts` | Message only (no attachments) → 201, message created, 0 attachments |
| `ingest-multi.test.ts` | Message + 3 files → ordinals 0,1,2 correct |
| `ingest-rollback.test.ts` | Simulate disk write failure → no orphan DB rows |
| `patch-attachment.test.ts` | PATCH labels/summary → SCD2: old row closed, new row active |
| `retrieval.test.ts` | GET message → attachments resolved in ordinal order via links |

### Running

```bash
npm install --save-dev vitest supertest @types/supertest
# Add to package.json: "test": "vitest run"
npm test
```

---

## 8) Go / No-Go Blockers

### Go ✅
- [x] Spec reviewed and approved (this doc)
- [x] Existing messages table has `record_id` (UUID) column (confirmed via SCD2 migration 003)
- [x] Migration runner exists (`src/migrate.ts`)
- [x] Auth middleware exists
- [x] Express app structure supports adding routes

### Blockers to Resolve Before Coding 🚫
| # | Blocker | Resolution | Owner |
|---|---------|-----------|-------|
| 1 | **`multer` not installed** | `npm i multer @types/multer` | Dev |
| 2 | **Storage directory doesn't exist** | Create `/memory/content/` or configure `ATTACHMENT_STORAGE_PATH` env var with fallback to `./storage/content/` | Dev |
| 3 | **No test framework installed** | `npm i -D vitest supertest @types/supertest` | Dev |
| 4 | **`pgvector` extension availability** | Confirm `CREATE EXTENSION vector` works on prod DB (needed for embedding column). If not available, make embedding column `TEXT` temporarily | ET |
| 5 | **Max file size decision** | Spec says nothing — recommend 50MB default via `INGEST_MAX_FILE_SIZE` env var | ET to confirm |
| 6 | **Disk storage path on deployed container** | Confirm persistent volume mount path for Dokploy deployment | ET |

### No blockers are hard blockers — all can be resolved in first 30 minutes of implementation.

**Recommendation: GO.** Start with steps 1–3 (deps + migration), then build ingest route.
