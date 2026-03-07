# Enrichment System Examples

## Quick Start

### 1. Automatic Enrichment on Ingest

When you upload attachments via the ingest endpoint, enrichment is automatically queued:

```bash
# Ingest a message with an image
curl -X POST http://localhost:3000/api/messages/ingest \
  -H "Authorization: Bearer your-token" \
  -F 'message={"source":"telegram","sender":"user@example.com","content":"Check this out"}' \
  -F 'files=@photo.jpg'

# Response:
{
  "message": { "id": 1, "record_id": "550e8400-...", "source": "telegram", ... },
  "attachments": [
    {
      "record_id": "550e8400-e29b-41d4-a716-446655440000",
      "sha256": "abc123...",
      "deduplicated": false,
      "storage_path": "/memory/attachments/550e8400-e29b-41d4-a716-446655440000.jpg",
      "link_id": 42
    }
  ]
}

# Enrichment automatically starts in the background!
# Check status with:
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token"
```

### 2. Check Enrichment Progress

```bash
# Monitor queue status
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token"

# Response:
{
  "pending": 5,
  "processing": {
    "zai": 1,
    "claude": 0
  },
  "rateLimits": {
    "zai": {
      "used": 45,
      "limit": 60
    },
    "claude": {
      "used": 12,
      "limit": 30
    }
  },
  "deadLetterCount": 0,
  "deadLetterQueue": []
}
```

### 3. Manually Trigger Enrichment

```bash
# Enrich a specific attachment that was missed
curl -X POST http://localhost:3000/api/enrichments/enrich-attachment/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your-token"

# Response:
{
  "queued": true,
  "record_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Enrichment queued successfully"
}
```

### 4. Batch Enrich All Unenriched Files

```bash
# Enrich all images that don't have summaries yet
curl -X POST "http://localhost:3000/api/enrichments/enrich-all?limit=100&file_type=image" \
  -H "Authorization: Bearer your-token"

# Response:
{
  "total": 87,
  "queued": 87,
  "failed": 0
}

# Monitor progress
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token" | jq '.pending'
```

### 5. Handle Failed Items

```bash
# Check what failed
curl http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token" | jq '.deadLetterQueue'

# Output:
[
  {
    "recordId": "550e8400-...",
    "fileName": "corrupted.jpg",
    "lastError": "Z.AI API error (400): Invalid image format",
    "retries": 3
  }
]

# After fixing the issue (e.g., updating API key), retry
curl -X POST http://localhost:3000/api/enrichments/retry-failed \
  -H "Authorization: Bearer your-token"

# Response:
{
  "retried": 1,
  "newQueueLength": 6,
  "message": "1 failed items moved back to queue"
}
```

### 6. Query Enriched Attachments

```bash
# Get attachment with enrichment results
curl "http://localhost:3000/api/attachments/550e8400-e29b-41d4-a716-446655440000" \
  -H "Authorization: Bearer your-token"

# Response:
{
  "attachment": {
    "id": 1,
    "record_id": "550e8400-e29b-41d4-a716-446655440000",
    "original_file_name": "photo.jpg",
    "mime_type": "image/jpeg",
    "file_type": "image",
    "size_bytes": 245000,
    "summary_text": "A sunny outdoor photo showing a person standing in front of mountains with blue sky. Shot during daytime.",
    "summary_model": "zai-2.0-flash",
    "summary_updated_at": "2024-03-07T04:32:15Z",
    "ocr_text": "Some visible text from the image if any...",
    "labels": [
      "outdoor",
      "landscape",
      "person",
      "mountains",
      "nature",
      "daytime"
    ],
    "metadata": {
      "dominant_colors": ["blue", "green", "brown"],
      "detected_objects": ["person", "mountain", "sky", "grass"],
      "orientation": "landscape",
      "enrichment_metadata": {
        "processed_at": "2024-03-07T04:32:15Z",
        "confidence_scores": {
          "person_detection": 0.95,
          "scene_understanding": 0.87
        }
      }
    },
    "storage_path": "/memory/attachments/550e8400-e29b-41d4-a716-446655440000.jpg",
    "imported_at": "2024-03-07T04:27:30Z"
  },
  "linked_messages": [
    {
      "message_record_id": "550e8400-e29b-41d4-a716-446655440001",
      "sender": "user@example.com",
      "content": "Check out this amazing view!",
      "timestamp": "2024-03-07T04:27:30Z",
      "source_name": "telegram"
    }
  ]
}
```

### 7. Search Enriched Content

```bash
# Find attachments by their OCR text
curl "http://localhost:3000/api/attachments/?q=mountain" \
  -H "Authorization: Bearer your-token"

# Response includes attachments where:
# - original_file_name contains "mountain"
# - summary_text contains "mountain"
# - ocr_text contains "mountain"
# Results are paginated (50 per page by default)
```

## Advanced Usage

### Batch Enrichment During Off-Peak Hours

```bash
# Script to enrich in batches with backoff
#!/bin/bash
API_URL="http://localhost:3000"
TOKEN="your-token"

for i in {1..10}; do
  echo "Batch $i: Starting enrichment of 100 images..."
  curl -X POST "$API_URL/api/enrichments/enrich-all?limit=100&file_type=image" \
    -H "Authorization: Bearer $TOKEN"
  
  # Wait for this batch to complete
  while true; do
    PENDING=$(curl -s "$API_URL/api/enrichments/queue-status" \
      -H "Authorization: Bearer $TOKEN" | jq '.pending')
    if [ "$PENDING" -lt 10 ]; then
      echo "Batch $i: Queue cleared, moving to next batch"
      break
    fi
    echo "Pending: $PENDING, waiting..."
    sleep 30
  done
done
```

### Monitor Enrichment with Metrics

```bash
#!/bin/bash
# Watch enrichment progress in real-time
watch -n 5 'curl -s http://localhost:3000/api/enrichments/queue-status \
  -H "Authorization: Bearer your-token" | jq "{pending, processing, rateLimits}"'

# Output updates every 5 seconds:
{
  "pending": 12,
  "processing": {
    "zai": 2,
    "claude": 0
  },
  "rateLimits": {
    "zai": {
      "used": 50,
      "limit": 60
    },
    "claude": {
      "used": 20,
      "limit": 30
    }
  }
}
```

### Configure Different Rate Limits

Edit `src/enrichments.ts` to customize for your API quotas:

```typescript
// For high-volume processing:
const RATE_LIMITS = {
  zai: 120,  // increased from 60
  claude: 60,   // increased from 30
};

const CONCURRENCY = {
  zai: 4,    // increased from 2
  claude: 2,    // increased from 1
};

// For conservative/free-tier accounts:
const RATE_LIMITS = {
  zai: 15,   // reduced from 60
  claude: 5,    // reduced from 30
};

const CONCURRENCY = {
  zai: 1,    // reduced from 2
  claude: 1,    // keep at 1
};
```

Then rebuild:
```bash
npm run build
npm start
```

### Handle Large Files

Large files (videos, high-res images) can be slow:

```bash
# Monitor a large video enrichment
curl http://localhost:3000/api/enrichments/queue-status -H "Authorization: Bearer token" | jq '.processing'

# Output shows it's being processed:
{
  "zai": 1,  # Currently processing
  "claude": 0
}

# The system will retry if it times out (up to 3 times)
# Check dead letter queue if it ultimately fails
```

## API Reference

### GET /api/enrichments/queue-status
Get current queue and rate limit status.

**Auth**: read, write, or admin

**Response**: Queue status object with pending count, processing workers, rate limits, and dead letter queue.

---

### POST /api/enrichments/enrich-attachment/:record_id
Manually queue enrichment for a specific attachment.

**Auth**: write or admin

**Parameters**:
- `record_id` (path): UUID of the attachment

**Response**: `{ queued: true, record_id, message }`

---

### POST /api/enrichments/enrich-all
Batch queue enrichment for multiple unenriched attachments.

**Auth**: admin (requires higher privilege)

**Query Parameters**:
- `limit` (optional): Number of attachments to queue (default: 100, max: 1000)
- `file_type` (optional): Filter by type (image, video, audio, document)

**Response**:
```json
{
  "total": 87,
  "queued": 85,
  "failed": 2,
  "errors": [
    { "record_id": "...", "error": "File not found on disk" }
  ]
}
```

---

### POST /api/enrichments/retry-failed
Retry all failed items from the dead letter queue.

**Auth**: admin

**Response**:
```json
{
  "retried": 3,
  "newQueueLength": 15,
  "message": "3 failed items moved back to queue"
}
```

---

## Troubleshooting

### "Enrichment queued but no progress"

1. Verify API keys are set:
   ```bash
   echo $ZAI_TOKEN
   echo $CLAUDE_CODE_OAUTH_TOKEN
   ```

2. Check logs:
   ```bash
   docker logs memory-database-api | grep Enrichments
   ```

3. Verify rate limits haven't been exceeded:
   ```bash
   curl http://localhost:3000/api/enrichments/queue-status | jq '.rateLimits'
   ```

### "Items in dead letter queue"

1. Identify the error:
   ```bash
   curl http://localhost:3000/api/enrichments/queue-status | jq '.deadLetterQueue'
   ```

2. Fix the issue:
   - Update API keys if auth failed
   - Check file formats if format error
   - Increase timeout if processing timeout

3. Retry:
   ```bash
   curl -X POST http://localhost:3000/api/enrichments/retry-failed
   ```

### "Rate limit errors"

If you see many 429 (rate limit) errors:

1. Reduce concurrency in `src/enrichments.ts`:
   ```typescript
   const CONCURRENCY = { zai: 1, claude: 1 };
   ```

2. Reduce rate limits:
   ```typescript
   const RATE_LIMITS = { zai: 30, claude: 15 };
   ```

3. Rebuild and restart

---

For full documentation, see [ENRICHMENTS.md](./ENRICHMENTS.md)
