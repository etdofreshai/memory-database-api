# memory-database-api

REST API for the OpenClaw memory database (messages, sources, people) with Bearer token auth and pgvector search.

> **Note:** The admin UI has been moved to a standalone repo: [openclaw-memory-db-manager](https://github.com/etdofreshai/openclaw-memory-db-manager)

## Quick Start

```bash
npm install --include=dev
cd admin && npm install --include=dev && npm run build && cd ..
npm run build
DATABASE_URL=postgresql://... npm start
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `PORT` — Server port (default 3000)
- `ADMIN_TOKEN` — Bootstrap admin token on first run

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/messages?source=&sender=&after=&before=&limit=&offset=` — List messages
- `GET /api/messages/search?q=&limit=&offset=` — Full-text search
- `GET /api/messages/vector-search` — pgvector similarity search
- `POST /api/messages` — Create message (write token)
- `POST /api/messages/ingest` — Ingest message + attachments (multipart, write token)
- `GET /api/sources` — List sources
- `GET /api/people` — List people
- `GET/POST/PATCH/DELETE /api/admin/tokens` — Token management (admin)
- `GET /api/messages/:record_id/attachments` — Linked attachments for a message
- `GET /api/attachments?q=&mime_type=&file_type=&privacy_level=&sha256=&record_id=&page=&limit=` — List/filter attachments
- `GET /api/attachments/:record_id` — Single attachment + linked messages
- `GET /api/attachments/:record_id/file` — Serve attachment file content (supports `?token=` query param for media elements)
- `GET /api/links?message_record_id=&attachment_record_id=&provider=&role=&q=&page=&limit=` — List/filter message-attachment links
- `/admin` — Admin dashboard
- `/admin/viewer` — Data viewer (messages, attachments, links)

## Ingest Endpoint (Attachments V1)

`POST /api/messages/ingest` accepts multipart/form-data with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | JSON string | Yes | Message object (`source`, `content`, `sender`, etc.) |
| `files` | File(s) | No | Up to 10 binary attachments (max 1GB each) |
| `attachments_meta` | JSON string | No | Per-file metadata array (matched by index) |

```bash
curl -X POST http://localhost:3000/api/messages/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -F 'message={"source":"telegram","sender":"ET","content":"Check this","timestamp":"2026-03-06T14:30:00Z"}' \
  -F 'attachments_meta=[{"original_file_name":"photo.jpg","role":"original"}]' \
  -F 'files=@photo.jpg'
```

Files are SHA-256 deduplicated and stored at `/memory/attachments/<record_id>.<ext>`.

**Env vars:** `ATTACHMENT_STORAGE_PATH` (default `/memory/attachments`), `INGEST_MAX_FILE_SIZE` (default 1GB).

## Admin Viewer

The `/admin/viewer` page provides a tabbed interface for inspecting all three core tables:

- **Messages** — searchable list with filters for source, sender/recipient, date range, and has-attachments. Click a row to see full details and linked attachments.
- **Attachments** — searchable by filename/summary/OCR, filterable by MIME type, file type, privacy level, SHA256 hash, and record ID. Click to see linked messages.
- **Links** — browse message↔attachment links, filter by message/attachment record ID and provider. Click for full detail with cross-references.

All tabs support pagination and click-to-detail modals with raw JSON inspection.

### Attachment Preview

Clicking an attachment filename in any table or detail modal opens an inline preview modal with type-appropriate rendering:

- **Images** (jpg, png, gif, webp, etc.) — `<img>` preview
- **Video** (mp4, webm, mov, etc.) — `<video>` with controls
- **Audio** (mp3, m4a, wav, amr, etc.) — `<audio>` with controls
- **PDF** — `<iframe>` embed
- **Other types** — download/open-in-new-tab fallback

Files are served via `/api/attachments/:record_id/file` which reads from `storage_path`/`url_local` on disk. Authentication is passed via `?token=` query parameter (required for `<img>`/`<video>`/`<audio>` src attributes that can't send Authorization headers). Missing or unreachable files show an error state with an "open in new tab" fallback link.

## Migrations

```bash
npm run migrate  # Run manually when ready
```
