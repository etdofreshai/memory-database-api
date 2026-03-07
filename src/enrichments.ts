import fs from 'fs';
import path from 'path';
import pool from './db.js';

/**
 * Enrichment System for Memory Database API
 * 
 * Handles async enrichment of attachments using:
 * - Z.AI (GLM-4.6V) for images, videos, audio, documents (OCR, summaries, metadata)
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
const ZAI_TOKEN = process.env.ZAI_TOKEN || process.env.Z_AI_TOKEN || process.env.z_ai_token;
const Z_AI_BASE_URL = process.env.Z_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const Z_AI_MODEL = process.env.Z_AI_MODEL || 'glm-4.6';

// Rate limiting config (requests per minute)
const RATE_LIMITS = {
  zai: 60,
  claude: 30,
};

// Queue config
const CONCURRENCY = {
  zai: 2,
  claude: 1,
};

// Retry config
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

type EnrichmentType = 'zai_vision' | 'claude_text';

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
  zai: { lastReset: number; count: number };
  claude: { lastReset: number; count: number };
}

// Global state
const queue: EnrichmentQueueItem[] = [];
const processing = { zai: 0, claude: 0 };
const rateLimiter: RateLimitTracker = {
  zai: { lastReset: Date.now(), count: 0 },
  claude: { lastReset: Date.now(), count: 0 },
};
const deadLetterQueue: EnrichmentQueueItem[] = [];
let paused = false;

// Validate ZAI_TOKEN at startup
if (!ZAI_TOKEN) {
  console.warn('[Enrichments] WARNING: ZAI_TOKEN is not set. Z.AI enrichments will fail. Set ZAI_TOKEN (or Z_AI_TOKEN, z_ai_token as fallbacks) environment variable.');
}

// Log configuration at startup
console.log('[Enrichments] System initialized:', {
  zaiModel: Z_AI_MODEL,
  zaiBaseUrl: Z_AI_BASE_URL,
  zaiTokenSet: !!ZAI_TOKEN,
  claudeAvailable: !!CLAUDE_API_TOKEN,
  rateLimits: {
    zai: `${RATE_LIMITS.zai} req/min`,
    claude: `${RATE_LIMITS.claude} req/min`,
  },
  concurrency: CONCURRENCY,
});

/**
 * Determine which enrichment method to use based on file type
 */
function selectEnrichmentType(mimeType: string, fileType: string): EnrichmentType {
  // Images, video, audio → Z.AI GLM vision
  if (fileType === 'image' || fileType === 'video' || fileType === 'audio') {
    return 'zai_vision';
  }
  // Text, PDFs, documents → Claude
  if (fileType === 'document' || mimeType?.startsWith('text/') || mimeType?.includes('pdf')) {
    return 'claude_text';
  }
  // Default to Z.AI for unknown types
  return 'zai_vision';
}

/**
 * Check if we can make a request to the given API (respects rate limits)
 */
function canMakeRequest(apiName: 'zai' | 'claude'): boolean {
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
function recordRequest(apiName: 'zai' | 'claude'): void {
  rateLimiter[apiName].count++;
}

/**
 * Build the Z.AI prompt for summarizing an attachment
 */
function buildZaiPrompt(fileType: string, fileName: string): string {
  const base = `Analyze this file and provide a structured response with the following sections:

Raw Content
(Extract any readable text, OCR content, or transcript from the file)

Title
(A concise descriptive title)

Summary
(A 2-3 sentence summary of the content)

File Description
(What kind of file this is and what it contains)

Tags
(Comma-separated relevant tags/labels)`;

  if (fileType === 'audio') {
    return `This is an audio file (${fileName}). Please transcribe the audio content first, then summarize it.\n\n${base}`;
  }
  return base;
}

/**
 * Enrich attachment with Z.AI GLM Vision API
 */
async function enrichWithZai(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, mimeType, fileType, fileName } = item;

  if (!ZAI_TOKEN) {
    throw new Error('ZAI_TOKEN not configured. Set ZAI_TOKEN environment variable.');
  }

  if (!fs.existsSync(attachmentPath)) {
    throw new Error(`File not found: ${attachmentPath}`);
  }

  // Read file and convert to base64 for the Z.AI API
  const fileBuffer = fs.readFileSync(attachmentPath);
  const base64Data = fileBuffer.toString('base64');
  const dataUrl = `data:${mimeType || 'application/octet-stream'};base64,${base64Data}`;

  const prompt = buildZaiPrompt(fileType, fileName);

  // Build messages with multimodal content
  const userContent: any[] = [];

  // For image/video types, include as image_url; for audio/other, include as file reference
  if (fileType === 'image' || fileType === 'video') {
    userContent.push({
      type: 'image_url',
      image_url: { url: dataUrl },
    });
  } else {
    // For audio and other types, try sending as image_url (GLM-4V accepts various media)
    // If the model doesn't support this media type, it will return an error and we retry differently
    userContent.push({
      type: 'image_url',
      image_url: { url: dataUrl },
    });
  }

  userContent.push({
    type: 'text',
    text: prompt,
  });

  const response = await fetch(`${Z_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZAI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Z_AI_MODEL,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Z.AI API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as any;
  const summaryText = result?.choices?.[0]?.message?.content || '';

  if (!summaryText) {
    throw new Error('No content from Z.AI response');
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

  const modelUsed = result?.model || Z_AI_MODEL;

  const enrichmentData = {
    summary: title ? `${title}: ${summary}` : summary,
    ocr_text: rawContent || null,
    labels: tags,
    metadata: {
      model: modelUsed,
      analyzed_by: 'zai-glm',
      zai_usage: result?.usage || null,
    },
  };

  // Store results in database
  await storeEnrichmentResults(recordId, enrichmentData);
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
  apiName: 'zai' | 'claude'
): Promise<void> {
  // Find next item for this API
  const itemIdx = queue.findIndex(item => {
    if (apiName === 'zai') {
      return item.enrichmentType === 'zai_vision';
    } else {
      return item.enrichmentType === 'claude_text';
    }
  });

  if (itemIdx === -1) return; // No items for this API

  const item = queue[itemIdx];
  const startTime = Date.now();

  try {
    console.log(`[${apiName}] Starting enrichment for ${item.recordId} (${item.fileName})`);

    if (apiName === 'zai') {
      await enrichWithZai(item);
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
  if (paused) return;
  // Process Z.AI queue
  if (
    processing.zai < CONCURRENCY.zai &&
    canMakeRequest('zai') &&
    queue.some(item => item.enrichmentType === 'zai_vision')
  ) {
    processing.zai++;
    recordRequest('zai');
    processNextItem('zai')
      .catch(err => console.error('Z.AI processing error:', err))
      .finally(() => {
        processing.zai--;
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
    paused,
    pending: queue.length,
    processing: {
      zai: processing.zai,
      claude: processing.claude,
    },
    rateLimits: {
      zai: {
        used: rateLimiter.zai.count,
        limit: RATE_LIMITS.zai,
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

/**
 * Pause queue processing (items already in-flight will finish)
 */
export function pauseQueue(): void {
  paused = true;
}

/**
 * Resume queue processing
 */
export function resumeQueue(): void {
  paused = false;
  processQueue();
}

/**
 * Cancel all pending items in the queue (does not affect in-flight)
 */
export function cancelPending(): number {
  const count = queue.length;
  for (const item of queue) {
    item.reject(new Error('Cancelled'));
  }
  queue.length = 0;
  return count;
}

/**
 * Check if queue is paused
 */
export function isPaused(): boolean {
  return paused;
}
