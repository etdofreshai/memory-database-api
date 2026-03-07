# Enrichment System - Quick Start Guide

## Installation

The enrichment system is already integrated! Just set environment variables and restart:

```bash
export Z_AI_TOKEN=your-zai-key
export CLAUDE_CODE_OAUTH_TOKEN=your-claude-token
npm start
```

## 3-Minute Tutorial

### 1. Check System Status

```bash
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token"
```

Shows: pending items, rate limits, dead letters.

### 2. Upload a File (Auto-Enrichment)

```bash
curl -X POST http://localhost:3000/api/messages/ingest \
  -H "Authorization: Bearer your-token" \
  -F 'message={"source":"telegram","sender":"test@example.com","content":"Photo"}' \
  -F 'files=@photo.jpg'
```

File is automatically queued for enrichment! Check status in 5-10 seconds.

### 3. View Enriched Results

```bash
curl "http://localhost:3000/api/attachments/[record_id]" \
  -H "Authorization: Bearer your-token" | jq '.attachment | {summary_text, labels, ocr_text}'
```

Output:
```json
{
  "summary_text": "A scenic mountain landscape with clear blue sky...",
  "labels": ["landscape", "mountains", "nature", "outdoor"],
  "ocr_text": "Summit elevation: 12,345 ft"
}
```

## Common Commands

```bash
# Get queue status
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer token"

# Enrich single attachment
curl -X POST http://localhost:3000/api/enrichments/enrich-attachment/[uuid] \
  -H "Authorization: Bearer token"

# Batch enrich 50 images
curl -X POST "http://localhost:3000/api/enrichments/enrich-all?limit=50&file_type=image" \
  -H "Authorization: Bearer token"

# Check failed items
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer token" | jq '.deadLetterQueue'

# Retry failed items
curl -X POST http://localhost:3000/api/enrichments/retry-failed \
  -H "Authorization: Bearer token"
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `pending` stays high | Increase `CONCURRENCY` in `src/enrichments.ts` |
| Items in dead letter | Check logs for API errors, update keys, retry |
| "API key missing" | Set `Z_AI_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` |
| Rate limit errors | Reduce `RATE_LIMITS` values in `src/enrichments.ts` |

## File Locations

```
docs/
  ├── ENRICHMENTS.md              ← Full API documentation
  ├── ENRICHMENT_EXAMPLES.md      ← Usage examples
src/
  ├── enrichments.ts              ← Core queue system
  └── routes/enrichments.ts       ← HTTP endpoints
ENRICHMENT_IMPLEMENTATION.md       ← Architecture guide
ENRICHMENT_QUICK_START.md         ← This file
```

## What Gets Enriched?

| Type | Handler | Results |
|------|---------|---------|
| Images (JPG, PNG) | Z.AI | summary, OCR, labels, objects |
| Videos (MP4, MOV) | Z.AI | summary, metadata |
| Audio (MP3, WAV) | Z.AI | metadata, summary |
| PDFs | Z.AI+Claude | OCR, summary, text |
| Documents (TXT) | Claude | summary, analysis |

## API Endpoints

```
GET  /api/enrichments/queue-status
POST /api/enrichments/enrich-attachment/:id
POST /api/enrichments/enrich-all
POST /api/enrichments/retry-failed
```

Auth: Use existing tokens (read/write/admin)

## Configuration

Edit `src/enrichments.ts` to adjust:

```typescript
// Requests per minute
const RATE_LIMITS = {
  zai: 60,   // ← increase for faster processing
  claude: 30,
};

// Parallel workers
const CONCURRENCY = {
  zai: 2,    // ← increase for more throughput
  claude: 1,
};
```

Then rebuild: `npm run build && npm start`

## Logs

See enrichment activity:

```bash
# Tail logs (Docker)
docker logs -f memory-database-api | grep Enrichments

# Or from stdout (local dev)
npm start 2>&1 | grep Enrichments
```

Sample output:
```
[Enrichments] System initialized: { zaiAvailable: true, claudeAvailable: true }
[zai] Starting enrichment for 550e8400-... (photo.jpg)
[zai] Successfully enriched 550e8400-... in 2345ms
```

## Next Steps

- Read full docs: [`docs/ENRICHMENTS.md`](docs/ENRICHMENTS.md)
- See examples: [`docs/ENRICHMENT_EXAMPLES.md`](docs/ENRICHMENT_EXAMPLES.md)
- Understand architecture: [`ENRICHMENT_IMPLEMENTATION.md`](ENRICHMENT_IMPLEMENTATION.md)

## Questions?

The system is fully documented. Check:
1. Logs for errors: `docker logs memory-database-api | grep Error`
2. Queue status: `GET /api/enrichments/queue-status`
3. Dead letters: `queue-status | jq '.deadLetterQueue'`
4. API docs: `docs/ENRICHMENTS.md`

Good to go! 🚀
