# Attachments V1 Spec (Draft — Renamed + Link Table Restored)

Status: Draft for review (no implementation yet)  
Owner: ET + OpenClaw  
Scope: `memory-database-api`

## 1) Goal

Use clear naming and normalized linkage:
- Rename canonical file/content entity to **attachments**
- Restore intermediate link table between messages and attachments
- Keep SCD Type 2 versioning on attachments
- Keep strict SHA-256 dedupe

---

## 2) Data Model

## 2.1 `attachments` (canonical file object)
This is the core attachment entity (previously called content).

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),

  -- dedupe identity
  sha256 TEXT NOT NULL,
  size_bytes BIGINT,
  mime_type TEXT,
  file_type TEXT, -- image|video|audio|document|file
  original_file_name TEXT,
  created_at_source TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- storage pointers
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_path TEXT,
  url_local TEXT,
  url_fallback_1 TEXT,
  url_fallback_2 TEXT,
  url_fallback_3 TEXT,

  -- privacy (advisory in V1)
  privacy_level TEXT NOT NULL DEFAULT 'private_consent'
    CHECK (privacy_level IN ('public', 'private_consent', 'private_double_consent')),

  -- enrichment
  summary_text TEXT,
  summary_model TEXT,
  summary_updated_at TIMESTAMPTZ,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  faces JSONB NOT NULL DEFAULT '[]'::jsonb,
  ocr_text TEXT,
  user_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- embeddings
  embedding_input TEXT,
  embedding VECTOR(1536),
  embedding_model TEXT,
  embedding_updated_at TIMESTAMPTZ,

  -- SCD2
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(record_id, effective_from)
);
```

Current view:
```sql
CREATE OR REPLACE VIEW current_attachments AS
SELECT *
FROM attachments
WHERE effective_to IS NULL
  AND is_active = TRUE;
```

Indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_attachments_current
  ON attachments(record_id)
  WHERE effective_to IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_privacy ON attachments(privacy_level);
CREATE INDEX IF NOT EXISTS idx_attachments_metadata_gin ON attachments USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_attachments_labels_gin ON attachments USING GIN (labels);
```

---

## 2.2 `message_attachment_links` (intermediate link table)
Normalized many-to-many linkage between messages and attachments.

```sql
CREATE TABLE IF NOT EXISTS message_attachment_links (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),

  message_record_id UUID NOT NULL,
  attachment_record_id UUID NOT NULL,

  ordinal INTEGER, -- preserve attachment order in message
  role TEXT,       -- original|preview|thumbnail|other

  provider TEXT,
  provider_message_id TEXT,
  provider_attachment_id TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- SCD2 (optional but kept for consistency)
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(record_id, effective_from)
);
```

Current view:
```sql
CREATE OR REPLACE VIEW current_message_attachment_links AS
SELECT *
FROM message_attachment_links
WHERE effective_to IS NULL
  AND is_active = TRUE;
```

Indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_mal_message_record_id ON message_attachment_links(message_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_attachment_record_id ON message_attachment_links(attachment_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_provider_attachment_id ON message_attachment_links(provider_attachment_id);
```

---

## 3) Versioning Rules

### 3.1 Attachments (canonical object)
API manages SCD2 transitions:
1. close current row
2. insert new row with same `record_id`

### 3.2 Link table
For V1, links are usually append-only on ingest. If link metadata changes, API can SCD2-version the link row.

---

## 4) Dedupe Rules

V1 dedupe is strict byte-level hash dedupe:
1. Compute `sha256`
2. Search `current_attachments` for same hash
3. Reuse `attachment_record_id` if found
4. Otherwise create new attachment row

No fuzzy/perceptual dedupe in V1.

---

## 5) Ingestion Order (Message with Attachments)

1. Receive message + attachment bytes
2. Compute SHA-256
3. Lookup/create attachment in `attachments`
4. If new attachment only, write file to `/memory/content/<attachment_record_id>.<ext>`
5. Create message row (existing message flow)
6. Create one `message_attachment_links` row per linked attachment

Notes:
- If hash exists, do not duplicate file write.
- `created_at_source` uses platform timestamp; fallback to `imported_at` when unavailable.
- Invalid linked attachment IDs should surface explicit warning in UI.

---

## 6) Retrieval Rules

For a message:
1. Query `current_message_attachment_links` by `message_record_id` ordered by `ordinal`
2. Resolve each `attachment_record_id` from `current_attachments`
3. Fetch local path first, then fallbacks

---

## 7) Privacy Semantics

`privacy_level`:
- `public`
- `private_consent`
- `private_double_consent`

V1 behavior: advisory metadata (not hard-enforced gate yet).

---

## 8) API Shape (Draft)

### Primary ingestion endpoint (recommended)
- `POST /api/messages/ingest` (single endpoint)
  - accepts message text/metadata + raw attachment upload(s)
  - API internally orchestrates all steps:
    1) create/update message
    2) hash uploaded files
    3) dedupe against current attachments
    4) store file bytes if new
    5) create/reuse attachment records
    6) create message-attachment links

This is the default path and should handle almost all usage.

### Internal/support endpoints (optional)
- `PATCH /api/attachments/:recordId`
  - SCD2 update for summary/labels/notes/privacy
- Admin/debug endpoints can exist for direct attachment/link operations, but callers should not need them for normal ingest.

Operational notes:
- Bulk ingest/backfill allowed with throttling/rate limiting.
- Keep data/history; avoid hard deletes in V1.

---

## 9) Why this model

This keeps naming clear (`attachments`), removes JSON attachment lists from messages, preserves normalized relationships, and still supports dedupe + history-safe updates.
