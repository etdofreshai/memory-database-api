# Enrichment System Architecture

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    FILE INGEST ENDPOINT                         │
│              POST /api/messages/ingest                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │ Store Message  │
                    │ & Attachment   │
                    └────────┬───────┘
                             │
                    ┌────────▼───────────────────┐
                    │ Queue Enrichment (Async)  │
                    │ - Non-blocking            │
                    │ - Return 201 immediately  │
                    └────────┬───────────────────┘
                             │
                ┌────────────┴────────────┐
                │                        │
                ▼                        ▼
        ┌──────────────────┐    ┌──────────────────┐
        │  Gemini Queue    │    │  Claude Queue    │
        │  (Images, Video, │    │  (Text, Docs)    │
        │   Audio, PDF)    │    │                  │
        └────────┬─────────┘    └────────┬─────────┘
                 │                       │
      ┌──────────┼──────────┐   ┌────────┼────────┐
      │          │          │   │        │        │
      ▼          ▼          ▼   ▼        ▼        ▼
    Worker1  Worker2  (Queue)  Worker (Queue)
      │          │              │
      └──────────┴──────────────┴─────────┐
                                         │
                            ┌────────────▼──────────┐
                            │  API Request with    │
                            │  Exponential Backoff │
                            │  (1s → 2s → 4s)     │
                            └────────────┬─────────┘
                                        │
                        ┌───────────────┼───────────────┐
                        │               │               │
                   ┌────▼──┐      ┌────▼──┐      ┌────▼──┐
                   │Success│      │Retry? │      │Fail?  │
                   └────┬──┘      └────┬──┘      └────┬──┘
                        │              │              │
                        ▼              ▼              ▼
                  ┌──────────────┐ ┌─────────┐ ┌───────────────┐
                  │ Store Results│ │Backoff  │ │ Dead Letter   │
                  │ - summary    │ │Wait     │ │ Queue         │
                  │ - ocr_text   │ │Retry    │ │ (Max retries  │
                  │ - labels     │ └─────────┘ │  exceeded)    │
                  │ - metadata   │             └───────────────┘
                  └──────────────┘
                        │
                        ▼
                  ┌──────────────┐
                  │ Attachment   │
                  │ Updated in   │
                  │ Database     │
                  └──────────────┘
                        │
                        ▼
            ┌───────────────────────────┐
            │  Available for Search     │
            │  - Full-text on ocr_text │
            │  - Filter by labels      │
            │  - Query via summary     │
            └───────────────────────────┘
```

## Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    EXPRESS APP                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Routes                           Middleware               │
│  ┌──────────────┐   ┌─────────────────────────────────┐  │
│  │ /ingest      │──▶│ requireAuth (read/write/admin) │  │
│  │ /enrichments │   └─────────────────────────────────┘  │
│  │ /attachments │                                         │
│  └──────────────┘                                         │
│        │                                                  │
│        ▼                                                  │
│  ┌────────────────────────────────────┐                  │
│  │    Enrichments Module              │                  │
│  │  (src/enrichments.ts)              │                  │
│  │                                    │                  │
│  │  ┌─────────────────────────────┐   │                  │
│  │  │ Queue Management            │   │                  │
│  │  │ ┌───────────────────────┐   │   │                  │
│  │  │ │ Main Queue (FIFO)     │   │   │                  │
│  │  │ │ - Gemini items        │   │   │                  │
│  │  │ │ - Claude items        │   │   │                  │
│  │  │ └───────────────────────┘   │   │                  │
│  │  │ ┌───────────────────────┐   │   │                  │
│  │  │ │ Dead Letter Queue      │   │   │                  │
│  │  │ │ - Failed after 3x      │   │   │                  │
│  │  │ └───────────────────────┘   │   │                  │
│  │  └─────────────────────────────┘   │                  │
│  │                                    │                  │
│  │  ┌─────────────────────────────┐   │                  │
│  │  │ Rate Limiting               │   │                  │
│  │  │ - Gemini: 60 req/min        │   │                  │
│  │  │ - Claude: 30 req/min        │   │                  │
│  │  │ - Per-minute reset          │   │                  │
│  │  └─────────────────────────────┘   │                  │
│  │                                    │                  │
│  │  ┌─────────────────────────────┐   │                  │
│  │  │ Concurrency Control         │   │                  │
│  │  │ - Gemini: 2 workers         │   │                  │
│  │  │ - Claude: 1 worker          │   │                  │
│  │  └─────────────────────────────┘   │                  │
│  │                                    │                  │
│  │  ┌─────────────────────────────┐   │                  │
│  │  │ Enrichment Engines          │   │                  │
│  │  │ - enrichWithGemini()        │   │                  │
│  │  │ - enrichWithClaude()        │   │                  │
│  │  │ - storeEnrichmentResults()  │   │                  │
│  │  └─────────────────────────────┘   │                  │
│  │                                    │                  │
│  │  ┌─────────────────────────────┐   │                  │
│  │  │ Retry Logic                 │   │                  │
│  │  │ - Exponential backoff       │   │                  │
│  │  │ - 1s → 2s → 4s              │   │                  │
│  │  │ - Max 3 attempts            │   │                  │
│  │  └─────────────────────────────┘   │                  │
│  │                                    │                  │
│  └────────────────────────────────────┘                  │
│        │                      │                          │
│        ▼                      ▼                          │
│  ┌──────────────┐    ┌──────────────────────┐           │
│  │ PostgreSQL   │    │ External APIs        │           │
│  │ Database     │    │ - Google Gemini      │           │
│  │              │    │ - Anthropic Claude   │           │
│  │ (attachments)│    │                      │           │
│  └──────────────┘    └──────────────────────┘           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## API Endpoint Architecture

```
┌─────────────────────────────────────────────────────┐
│ Enrichment REST API                                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│ GET /api/enrichments/queue-status                   │
│ ├─ Returns: {pending, processing, rateLimits}      │
│ └─ Auth: read/write/admin                           │
│                                                     │
│ POST /api/enrichments/enrich-attachment/:record_id  │
│ ├─ Action: Queue single attachment                  │
│ ├─ Returns: {queued: true, record_id}              │
│ └─ Auth: write/admin                                │
│                                                     │
│ POST /api/enrichments/enrich-all                    │
│ ├─ Query: ?limit=100&file_type=image                │
│ ├─ Action: Batch queue unprocessed files            │
│ ├─ Returns: {total, queued, failed}                │
│ └─ Auth: admin                                      │
│                                                     │
│ POST /api/enrichments/retry-failed                  │
│ ├─ Action: Retry all dead letter items              │
│ ├─ Returns: {retried, newQueueLength}              │
│ └─ Auth: admin                                      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Data Flow: File Upload → Enrichment → Storage

```
1. FILE UPLOAD
   User → POST /api/messages/ingest
           ├─ Message + Files
           └─ Auth token

2. INGEST PROCESSING
   Ingest Route
   ├─ Parse multipart form
   ├─ Store message in DB
   ├─ Store attachment file on disk
   ├─ Create message-attachment link
   └─ Queue enrichment (non-blocking)
       └─ queueEnrichment(recordId, path, mime, type, name)

3. QUEUE MANAGEMENT
   Enrichment Queue
   ├─ Add item to queue
   ├─ Check rate limits (can proceed?)
   ├─ Check concurrency (workers available?)
   └─ If yes → Process next item
      If no  → Wait for worker/rate limit reset

4. FILE TYPE DETECTION
   selectEnrichmentType(mimeType, fileType)
   ├─ image/* → gemini_vision
   ├─ video/* → gemini_vision
   ├─ audio/* → gemini_vision
   ├─ application/pdf → gemini_vision
   └─ text/* → claude_text (or gemini)

5. API CALL (WITH RETRIES)
   For each processing item:
   ├─ enrichWithGemini() OR enrichWithClaude()
   │  ├─ Read file from disk
   │  ├─ Encode to base64
   │  ├─ Call external API
   │  ├─ Parse response JSON
   │  └─ Extract: summary, ocr_text, labels, metadata
   │
   ├─ On Success:
   │  └─ storeEnrichmentResults(recordId, data)
   │     └─ UPDATE attachments SET summary_text, ocr_text, labels, metadata
   │
   └─ On Failure:
      ├─ Retries < 3?
      │  ├─ Yes: Schedule retry with exponential backoff
      │  │        setTimeout(processQueue, 1000 * 2^retries)
      │  └─ No:  Move to dead letter queue
      │
      └─ Log error with timing

6. RESULT STORAGE
   PostgreSQL (attachments table)
   ├─ summary_text: "A scenic mountain landscape..."
   ├─ summary_model: "gemini-2.0-flash"
   ├─ summary_updated_at: "2024-03-07T04:32:15Z"
   ├─ ocr_text: "Summit elevation 12,345 ft"
   ├─ labels: ["landscape", "mountains", "outdoor"]
   ├─ metadata: { ... enrichment details ... }
   └─ SCD2 triggers update effective_from/to

7. INDEXING & SEARCH
   Full-text search enabled on:
   ├─ ocr_text (GIN index)
   ├─ summary_text (partial index)
   ├─ labels (JSONB index)
   └─ metadata (JSONB index)

8. RETRIEVAL
   GET /api/attachments/:record_id
   ├─ Returns: { attachment: {...}, linked_messages: [...] }
   └─ Ready for display/search
```

## Rate Limiting Timeline

```
┌─ 60 second window ─────────────────────────────────────┐
│                                                        │
│ T=0                                                   T=60
│ │                                                      │
│ ├─ Request 1 (30 remaining)                           │
│ ├─ Request 2 (29 remaining)                           │
│ ├─ Request 3 (28 remaining)                           │
│ ├─ Request 4 (27 remaining)                           │
│ ├─ ... 56 more requests ...                           │
│ ├─ Request 59 (1 remaining)                           │
│ ├─ Request 60 (0 remaining, RATE LIMIT HIT)           │
│ │                                                      │
│ └─────────── REQUESTS 61+ QUEUED ──────────────────   │
│                                                        │
│ At T=60:                                              │
│ └─ Counter resets to 0                               │
│    Queued requests proceed                            │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## Concurrency Model

```
Gemini Workers (max 2 concurrent)           Claude Workers (max 1 concurrent)

Worker 1                    Worker 2         Worker 1
├─ Processing image.jpg     ├─ Processing    ├─ Processing
│  [████████░░░░░░░░]       │  video.mp4     │  document.pdf
│  2.5s / 4.0s              │  [████░░░░░░░] │  [██████░░░░░░░░░]
│                           │  3.1s / 8.0s   │  2.3s / 5.0s
│                           │                │
├─ Ready for next           ├─ Wait...       ├─ Ready for next
│                           │                │
Queue                       Queue           Queue
├─ photo1.jpg              ├─ (empty)       ├─ report.txt
├─ photo2.jpg              │                ├─ notes.md
├─ photo3.jpg              │                └─ (empty)
└─ ...                      │

Total inflight: 2 Gemini + 1 Claude = 3 concurrent requests
```

## Error Recovery Flow

```
Enrichment Request
│
└─► Try Processing
    │
    ├─ Success? ✓
    │  └─ Store results
    │     └─ Update attachment
    │
    └─ Failure? ✗
       │
       └─► Retries < 3?
           │
           ├─ Yes
           │  ├─ Increment retry count
           │  ├─ Calculate backoff: INITIAL_BACKOFF_MS * 2^retries
           │  │  (1st: 1s, 2nd: 2s, 3rd: 4s)
           │  ├─ Log: "Retry scheduled..."
           │  └─ setTimeout(processQueue, backoffMs)
           │     └─ Move back to queue
           │
           └─ No (3+ failures)
              ├─ Log: "Failed after 3 retries"
              ├─ Remove from queue
              ├─ Move to dead letter queue
              └─ Can be manually retried with:
                 POST /api/enrichments/retry-failed
```

## State Transitions

```
┌─────────┐
│ Queued  │
└────┬────┘
     │ (rate limit & concurrency OK)
     ▼
┌─────────────────┐
│ Processing...   │
└────┬────────────┘
     │
     ├─ Success ──────┐
     │                ▼
     │            ┌──────────────┐
     │            │ Stored       │
     │            │ in Database  │
     │            └──────────────┘
     │
     ├─ Failure (retries < 3)
     │  │
     │  └─ Wait (backoff)
     │     └─ Re-queue
     │        (back to "Queued")
     │
     └─ Failure (retries >= 3)
        │
        ▼
     ┌──────────────────────┐
     │ Dead Letter Queue    │
     │ (manual intervention)│
     └──────────────────────┘
        │
        └─ POST /retry-failed
           └─ Re-queue
              (back to "Queued")
```

## Database Schema Integration

```
messages table
├─ id, record_id, source_id, sender, recipient, content
├─ timestamp, external_id, metadata
├─ embedding, embedding_model, embedding_updated_at
└─ [Other message fields...]

message_attachment_links table
├─ id, record_id
├─ message_record_id → messages.record_id
├─ attachment_record_id → attachments.record_id
└─ ordinal, role, provider, metadata

attachments table
├─ id, record_id, sha256, size_bytes
├─ mime_type, file_type, original_file_name
├─ storage_path, url_local, url_fallback_*
│
├─ ENRICHMENT FIELDS (populated by system):
│  ├─ summary_text (VARCHAR, 0-5000 chars)
│  ├─ summary_model (VARCHAR, e.g., "gemini-2.0-flash")
│  ├─ summary_updated_at (TIMESTAMPTZ)
│  ├─ ocr_text (TEXT, 0-10,000 chars)
│  ├─ labels (JSONB array)
│  └─ metadata (JSONB object)
│
├─ privacy_level, user_notes
├─ embedding, embedding_model, embedding_updated_at
├─ SCD2 columns: effective_from, effective_to, is_active
└─ timestamps: created_at, updated_at

Indexes (for fast search):
├─ idx_attachments_current (record_id, active)
├─ idx_attachments_summary_text (for search)
├─ idx_attachments_ocr_text (for search)
├─ idx_attachments_labels_gin (JSONB)
├─ idx_attachments_metadata_gin (JSONB)
└─ idx_attachments_sha256 (dedup)
```

---

This architecture ensures:
- ✅ Non-blocking ingest (enrichment is async)
- ✅ Reliable processing (retry logic + dead letter queue)
- ✅ API rate compliance (rate limiting)
- ✅ Scalability (configurable concurrency)
- ✅ Observability (comprehensive logging)
- ✅ Searchability (indexed enrichment fields)
