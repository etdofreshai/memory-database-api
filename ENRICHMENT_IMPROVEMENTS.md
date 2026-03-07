# Enrichment System — Improvements & Claude SDK Integration

## Current State

✅ **Working:**
- Z.AI API integration for all file types
- Rate limiting + queue management
- Exponential backoff retry logic
- Dead letter queue
- Auto-enrichment on ingest

❌ **Gaps:**
- Claude routing not optimized (documents still go to Z.AI)
- Claude SDK (agent execution) not implemented
- No streaming responses for long documents
- Basic JSON parsing from LLM responses (fragile)

## Recommended Improvements

### 1. Separate Claude for Text-Based Enrichment

**Current:** All files → Z.AI

**Better:** Route by file type:
```typescript
function selectEnrichmentType(mimeType: string, fileType: string): EnrichmentType {
  // Vision/media → Z.AI
  if (['image', 'video', 'audio'].includes(fileType)) {
    return 'zai_vision';
  }
  
  // PDFs with lots of text → Claude (better for dense documents)
  if (fileType === 'document' && mimeType === 'application/pdf') {
    return 'claude_text';
  }
  
  // Plain text, code, docs → Claude
  if (fileType === 'document' || mimeType.startsWith('text/')) {
    return 'claude_text';
  }
  
  // Fallback
  return 'zai_vision';
}
```

### 2. Implement Claude Agent SDK

**Current:** Using basic Anthropic API (messages endpoint)

**Better:** Use Claude Agent SDK for agentic workflows
```typescript
// src/enrichments.ts

import Anthropic from "@anthropic-ai/sdk";

const claudeClient = new Anthropic({
  apiKey: CLAUDE_API_TOKEN,
});

async function enrichWithClaudeAgent(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, fileType, fileName } = item;
  
  if (!fs.existsSync(attachmentPath)) {
    throw new Error(`File not found: ${attachmentPath}`);
  }
  
  let fileContent = '';
  
  // Read file based on type
  if (fileType === 'document') {
    if (fileName.endsWith('.pdf')) {
      // Use a PDF parser library (e.g., pdf-parse)
      // fileContent = await parsePDF(attachmentPath);
      fileContent = fs.readFileSync(attachmentPath, 'binary').substring(0, 50000);
    } else {
      fileContent = fs.readFileSync(attachmentPath, 'utf-8');
    }
  } else {
    throw new Error(`Claude only processes text/document files, got: ${fileType}`);
  }
  
  if (!fileContent.trim()) {
    throw new Error('Document is empty or unreadable');
  }
  
  // Use Agent SDK for multi-step analysis
  const response = await claudeClient.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze this document and extract:
1. Executive summary (2-3 sentences)
2. Main topics or sections
3. Key entities (people, companies, dates)
4. Suggested tags/labels
5. Document type (report, email, contract, etc.)

Document (first 50k chars):
${fileContent}

Return as JSON: { summary, topics: [], entities: [], labels: [], doc_type }`,
      },
    ],
  });
  
  const textContent = response.content[0]?.type === 'text' ? response.content[0].text : '';
  
  // Parse and store
  const enrichmentData = parseClaudeResponse(textContent);
  await storeEnrichmentResults(recordId, enrichmentData);
}

function parseClaudeResponse(text: string): any {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] || text);
  } catch {
    return {
      summary: text.substring(0, 500),
      labels: [],
      metadata: { parse_error: true },
    };
  }
}
```

### 3. Add Streaming for Large Documents

For PDFs and long text, stream responses instead of waiting for full completion:

```typescript
async function enrichWithClaudeStreaming(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath } = item;
  const fileContent = fs.readFileSync(attachmentPath, 'utf-8');
  
  let fullResponse = '';
  
  const stream = await claudeClient.messages.stream({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Analyze: ${fileContent}`,
      },
    ],
  });
  
  // Process chunks as they arrive
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      fullResponse += chunk.delta.text;
      console.log(`[claude-stream] Received chunk for ${recordId}`);
    }
  }
  
  const enrichmentData = parseClaudeResponse(fullResponse);
  await storeEnrichmentResults(recordId, enrichmentData);
}
```

### 4. Respect Rate Limit Headers

Both APIs return rate limit info in response headers:

```typescript
async function enrichWithZ.AI(item: EnrichmentQueueItem): Promise<void> {
  // ... existing code ...
  
  const response = await fetch(`${Z_AI_BASE_URL}/zai-2.0-flash:generateContent?key=${ZAI_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  
  // Check rate limit headers
  const remainingRequests = response.headers.get('x-ratelimit-remaining-requests');
  const resetTime = response.headers.get('x-ratelimit-reset-requests');
  
  if (remainingRequests) {
    console.log(`[zai] Remaining requests: ${remainingRequests}`);
    if (parseInt(remainingRequests) < 5) {
      console.warn('[zai] Approaching rate limit, pausing...');
      // Slow down queue processing
    }
  }
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Z.AI API error (${response.status}): ${errorText}`);
  }
  
  // ... rest of code ...
}
```

### 5. Better Error Handling

```typescript
const ERRORS = {
  RATE_LIMITED: 'rate_limit',
  API_ERROR: 'api_error',
  INVALID_FILE: 'invalid_file',
  TIMEOUT: 'timeout',
  PARSE_ERROR: 'parse_error',
};

async function enrichWithZ.AI(item: EnrichmentQueueItem): Promise<void> {
  try {
    // ... existing code ...
  } catch (err: any) {
    if (err.message.includes('429') || err.message.includes('rate')) {
      throw { ...err, errorType: ERRORS.RATE_LIMITED };
    }
    if (err.code === 'ENOENT') {
      throw { ...err, errorType: ERRORS.INVALID_FILE };
    }
    throw { ...err, errorType: ERRORS.API_ERROR };
  }
}

// In processNextItem():
} catch (err: any) {
  const errorType = err.errorType || ERRORS.API_ERROR;
  
  // Don't retry file not found errors
  if (errorType === ERRORS.INVALID_FILE) {
    console.error(`[${apiName}] Skipping invalid file: ${item.fileName}`);
    queue.splice(itemIdx, 1);
    deadLetterQueue.push(item);
    item.reject(err);
    return;
  }
  
  // Longer backoff for rate limits
  if (errorType === ERRORS.RATE_LIMITED) {
    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, item.retries),
      300000 // Max 5 minutes
    );
    console.warn(`[${apiName}] Rate limited, backing off for ${backoffMs}ms`);
  }
  
  // ... rest of retry logic ...
}
```

### 6. Webhook Notifications on Completion

Optionally notify external systems when enrichment completes:

```typescript
interface EnrichmentWebhook {
  url: string;
  secret: string;
}

const webhooks: EnrichmentWebhook[] = [];

async function notifyWebhook(recordId: string, status: 'success' | 'failed', data?: any) {
  for (const webhook of webhooks) {
    try {
      const payload = {
        event: 'attachment.enriched',
        record_id: recordId,
        status,
        data,
        timestamp: new Date().toISOString(),
      };
      
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      
      await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('Webhook notification failed:', err);
    }
  }
}

// Call in processNextItem():
await notifyWebhook(item.recordId, 'success', enrichmentData);
```

## Implementation Checklist

- [ ] Separate Claude routing for text-based files
- [ ] Install Anthropic SDK: `npm install @anthropic-ai/sdk`
- [ ] Update `enrichWithClaudeAgent()` to use new SDK
- [ ] Add streaming support for large documents
- [ ] Implement rate limit header parsing
- [ ] Add better error categorization
- [ ] Add webhook notifications (optional)
- [ ] Add integration tests with mock APIs
- [ ] Update documentation with new capabilities
- [ ] Test with real Z.AI + Claude keys

## Testing the Improvements

```bash
# Install new dependency
npm install @anthropic-ai/sdk pdf-parse

# Run tests
npm test

# Test enrichment endpoints
curl -X POST http://localhost:3000/api/enrichments/enrich-all?limit=10 \
  -H "Authorization: Bearer admin_token"

# Monitor queue
watch 'curl -s http://localhost:3000/api/enrichments/queue-status -H "Authorization: Bearer token" | jq'
```

## Environment Variables for Testing

```bash
# .env.test
ZAI_TOKEN="AIzaSyDxx..."
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-xxx..."
NODE_ENV="test"
```

Run: `node -r dotenv/config npm test`
