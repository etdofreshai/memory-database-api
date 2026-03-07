# Enrichment System — Memory Database API

## Overview

The enrichment system automatically enhances attachments with AI-generated metadata:
- **Gemini API** → Images, videos, audio, PDFs (OCR, summaries, object detection)
- **Claude SDK** → Text documents, code, detailed analysis

Features:
- ✅ Automatic queuing on ingest
- ✅ Rate limiting (60 req/min Gemini, 30 req/min Claude)
- ✅ Concurrent processing with backpressure
- ✅ Exponential backoff retry logic
- ✅ Dead letter queue for failed items
- ✅ Background processing (doesn't block requests)

## Environment Setup

```bash
# Required for vision/media enrichment
export GEMINI_API_KEY="your-gemini-api-key"

# Required for text/document enrichment
export CLAUDE_CODE_OAUTH_TOKEN="your-claude-oauth-token"
# OR
export claude_code_oauth_token="your-claude-oauth-token"
```

**Get API keys:**
- **Gemini:** https://ai.google.dev/gemini-2/docs/api-key
- **Claude OAuth:** https://console.anthropic.com/ → Workspaces → API Keys

## API Endpoints

### 1. Enrich Single Attachment
```bash
POST /api/enrichments/enrich-attachment/{record_id}
Authorization: Bearer <write-or-admin-token>

# Example
curl -X POST http://localhost:3000/api/enrichments/enrich-attachment/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your_token"

# Response
{
  "queued": true,
  "record_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Enrichment queued successfully"
}
```

### 2. Enrich All Unenriched Attachments
```bash
POST /api/enrichments/enrich-all?limit=100&file_type=image
Authorization: Bearer <admin-token>

# Response
{
  "total": 50,
  "queued": 48,
  "failed": 2,
  "errors": [
    {
      "record_id": "...",
      "error": "File not found on disk"
    }
  ]
}
```

**Query params:**
- `limit` (default: 100, max: 1000) — Max attachments to enrich
- `file_type` (optional) — Filter by type: `image`, `video`, `audio`, `document`, `file`

### 3. Get Queue Status
```bash
GET /api/enrichments/queue-status
Authorization: Bearer <read-or-admin-token>

# Response
{
  "pending": 5,
  "processing": {
    "gemini": 1,
    "claude": 0
  },
  "rateLimits": {
    "gemini": { "used": 23, "limit": 60 },
    "claude": { "used": 8, "limit": 30 }
  },
  "deadLetterCount": 2,
  "deadLetterQueue": [
    {
      "recordId": "...",
      "fileName": "doc.pdf",
      "lastError": "Gemini API error (429): Rate limit exceeded",
      "retries": 3
    }
  ]
}
```

### 4. Retry Failed Enrichments
```bash
POST /api/enrichments/retry-failed
Authorization: Bearer <admin-token>

# Response
{
  "retried": 2,
  "newQueueLength": 7,
  "message": "2 failed items moved back to queue"
}
```

## File Type Routing

| File Type | MIME Pattern | Primary Enricher | Result Fields |
|-----------|--------------|------------------|----------------|
| Image | image/* | Gemini Vision | summary, ocr_text, labels, objects |
| Video | video/* | Gemini Vision | summary, ocr_text, labels, scenes |
| Audio | audio/* | Gemini (speech-to-text capable) | summary, transcription |
| PDF | application/pdf | Gemini (OCR) | summary, ocr_text, labels |
| Text | text/* | Claude | summary, key_topics, labels |
| Document | .docx, .doc | Claude | summary, key_topics, labels |

**Current behavior:** All files route to Gemini. Claude routing can be enabled by modifying `selectEnrichmentType()` in `src/enrichments.ts`.

## Rate Limiting Strategy

Both APIs have per-minute rate limits that respect headers:

```
Gemini:
- Limit: 60 requests/minute
- Concurrency: 2 parallel jobs
- Backoff: Exponential (1s → 2s → 4s → 8s)

Claude:
- Limit: 30 requests/minute
- Concurrency: 1 parallel job
- Backoff: Exponential (1s → 2s → 4s → 8s)
```

The queue respects both limits:
- ✅ Checks rate limit before making API calls
- ✅ Resets counters every minute
- ✅ Pauses processing if limit reached
- ✅ Monitors X-RateLimit headers (optional)

**Tuning:**
Edit `src/enrichments.ts`:
```typescript
const RATE_LIMITS = {
  gemini: 60,    // req/min
  claude: 30,    // req/min
};

const CONCURRENCY = {
  gemini: 2,     // parallel jobs
  claude: 1,     // parallel jobs
};
```

## Retry & Dead Letter Queue

**Retry Logic:**
1. On failure, item retried automatically with exponential backoff
2. Max 3 retries (configurable via `MAX_RETRIES`)
3. After 3 failures, moved to dead letter queue
4. Dead letter items can be manually retried via `/retry-failed` endpoint

**Example flow:**
```
[1] Ingest attachment
    ↓
[2] Queue enrichment
    ↓
[3] Try Gemini → fails (429 rate limited)
    ↓
[4] Retry 1 after 1s → fails
    ↓
[5] Retry 2 after 2s → fails
    ↓
[6] Retry 3 after 4s → fails
    ↓
[7] Moved to dead letter queue
    ↓
[8] Check status: GET /api/enrichments/queue-status
    ↓
[9] Manually retry: POST /api/enrichments/retry-failed
```

## Auto-Enrichment on Ingest

When you POST to `/api/messages/ingest` with attachments, enrichment is automatically queued:

```bash
curl -X POST http://localhost:3000/api/messages/ingest \
  -F "message='{\"source\":\"imessage\",\"content\":\"Check this photo\"}'" \
  -F "files=@photo.jpg" \
  -H "Authorization: Bearer token"

# Attachment is stored AND enrichment is queued in background
```

## Monitoring & Debugging

**Check queue health:**
```bash
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer token"
```

**View logs:**
```bash
# Enrichment logs are written to stdout with [gemini] or [claude] prefixes
# Examples:
# [gemini] Starting enrichment for 550e8400-e29b-41d4-a716-446655440000 (photo.jpg)
# [gemini] Successfully enriched 550e8400-e29b-41d4-a716-446655440000 in 2340ms
# [gemini] Retry scheduled for 550e8400-e29b-41d4-a716-446655440000 (attempt 1/3) in 1000ms
# [claude] Skipping Claude enrichment for non-text file: audio.mp3
```

## Database Results

Enrichment results stored in `attachments` table:

```sql
SELECT record_id, summary_text, ocr_text, labels, summary_model, summary_updated_at
FROM attachments
WHERE summary_text IS NOT NULL
ORDER BY summary_updated_at DESC;
```

**Example enriched attachment:**
```json
{
  "record_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary_text": "A beautiful sunset over the ocean with vibrant orange and pink colors.",
  "ocr_text": "WELCOME TO BEACH RESORT",
  "labels": ["sunset", "ocean", "landscape", "nature"],
  "summary_model": "gemini-2.0-flash",
  "summary_updated_at": "2026-03-07T04:30:00Z"
}
```

## Troubleshooting

### All enrichments failing with "API_KEY not configured"
- Check env vars: `echo $GEMINI_API_KEY $CLAUDE_CODE_OAUTH_TOKEN`
- Restart the API: `npm start` or `docker-compose restart`

### Rate limit errors (429)
- Queue is working correctly — it auto-retries with backoff
- Check `/queue-status` to see if items are in dead letter queue
- Call `/retry-failed` to retry after rate limits reset (1 min)

### No enrichment happening
1. Check if auto-enrichment is queueing: POST `/enrich-all` directly
2. Check queue status: GET `/queue-status`
3. Verify API keys are set
4. Check logs for error messages

### Too slow / eating all API quota
- Reduce `CONCURRENCY.gemini` or `CONCURRENCY.claude`
- Reduce `RATE_LIMITS.gemini` or `RATE_LIMITS.claude`
- Only call `/enrich-all` during off-peak hours

## Future Improvements

1. **Claude Agent SDK** — Use `claudeSDK.execute()` for richer document analysis
2. **Streaming Responses** — Process long documents in chunks
3. **LLM Caching** — Cache Gemini responses for identical files (by SHA256)
4. **Webhook Notifications** — POST when enrichment completes
5. **Configurable Prompts** — Let users define summary format per file type
6. **Multi-language Support** — Detect and preserve language in summaries

## Implementation Details

**Files:**
- `src/enrichments.ts` — Core queue + API clients
- `src/routes/enrichments.ts` — HTTP endpoints
- `src/routes/ingest.ts` — Auto-trigger on POST /api/messages/ingest
- `src/app.ts` — Routes mounted at `/api/enrichments`

**Key functions:**
- `queueEnrichment()` — Queue an attachment
- `getQueueStatus()` — Inspect queue health
- `retryDeadLetters()` — Retry failed items
- `processQueue()` — Main processor (runs in background)
