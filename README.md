# memory-database-api

REST API for the OpenClaw memory database (messages, sources, people) with Bearer token auth, pgvector search, and a React admin dashboard.

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
- `/admin` — Admin dashboard

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

Files are SHA-256 deduplicated and stored at `/memory/content/<record_id>.<ext>`.

**Env vars:** `ATTACHMENT_STORAGE_PATH` (default `/memory/content`), `INGEST_MAX_FILE_SIZE` (default 1GB).

## Migrations

```bash
npm run migrate  # Run manually when ready
```
