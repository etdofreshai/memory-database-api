# Attachment Enrichment System

## Overview

The enrichment system provides asynchronous, queued processing of attachment files to extract:
- **Text content** via OCR
- **Summaries** of visual and document content
- **Labels/tags** automatically extracted
- **Metadata** including detected objects, people, timestamps, etc.

## Architecture

### Components

1. **Enrichment Queue** (`src/enrichments.ts`)
   - FIFO queue with per-API concurrency limits
   - Rate limiting to prevent API throttling
   - Exponential backoff retry logic
   - Dead letter queue for persistent failures

2. **API Integrations**
   - **Z.AI GLM API**: Images, videos, audio, PDFs
   - **Claude API**: Text analysis for documents
   - Future: Whisper API for audio transcription

3. **Routes** (`src/routes/enrichments.ts`)
   - Manual enrichment triggering
   - Queue status monitoring
   - Batch enrichment operations
   - Dead letter queue management

## Configuration

### Environment Variables

```bash
# Required for Z.AI enrichment
ZAI_TOKEN=<your-zai-api-key>

# Required for Claude enrichment
CLAUDE_CODE_OAUTH_TOKEN=<your-claude-token>
# or
claude_code_oauth_token=<your-claude-token>
```

### Rate Limits (configurable in `src/enrichments.ts`)

```typescript
const RATE_LIMITS = {
  zai: 60,  // requests per minute
  claude: 30,  // requests per minute
};
```

### Concurrency (configurable in `src/enrichments.ts`)

```typescript
const CONCURRENCY = {
  zai: 2,   // parallel requests
  claude: 1,   // parallel requests
};
```

### Retry Configuration

```typescript
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;  // Exponential: 1s → 2s → 4s
```

## Usage

### Automatic Enrichment (During Ingest)

When files are uploaded via the ingest endpoint, they're automatically queued for enrichment:

```bash
POST /api/messages/ingest
Content-Type: multipart/form-data

message: {
  "source": "telegram",
  "sender": "user@example.com",
  "content": "Check out this image",
  "timestamp": "2024-03-07T04:27:00Z"
}
files: [image.jpg, document.pdf]
```

Enrichment happens asynchronously in the background.

### Manual Enrichment

#### Enrich Single Attachment

```bash
POST /api/enrichments/enrich-attachment/:record_id
Authorization: Bearer <admin-token>
```

Example:
```bash
curl -X POST http://localhost:3000/api/enrichments/enrich-attachment/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "queued": true,
  "record_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Enrichment queued successfully"
}
```

#### Batch Enrich All Unenriched Attachments

```bash
POST /api/enrichments/enrich-all
Authorization: Bearer <admin-token>
```

Query parameters:
- `limit` (default: 100, max: 1000) - Number of attachments to queue
- `file_type` (optional) - Filter by type: `image`, `video`, `audio`, `document`

Example:
```bash
curl -X POST "http://localhost:3000/api/enrichments/enrich-all?limit=50&file_type=image" \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "total": 45,
  "queued": 45,
  "failed": 0
}
```

### Queue Management

#### Get Queue Status

```bash
GET /api/enrichments/queue-status
Authorization: Bearer <read-token>
```

Response:
```json
{
  "pending": 12,
  "processing": {
    "zai": 2,
    "claude": 0
  },
  "rateLimits": {
    "zai": {
      "used": 45,
      "limit": 60
    },
    "claude": {
      "used": 15,
      "limit": 30
    }
  },
  "deadLetterCount": 3,
  "deadLetterQueue": [
    {
      "recordId": "550e8400-e29b-41d4-a716-446655440000",
      "fileName": "problematic_image.jpg",
      "lastError": "Z.AI API error (400): Invalid image format",
      "retries": 3
    }
  ]
}
```

#### Retry Failed Items

```bash
POST /api/enrichments/retry-failed
Authorization: Bearer <admin-token>
```

Response:
```json
{
  "retried": 3,
  "newQueueLength": 15,
  "message": "3 failed items moved back to queue"
}
```

## Enrichment Results

Enriched attachments get the following fields populated:

### `summary_text`
- 2-3 sentence summary of the attachment content
- Populated by Z.AI for media, Claude for documents

### `ocr_text`
- All visible text extracted from images/documents
- Up to 10,000 characters stored
- Useful for searchability and accessibility

### `labels`
- JSON array of auto-detected tags
- Examples: `["photo", "outdoor", "person", "landscape"]`
- Mergeable with existing user labels

### `metadata`
- JSON object with enrichment details
- Includes timestamps, detected objects, confidence scores
- Structure varies by file type and AI model used

### `summary_model`
- Records which model performed the enrichment
- Values: `zai-2.0-flash`, `claude-3-5-sonnet`, etc.

### `summary_updated_at`
- ISO 8601 timestamp when enrichment completed

## File Type Handling

| File Type | Handled By | Enrichment Type |
|-----------|-----------|-----------------|
| Image (JPEG, PNG, GIF, WebP) | Z.AI | OCR, objects, summary |
| Video (MP4, WebM, MOV) | Z.AI | First frame analysis, summary |
| Audio (MP3, OGG, WAV, M4A) | Z.AI | Metadata extraction |
| PDF | Z.AI + Claude | OCR, full-text search |
| Documents (TXT, DOC, DOCX) | Claude | Text analysis, summary |

## Monitoring & Logging

The system logs to stdout:

```
[Enrichments] System initialized: { zaiAvailable: true, claudeAvailable: true, ... }
[zai] Starting enrichment for 550e8400-e29b-41d4-a716-446655440000 (photo.jpg)
[zai] Successfully enriched 550e8400-e29b-41d4-a716-446655440000 in 2345ms
[claude] Retry scheduled for 550e8400-e29b-41d4-a716-446655440001 (attempt 1/3) in 1000ms
[zai] Failed to enrich 550e8400-e29b-41d4-a716-446655440002 after 3 retries: Invalid API key
```

### Key Metrics to Monitor

1. **Queue Length**: `GET /api/enrichments/queue-status` → `pending`
2. **Rate Limit Usage**: Check `rateLimits.zai.used` vs `limit`
3. **Dead Letters**: Items stuck after max retries
4. **Processing Time**: Log duration indicates API speed

## Error Handling

### Automatic Retry (with backoff)
- Network timeouts
- API rate limits (429)
- Temporary server errors (5xx)
- Retry count: 3
- Backoff: 1s → 2s → 4s

### Moved to Dead Letter Queue
- API authentication failures
- Invalid file formats
- File too large or corrupt
- After 3 retries exhausted

### Manual Recovery

```bash
# Check what failed
curl http://localhost:3000/api/enrichments/queue-status

# Fix the issue (e.g., update ZAI_TOKEN), then:
curl -X POST http://localhost:3000/api/enrichments/retry-failed
```

## Performance Considerations

### Queue Limits
- **Default concurrency**: 2 Z.AI workers, 1 Claude worker
- **Rate limits**: 60/min Z.AI, 30/min Claude
- **Queue depth**: No hard limit, but monitor for backlog

### Optimization Tips

1. **Batch processing**: Use `POST /api/enrichments/enrich-all?limit=500` for large imports
2. **Selective enrichment**: Only enrich important file types (e.g., `?file_type=image`)
3. **Off-peak scheduling**: Run batch enrichment during low-traffic hours
4. **Monitor dead letters**: Investigate and retry failed items daily

### Cost Estimates

Assuming Z.AI and Claude pricing:
- **1000 attachments/month**:
  - Z.AI: ~$5-10/month
  - Claude: ~$5-10/month
  - Total: ~$10-20/month

Adjust concurrency and rate limits based on your API quotas.

## Integration with Message Search

Enriched text is automatically indexed in PostgreSQL full-text search:

```sql
-- Search across message content AND attachment summaries/OCR
SELECT m.*, a.summary_text, a.ocr_text
FROM current_messages m
LEFT JOIN current_message_attachment_links mal ON m.record_id = mal.message_record_id
LEFT JOIN current_attachments a ON a.record_id = mal.attachment_record_id
WHERE a.ocr_text ILIKE '%search_term%'
   OR a.summary_text ILIKE '%search_term%'
ORDER BY m.timestamp DESC;
```

## Future Enhancements

1. **Whisper API integration** for audio transcription
2. **Multi-language support** for OCR
3. **Face recognition** for privacy-aware photo cataloging
4. **Custom enrichment hooks** for domain-specific processing
5. **Webhook notifications** when enrichment completes
6. **Streaming API** for real-time enrichment status
7. **Caching** of enrichment results to reduce redundant processing
8. **Parallel processing** across multiple machines

## Troubleshooting

### Enrichments Not Starting

Check logs:
```bash
tail -f /var/log/memory-database-api.log | grep "Enrichments"
```

Verify env vars:
```bash
echo $ZAI_TOKEN
echo $CLAUDE_CODE_OAUTH_TOKEN
```

### Queue Stuck with Pending Items

1. Check queue status:
   ```bash
   curl http://localhost:3000/api/enrichments/queue-status
   ```

2. If rate limit hit, wait 60 seconds for reset

3. If API errors, check credentials and retry:
   ```bash
   curl -X POST http://localhost:3000/api/enrichments/retry-failed
   ```

### API Key Errors

- **Z.AI**: Verify key at [Google AI Studio](https://aistudio.google.com/app/apikey)
- **Claude**: Check token at [Anthropic Dashboard](https://console.anthropic.com)

### Memory Usage Growing

If the queue grows unbounded:
1. Reduce `CONCURRENCY` limits
2. Lower `RATE_LIMITS` to add backpressure
3. Monitor file sizes — very large files take longer to process
4. Implement cleanup of old dead letter items

---

For API reference, see [API Documentation](./API.md)
