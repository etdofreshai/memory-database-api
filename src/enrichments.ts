import fs from 'fs';
import path from 'path';
import pool from './db.js';

/**
 * Enrichment System for Memory Database API
 * 
 * Handles async enrichment of attachments using:
 * - Gemini API for images, videos, audio, documents (OCR, summaries, metadata)
 * - Claude Agent SDK for text-based analysis and enrichment
 * 
 * Features:
 * - Queued processing to avoid overloading APIs
 * - Rate limiting per API
 * - Retry logic with exponential backoff
 * - Configurable concurrency
 * - Dead letter queue for failed items
 * - Comprehensive logging and monitoring
 */

const CLAUDE_API_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.claude_code_oauth_token;
const GEMINI_SUMMARIZER_URL = 'https://gemini-test.etdofresh.com/api/summarize';
const GEMINI_DELETE_CONVERSATION_URL = 'https://gemini-test.etdofresh.com/api/conversation';

// Rate limiting config (requests per minute)
const RATE_LIMITS = {
  gemini: 60,
  claude: 30,
};

// Queue config
const CONCURRENCY = {
  gemini: 2,
  claude: 1,
};

// Retry config
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

type EnrichmentType = 'gemini_vision' | 'claude_text';

interface EnrichmentQueueItem {
  recordId: string;
  attachmentPath: string;
  mimeType: string;
  fileType: string;
  fileName: string;
  enrichmentType: EnrichmentType;
  retries: number;
  lastError?: string;
  createdAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface RateLimitTracker {
  gemini: { lastReset: number; count: number };
  claude: { lastReset: number; count: number };
}

// Global state
const queue: EnrichmentQueueItem[] = [];
const processing = { gemini: 0, claude: 0 };
const rateLimiter: RateLimitTracker = {
  gemini: { lastReset: Date.now(), count: 0 },
  claude: { lastReset: Date.now(), count: 0 },
};
const deadLetterQueue: EnrichmentQueueItem[] = [];

// Log configuration at startup
console.log('[Enrichments] System initialized:', {
  geminiSummarizerUrl: GEMINI_SUMMARIZER_URL,
  claudeAvailable: !!CLAUDE_API_TOKEN,
  rateLimits: {
    gemini: `${RATE_LIMITS.gemini} req/min`,
    claude: `${RATE_LIMITS.claude} req/min`,
  },
  concurrency: CONCURRENCY,
});

/**
 * Determine which enrichment method to use based on file type
 */
function selectEnrichmentType(mimeType: string, fileType: string): EnrichmentType {
  // Images, video, audio → Gemini summarizer
  if (fileType === 'image' || fileType === 'video' || fileType === 'audio') {
    return 'gemini_vision';
  }
  // Text, PDFs, documents → Claude
  if (fileType === 'document' || mimeType?.startsWith('text/') || mimeType?.includes('pdf')) {
    return 'claude_text';
  }
  // Default to Gemini for unknown types
  return 'gemini_vision';
}

/**
 * Check if we can make a request to the given API (respects rate limits)
 */
function canMakeRequest(apiName: 'gemini' | 'claude'): boolean {
  const tracker = rateLimiter[apiName];
  const now = Date.now();
  const limit = RATE_LIMITS[apiName];

  // Reset counter every minute
  if (now - tracker.lastReset > 60000) {
    tracker.lastReset = now;
    tracker.count = 0;
  }

  return tracker.count < limit;
}

/**
 * Record an API request for rate limiting
 */
function recordRequest(apiName: 'gemini' | 'claude'): void {
  rateLimiter[apiName].count++;
}

/**
 * Enrich attachment with Gemini Vision API
 */
async function enrichWithGemini(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, mimeType, fileType, fileName } = item;

  if (!fs.existsSync(attachmentPath)) {
    throw new Error(`File not found: ${attachmentPath}`);
  }

  // Use gemini-test.etdofresh.com/api/summarize (multipart form upload)
  const fileBuffer = fs.readFileSync(attachmentPath);
  const blob = new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' });

  const formData = new FormData();
  formData.append('file', blob, fileName);

  const response = await fetch(GEMINI_SUMMARIZER_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini summarizer error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as any;
  const summaryText = result?.summary || '';

  if (!summaryText) {
    throw new Error('No summary from Gemini summarizer response');
  }

  // Parse the structured summary format:
  // Raw Content, Title, Summary, File Description, Tags
  const titleMatch = summaryText.match(/Title\n(.+)/);
  const summaryMatch = summaryText.match(/Summary\n([\s\S]*?)(?:\n\n(?:File Description|Tags)|$)/);
  const tagsMatch = summaryText.match(/Tags\n(.+)/);
  const rawContentMatch = summaryText.match(/Raw Content\n([\s\S]*?)(?:\n\nTitle|$)/);

  const title = titleMatch?.[1]?.trim() || '';
  const summary = summaryMatch?.[1]?.trim() || summaryText.substring(0, 500);
  const tags = tagsMatch?.[1]?.trim().split(/,\s*/).map((t: string) => t.trim()).filter(Boolean) || [];
  const rawContent = rawContentMatch?.[1]?.trim() || '';

  const enrichmentData = {
    summary: title ? `${title}: ${summary}` : summary,
    ocr_text: rawContent || null,
    labels: tags,
    metadata: {
      model: result?.metadata?.modelName || 'gemini',
      conversationId: result?.metadata?.conversationId,
      analyzed_by: 'gemini-summarizer',
    },
  };

  // Store results in database
  await storeEnrichmentResults(recordId, enrichmentData);

  // Clean up: delete the Gemini conversation to avoid clutter
  const conversationId = result?.metadata?.conversationId;
  if (conversationId) {
    try {
      await fetch(`${GEMINI_DELETE_CONVERSATION_URL}/${conversationId}`, {
        method: 'DELETE',
      });
      console.log(`[gemini] Deleted conversation ${conversationId} for ${recordId}`);
    } catch (err) {
      console.warn(`[gemini] Failed to delete conversation ${conversationId}:`, err);
    }
  }
}

/**
 * Enrich attachment with Claude analysis
 * 
 * Uses Claude API for detailed text-based analysis
 */
async function enrichWithClaude(item: EnrichmentQueueItem): Promise<void> {
  if (!CLAUDE_API_TOKEN) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN not configured');
  }

  const { recordId, attachmentPath, fileType, mimeType, fileName } = item;

  if (!fs.existsSync(attachmentPath)) {
    throw new Error(`File not found: ${attachmentPath}`);
  }

  let fileContent = '';
  let labels: string[] = [];

  try {
    // Handle different document types
    if (mimeType === 'application/pdf') {
      // For PDFs, extract first 5000 characters as text
      // In production, use a proper PDF parser
      const buffer = fs.readFileSync(attachmentPath);
      fileContent = buffer.toString('binary').substring(0, 5000);
      labels.push('pdf', 'document');
    } else if (fileType === 'document' || mimeType?.startsWith('text/')) {
      fileContent = fs.readFileSync(attachmentPath, 'utf-8').substring(0, 10000);
      labels.push('document', 'text');
    } else {
      // Skip non-text files for Claude
      console.log(`Skipping Claude enrichment for non-text file: ${fileName}`);
      return;
    }

    if (!fileContent.trim()) {
      throw new Error('Document is empty or unreadable');
    }

    // Call Claude API using OAuth token
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${CLAUDE_API_TOKEN}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Please analyze this document and provide:
1. A concise 2-3 sentence summary
2. Key entities or topics mentioned
3. Suggested labels/tags (as a JSON array)

Document content (first 10000 chars):
${fileContent}

Respond in JSON format with keys: summary, key_topics (array of strings), labels (array of strings).`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Claude API error (${response.status}): ${errorData}`);
    }

    const result = await response.json();
    const textContent = result?.content?.[0]?.text;

    if (!textContent) {
      throw new Error('No content from Claude response');
    }

    // Parse JSON from Claude response
    let enrichmentData: any;
    try {
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      enrichmentData = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
    } catch {
      enrichmentData = {
        summary: textContent.substring(0, 500),
        labels: labels,
        metadata: { model: 'claude-sonnet-4-20250514', analyzed_by: 'claude' },
      };
    }

    // Ensure metadata has model info
    enrichmentData.metadata = {
      ...enrichmentData.metadata,
      model: 'claude-sonnet-4-20250514',
      analyzed_by: 'claude',
    };

    // Merge labels from both sources
    if (Array.isArray(enrichmentData.labels)) {
      enrichmentData.labels = [...new Set([...labels, ...enrichmentData.labels])];
    } else {
      enrichmentData.labels = labels;
    }

    // Store results
    await storeEnrichmentResults(recordId, enrichmentData);
  } catch (err) {
    console.error(`Claude enrichment error for ${fileName}:`, err);
    throw err;
  }
}

/**
 * Store enrichment results in the database
 */
async function storeEnrichmentResults(recordId: string, data: any): Promise<void> {
  const {
    summary = null,
    ocr_text = null,
    labels = [],
    metadata = {},
  } = data;

  const model = metadata?.model || metadata?.analyzed_by || 'unknown';
  const now = new Date().toISOString();

  // Update attachment with enrichment results
  await pool.query(
    `UPDATE attachments
     SET summary_text = COALESCE($1, summary_text),
         summary_model = $7,
         summary_updated_at = $5,
         ocr_text = COALESCE($2, ocr_text),
         labels = $3::jsonb,
         metadata = jsonb_set(COALESCE(metadata, '{}'), '{enrichment_metadata}', $4::jsonb),
         updated_at = $5
     WHERE record_id = $6::uuid AND is_active = true`,
    [
      summary,
      ocr_text,
      JSON.stringify(Array.isArray(labels) ? labels : []),
      JSON.stringify(metadata),
      now,
      recordId,
      model,
    ]
  );
}

/**
 * Process next item in the queue (for a specific API)
 */
async function processNextItem(
  apiName: 'gemini' | 'claude'
): Promise<void> {
  // Find next item for this API
  const itemIdx = queue.findIndex(item => {
    if (apiName === 'gemini') {
      return item.enrichmentType === 'gemini_vision';
    } else {
      return item.enrichmentType === 'claude_text';
    }
  });

  if (itemIdx === -1) return; // No items for this API

  const item = queue[itemIdx];
  const startTime = Date.now();

  try {
    console.log(`[${apiName}] Starting enrichment for ${item.recordId} (${item.fileName})`);

    if (apiName === 'gemini') {
      await enrichWithGemini(item);
    } else {
      await enrichWithClaude(item);
    }

    // Success
    const duration = Date.now() - startTime;
    queue.splice(itemIdx, 1);
    console.log(
      `[${apiName}] Successfully enriched ${item.recordId} in ${duration}ms`
    );
    item.resolve();
  } catch (err: any) {
    const error = err as Error;
    item.lastError = error.message;
    const duration = Date.now() - startTime;

    if (item.retries < MAX_RETRIES) {
      // Retry with exponential backoff
      item.retries++;
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, item.retries - 1);
      console.warn(
        `[${apiName}] Retry scheduled for ${item.recordId} (attempt ${item.retries}/${MAX_RETRIES}) in ${backoffMs}ms. Error: ${error.message}`
      );
      setTimeout(() => {
        // Re-add to queue
        queue.push(item);
        processQueue();
      }, backoffMs);
    } else {
      // Max retries exceeded, move to dead letter queue
      console.error(
        `[${apiName}] Failed to enrich ${item.recordId} after ${MAX_RETRIES} retries (${duration}ms): ${error.message}`
      );
      queue.splice(itemIdx, 1);
      deadLetterQueue.push(item);
      item.reject(error);
    }
  }
}

/**
 * Main queue processor
 */
async function processQueue(): Promise<void> {
  // Process Gemini queue
  if (
    processing.gemini < CONCURRENCY.gemini &&
    canMakeRequest('gemini') &&
    queue.some(item => item.enrichmentType === 'gemini_vision')
  ) {
    processing.gemini++;
    recordRequest('gemini');
    processNextItem('gemini')
      .catch(err => console.error('Gemini processing error:', err))
      .finally(() => {
        processing.gemini--;
        processQueue();
      });
  }

  // Process Claude queue
  if (
    processing.claude < CONCURRENCY.claude &&
    canMakeRequest('claude') &&
    queue.some(item => item.enrichmentType === 'claude_text')
  ) {
    processing.claude++;
    recordRequest('claude');
    processNextItem('claude')
      .catch(err => console.error('Claude processing error:', err))
      .finally(() => {
        processing.claude--;
        processQueue();
      });
  }
}

/**
 * Queue an attachment for enrichment
 */
export function queueEnrichment(
  recordId: string,
  attachmentPath: string,
  mimeType: string,
  fileType: string,
  fileName: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const enrichmentType = selectEnrichmentType(mimeType, fileType);

    const item: EnrichmentQueueItem = {
      recordId,
      attachmentPath,
      mimeType,
      fileType,
      fileName,
      enrichmentType,
      retries: 0,
      createdAt: Date.now(),
      resolve,
      reject,
    };

    queue.push(item);
    processQueue();
  });
}

/**
 * Get queue status (for monitoring/debugging)
 */
export function getQueueStatus() {
  return {
    pending: queue.length,
    processing: {
      gemini: processing.gemini,
      claude: processing.claude,
    },
    rateLimits: {
      gemini: {
        used: rateLimiter.gemini.count,
        limit: RATE_LIMITS.gemini,
      },
      claude: {
        used: rateLimiter.claude.count,
        limit: RATE_LIMITS.claude,
      },
    },
    deadLetterCount: deadLetterQueue.length,
    deadLetterQueue: deadLetterQueue.map(item => ({
      recordId: item.recordId,
      fileName: item.fileName,
      lastError: item.lastError,
      retries: item.retries,
    })),
  };
}

/**
 * Retry dead letter items
 */
export function retryDeadLetters(): void {
  const itemsToRetry = [...deadLetterQueue];
  deadLetterQueue.length = 0;

  for (const item of itemsToRetry) {
    item.retries = 0;
    queue.push(item);
  }

  processQueue();
}
