import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import pool from './db.js';
import sharp from 'sharp';
import convert from 'heic-convert';
import { getMcpVisionClient, shutdownMcpVisionClient } from './mcp-vision-client.js';
import { parsePluginPayloadAttachment } from './plugin-payload-parser.js';

// Max image size for MCP vision server (5MB)
// Max video size for MCP vision server (8MB)
const MAX_VIDEO_SIZE_MB = 8;
const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

/**
 * Convert HEIC/HEIF to JPEG if needed
 * Returns path to use (either original or converted temp file)
 */
async function convertHeicIfNeeded(filePath: string): Promise<{ path: string; cleanup?: () => void }> {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext !== '.heic' && ext !== '.heif') {
    return { path: filePath };
  }
  
  console.log(`[convert] Converting HEIC to JPEG: ${path.basename(filePath)}`);
  
  try {
    // Read HEIC file
    const inputBuffer = fs.readFileSync(filePath);
    
    // Convert to JPEG
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.9
    });
    
    // Save to temp file
    const tempDir = os.tmpdir();
    const baseName = path.basename(filePath, ext);
    const tempPath = path.join(tempDir, `converted-${Date.now()}-${baseName}.jpg`);
    
    fs.writeFileSync(tempPath, Buffer.from(outputBuffer));
    
    const newStats = fs.statSync(tempPath);
    console.log(`[convert] Converted to JPEG (${(newStats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    return {
      path: tempPath,
      cleanup: () => {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
    };
  } catch (err: any) {
    console.error(`[convert] HEIC conversion failed: ${err.message}`);
    throw new Error(`Failed to convert HEIC to JPEG: ${err.message}`);
  }
}

/**
 * Convert GIF to JPEG (first frame) if needed
 * Returns path to use (either original or converted temp file)
 */
async function convertGifIfNeeded(filePath: string): Promise<{ path: string; cleanup?: () => void }> {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext !== '.gif') {
    return { path: filePath };
  }
  
  console.log(`[convert] Converting GIF to JPEG: ${path.basename(filePath)}`);
  
  try {
    const tempDir = os.tmpdir();
    const baseName = path.basename(filePath, ext);
    const tempPath = path.join(tempDir, `converted-${Date.now()}-${baseName}.jpg`);
    
    // Use sharp to extract first frame and convert to JPEG
    await sharp(filePath, { pages: 1 })
      .jpeg({ quality: 90 })
      .toFile(tempPath);
    
    const newStats = fs.statSync(tempPath);
    console.log(`[convert] Converted GIF to JPEG (${(newStats.size / 1024 / 1024).toFixed(2)}MB)`);
    
    return {
      path: tempPath,
      cleanup: () => {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
    };
  } catch (err: any) {
    console.error(`[convert] GIF conversion failed: ${err.message}`);
    throw new Error(`Failed to convert GIF to JPEG: ${err.message}`);
  }
}

/**
 * Compress video if it exceeds max size (8MB) using ffmpeg
 */
async function compressVideoIfNeeded(filePath: string): Promise<{ path: string; cleanup?: () => void }> {
  const stats = fs.statSync(filePath);
  
  if (stats.size <= MAX_VIDEO_SIZE_BYTES) {
    return { path: filePath };
  }
  
  console.log(`[compress] Video too large (${(stats.size / 1024 / 1024).toFixed(2)}MB), compressing to fit ${MAX_VIDEO_SIZE_MB}MB...`);
  
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `compressed-${Date.now()}-${path.basename(filePath, path.extname(filePath))}.mp4`);
  
  try {
    // Target bitrate: aim for ~7MB to leave headroom
    const targetBytes = MAX_VIDEO_SIZE_BYTES * 0.85;
    // Get video duration
    const durationStr = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();
    const duration = parseFloat(durationStr) || 10;
    const targetBitrate = Math.floor((targetBytes * 8) / duration / 1000); // kbps
    
    // Compress with ffmpeg: reduce resolution to 720p max, pad to even dimensions, limit bitrate
    execSync(
      `ffmpeg -i "${filePath}" -vf "scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -b:v ${targetBitrate}k -maxrate ${targetBitrate * 2}k -bufsize ${targetBitrate * 4}k -preset fast -an -y "${tempPath}"`,
      { timeout: 120000, stdio: 'pipe' }
    );
    
    const newStats = fs.statSync(tempPath);
    console.log(`[compress] Compressed to ${(newStats.size / 1024 / 1024).toFixed(2)}MB (bitrate: ${targetBitrate}kbps, duration: ${duration.toFixed(1)}s)`);
    
    return {
      path: tempPath,
      cleanup: () => {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    };
  } catch (err: any) {
    // Clean up temp file on error
    try { fs.unlinkSync(tempPath); } catch {}
    console.error(`[compress] Video compression failed: ${err.message}`);
    throw new Error(`Failed to compress video: ${err.message}`);
  }
}

/**
 * Resize image if it exceeds max size
 * Returns path to use (either original or resized temp file)
 */
async function resizeImageIfNeeded(filePath: string): Promise<{ path: string; cleanup?: () => void }> {
  const stats = fs.statSync(filePath);
  
  if (stats.size <= MAX_IMAGE_SIZE_BYTES) {
    return { path: filePath };
  }
  
  console.log(`[resize] Image too large (${(stats.size / 1024 / 1024).toFixed(2)}MB), resizing to fit ${MAX_IMAGE_SIZE_MB}MB...`);
  
  // Calculate scale factor needed
  const targetSize = MAX_IMAGE_SIZE_BYTES * 0.9; // 90% of max to be safe
  const scaleFactor = Math.sqrt(targetSize / stats.size);
  
  // Get image dimensions
  const image = sharp(filePath);
  const metadata = await image.metadata();
  
  const newWidth = Math.round((metadata.width || 1000) * scaleFactor);
  const newHeight = Math.round((metadata.height || 1000) * scaleFactor);
  
  // Resize and save to temp
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `resized-${Date.now()}-${path.basename(filePath, path.extname(filePath))}.jpg`);
  
  await sharp(filePath)
    .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }) // Convert to JPEG for better compression
    .toFile(tempPath);
  
  const newStats = fs.statSync(tempPath);
  console.log(`[resize] Resized to ${(newStats.size / 1024 / 1024).toFixed(2)}MB (${newWidth}x${newHeight})`);
  
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  };
}

/**
 * Prepare image for MCP vision: convert HEIC if needed, then resize if needed
 */
// File types we can't process — skip gracefully
const SKIP_EXTENSIONS = new Set([
  '.caf',   // Core Audio Format (unsupported by MCP)
  '.amr',   // Adaptive Multi-Rate audio
  '.oga',   // Ogg audio
  '.webm',  // WebM (if not supported)
]);

async function prepareImageForMcp(filePath: string): Promise<{ path: string; cleanup: () => void }> {
  const ext = path.extname(filePath).toLowerCase();
  
  if (SKIP_EXTENSIONS.has(ext)) {
    const noRetry = new Error(`Skipped: ${ext} files are not analyzable media (e.g. iMessage link preview)`);
    (noRetry as any).noRetry = true;
    throw noRetry;
  }
  
  const cleanups: (() => void)[] = [];
  let currentPath = filePath;
  
  // Step 1: Convert HEIC to JPEG if needed
  const converted = await convertHeicIfNeeded(currentPath);
  currentPath = converted.path;
  if (converted.cleanup) cleanups.push(converted.cleanup);
  
  // Step 2: Convert GIF to JPEG (first frame) if needed
  const gif = await convertGifIfNeeded(currentPath);
  currentPath = gif.path;
  if (gif.cleanup) cleanups.push(gif.cleanup);
  
  // Step 3: Resize if too large
  const resized = await resizeImageIfNeeded(currentPath);
  currentPath = resized.path;
  if (resized.cleanup) cleanups.push(resized.cleanup);
  
  return {
    path: currentPath,
    cleanup: () => {
      for (const fn of cleanups) fn();
    }
  };
}

/**
 * Enrichment System for Memory Database API
 * 
 * Handles async enrichment of attachments using:
 * - Z.AI (GLM-5) for images, videos, audio, documents (OCR, summaries, metadata)
 * 
 * Features:
 * - Queued processing to avoid overloading APIs
 * - Rate limiting per API
 * - Retry logic with exponential backoff
 * - Configurable concurrency
 * - Dead letter queue for failed items
 * - Comprehensive logging and monitoring
 */

const ZAI_TOKEN = process.env.ZAI_TOKEN || process.env.Z_AI_TOKEN || process.env.z_ai_token;
// Use coding endpoint for subscription plans (supports text, limited multimodal)
const Z_AI_BASE_URL = process.env.Z_AI_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
// Fallback for standard endpoint (uncomment if using free tier)
// const Z_AI_BASE_URL = process.env.Z_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const Z_AI_MODEL = process.env.Z_AI_MODEL || 'glm-5';

// Rate limiting config (requests per minute)
const RATE_LIMITS = {
  zai: 60,
};

// Adaptive concurrency config (mutable — updated via API)
let ADAPTIVE_CONCURRENCY = {
  initial: 5,       // Start with 5 concurrent
  min: 1,            // Never go below 1
  max: 20,           // Cap at 20
  increaseAfter: 10, // Increase after N consecutive successes
  decreaseFactor: 0.5, // Halve on rate limit hit
  increaseFactor: 1,   // Add 1 on success streak
};

// Adaptive concurrency state
const adaptiveState = {
  current: ADAPTIVE_CONCURRENCY.initial,
  consecutiveSuccesses: 0,
  consecutiveFailures: 0,
  maxReached: ADAPTIVE_CONCURRENCY.initial,
  totalSuccesses: 0,
  totalRateLimitHits: 0,
  lastAdjustment: Date.now(),
  history: [] as Array<{ time: number; concurrency: number; reason: string }>,
};

function adjustConcurrencyUp() {
  const prev = adaptiveState.current;
  adaptiveState.current = Math.min(
    adaptiveState.current + ADAPTIVE_CONCURRENCY.increaseFactor,
    ADAPTIVE_CONCURRENCY.max
  );
  if (adaptiveState.current > prev) {
    adaptiveState.maxReached = Math.max(adaptiveState.maxReached, adaptiveState.current);
    adaptiveState.lastAdjustment = Date.now();
    adaptiveState.history.push({ time: Date.now(), concurrency: adaptiveState.current, reason: `increased after ${ADAPTIVE_CONCURRENCY.increaseAfter} successes` });
    console.log(`[adaptive] Concurrency increased: ${prev} → ${adaptiveState.current} (max reached: ${adaptiveState.maxReached})`);
  }
}

function adjustConcurrencyDown() {
  const prev = adaptiveState.current;
  adaptiveState.current = Math.max(
    Math.floor(adaptiveState.current * ADAPTIVE_CONCURRENCY.decreaseFactor),
    ADAPTIVE_CONCURRENCY.min
  );
  adaptiveState.consecutiveSuccesses = 0;
  adaptiveState.totalRateLimitHits++;
  adaptiveState.lastAdjustment = Date.now();
  adaptiveState.history.push({ time: Date.now(), concurrency: adaptiveState.current, reason: 'rate limit hit' });
  // Keep only last 50 history entries
  if (adaptiveState.history.length > 50) adaptiveState.history = adaptiveState.history.slice(-50);
  console.log(`[adaptive] Concurrency decreased: ${prev} → ${adaptiveState.current} (rate limit hit #${adaptiveState.totalRateLimitHits})`);
}

function recordSuccess() {
  adaptiveState.consecutiveSuccesses++;
  adaptiveState.consecutiveFailures = 0;
  adaptiveState.totalSuccesses++;
  if (adaptiveState.consecutiveSuccesses >= ADAPTIVE_CONCURRENCY.increaseAfter) {
    adjustConcurrencyUp();
    adaptiveState.consecutiveSuccesses = 0;
  }
}

function isRateLimitError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('429') || msg.includes('1302') || msg.includes('rate limit') || msg.includes('Rate limit') || msg.includes('Too Many Requests');
}

/** Check if a string looks like an error message (not a real summary) */
function isErrorSummary(text: string): boolean {
  if (!text) return false;
  return text.startsWith('Error:') || text.startsWith('Unexpected error:') ||
    text.includes('HTTP 429') || text.includes('rate limit reached') ||
    text.includes('analysis failed:') || text.includes('MCP error');
}

// Retry config
// Retry backoff schedule: 5s, 10s, 15s, 30s, 1m, 5m, 10m, 15m, 30m, 1h (stop after ~2h total)
const RETRY_BACKOFF_MS = [
  5_000,        // 5 seconds
  15_000,       // 15 seconds
  30_000,       // 30 seconds
  60_000,       // 1 minute
  300_000,      // 5 minutes
  600_000,      // 10 minutes
  900_000,      // 15 minutes
  1_800_000,    // 30 minutes
  3_600_000,    // 1 hour
  18_000_000,   // 5 hours
];
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

type EnrichmentType = 'zai';

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
}

// Global state
const queue: EnrichmentQueueItem[] = [];
const activeRecordIds = new Set<string>(); // Dedup: prevent same attachment being processed concurrently
const processing = { zai: 0 };
const rateLimiter: RateLimitTracker = {
  zai: { lastReset: Date.now(), count: 0 },
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
  rateLimits: {
    zai: `${RATE_LIMITS.zai} req/min`,
  },
  adaptiveConcurrency: `start=${ADAPTIVE_CONCURRENCY.initial}, min=${ADAPTIVE_CONCURRENCY.min}, max=${ADAPTIVE_CONCURRENCY.max}`,
});

/**
 * Determine which enrichment method to use based on file type
 */
function selectEnrichmentType(_mimeType: string, _fileType: string): EnrichmentType {
  // Route all enrichment through Z.AI (MCP for vision/media, direct API fallback for text/docs)
  return 'zai';
}

/**
 * Check if we can make a request to the given API (respects rate limits)
 */
function canMakeRequest(apiName: 'zai'): boolean {
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
function recordRequest(apiName: 'zai'): void {
  rateLimiter[apiName].count++;
}

/**
 * Build the Z.AI prompt for summarizing an attachment
 */
function buildZaiPrompt(fileType: string, fileName: string): string {
  const base = `Provide an exhaustive, comprehensive, and extremely detailed description of this file. Leave nothing out.

Title
(A concise descriptive title)

Comprehensive Description
(A thorough, in-depth description with no length limit. Describe every element, every detail, every object, person, color, texture, background, foreground, position, expression, lighting, composition. Include any readable text, OCR content, watermarks, timestamps, captions, labels, headers, footers, URLs visible in the file. If it's a document, describe the layout, formatting, sections, and structure. If it's a photo, describe the scene as if explaining it to someone who cannot see it. Be exhaustive — more detail is always better.)

Tags
(Comma-separated relevant tags/labels — be generous, include specific and general tags)`;

  if (fileType === 'audio') {
    return `This is an audio file (${fileName}). Transcribe every word of audio content verbatim. Include speaker identification if possible, timestamps, tone, background noises, music, and any non-speech audio. Then describe the content thoroughly.\n\n${base}`;
  }
  return base;
}

function buildPluginPayloadSummary(data: {
  title?: string;
  description?: string;
  url?: string;
}): string {
  const title = data.title?.trim();
  const description = data.description?.trim();
  const url = data.url?.trim();

  if (!title && !description && !url) {
    return 'iMessage link preview card (no extractable content)';
  }

  const titlePart = title || 'Untitled';
  const descPart = description || 'No description';
  const urlPart = url || 'unknown';

  return `iMessage Link Preview: ${titlePart} — ${descPart} (URL: ${urlPart})`;
}

async function enrichPluginPayloadAttachment(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath } = item;

  const parsed = await parsePluginPayloadAttachment(attachmentPath);

  const labels = new Set<string>(['link-preview', 'imessage']);
  if (parsed.siteName) labels.add(parsed.siteName.toLowerCase());
  if (parsed.url) {
    try {
      labels.add(new URL(parsed.url).hostname.replace(/^www\./i, '').toLowerCase());
    } catch {}
  }

  const baseSummary = buildPluginPayloadSummary(parsed);

  let imageSummary = '';
  let tempPreparedCleanup: (() => void) | undefined;

  try {
    if (parsed.thumbnailPath && fs.existsSync(parsed.thumbnailPath)) {
      const prepared = await prepareImageForMcp(parsed.thumbnailPath);
      tempPreparedCleanup = prepared.cleanup;

      const client = getMcpVisionClient();
      const vision = await client.analyzeImage(
        prepared.path,
        'Describe this iMessage link preview thumbnail image in 1-2 concise sentences.'
      );

      if (vision?.trim()) {
        imageSummary = vision.trim();
        labels.add('thumbnail');
      }
    }
  } catch (err: any) {
    console.warn(`[pluginPayload] Thumbnail analysis failed for ${item.fileName}: ${err?.message || err}`);
  } finally {
    if (tempPreparedCleanup) tempPreparedCleanup();
    if (parsed.thumbnailPath) {
      try {
        fs.unlinkSync(parsed.thumbnailPath);
      } catch {}
    }
  }

  const finalSummary = imageSummary
    ? `${baseSummary}\nThumbnail analysis: ${imageSummary}`
    : baseSummary;

  await storeEnrichmentResults(recordId, {
    summary: finalSummary,
    ocr_text: parsed.rawData || null,
    labels: [...labels],
    metadata: {
      model: imageSummary ? 'plugin-payload-parser+mcp-vision' : 'plugin-payload-parser',
      analyzed_by: imageSummary ? 'plugin-payload+mcp-vision' : 'plugin-payload-parser',
      plugin_payload: {
        url: parsed.url || null,
        title: parsed.title || null,
        description: parsed.description || null,
        site_name: parsed.siteName || null,
        creator: parsed.creator || null,
      },
    },
  });
}

/**
 * Enrich attachment with Z.AI GLM Vision via MCP Server
 * 
 * For images/video: uses @z_ai/mcp-server (MCP protocol over stdio)
 * For text enrichment via Z.AI coding endpoint: uses direct API
 */
async function enrichWithZai(item: EnrichmentQueueItem): Promise<void> {
  const { attachmentPath, mimeType, fileType, fileName } = item;

  const ext = path.extname(attachmentPath).toLowerCase();

  // Special handling for iMessage link preview cards (binary plist)
  if (ext === '.pluginpayloadattachment') {
    await enrichPluginPayloadAttachment(item);
    return;
  }

  // Skip non-analyzable file types immediately (no retry)
  if (SKIP_EXTENSIONS.has(ext)) {
    const noRetry = new Error(`Skipped: ${ext} files are not analyzable media`);
    (noRetry as any).noRetry = true;
    throw noRetry;
  }

  if (!ZAI_TOKEN) {
    throw new Error('ZAI_TOKEN not configured. Set ZAI_TOKEN environment variable.');
  }

  if (!fs.existsSync(attachmentPath)) {
    throw new Error(`File not found: ${attachmentPath}`);
  }

  // PDFs: render pages as images → MCP vision per page → combine summaries
  if (fileName?.toLowerCase().endsWith('.pdf') || mimeType?.includes('pdf')) {
    await enrichPdfWithVision(item);
    return;
  }

  // Route text/documents directly through Z.AI coding API (GLM-5)
  if (fileType === 'document' || fileType === 'text') {
    await enrichWithZaiDirect(item);
    return;
  }

  // For images and video, use MCP Vision Server
  if (fileType === 'image' || fileType === 'video') {
    await enrichWithMcpVision(item);
    return;
  }

  // For audio and other media types, try MCP first, fall back to direct API
  try {
    await enrichWithMcpVision(item);
    return;
  } catch (mcpErr: any) {
    console.warn(`[MCP] Failed for ${fileName}, falling back to direct API: ${mcpErr.message}`);
  }

  // Fallback: direct Z.AI coding API for non-vision content
  await enrichWithZaiDirect(item);
}

/**
 * Enrich using MCP Vision Server (@z_ai/mcp-server)
 */
/**
 * Enrich PDF by rendering pages as images and analyzing each with MCP vision
 * Then summarize all page summaries into a final summary using GLM-5
 */
async function enrichPdfWithVision(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, fileName } = item;
  const tempDir = path.join(os.tmpdir(), `pdf-${Date.now()}-${recordId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Render PDF pages as JPEG images using pdftoppm (max 10 pages to limit API usage)
    console.log(`[pdf] Rendering pages for ${fileName}...`);
    execSync(
      `pdftoppm -jpeg -r 150 -l 10 "${attachmentPath}" "${tempDir}/page"`,
      { timeout: 60000, stdio: 'pipe' }
    );

    // Find rendered page images
    const pageFiles = fs.readdirSync(tempDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    if (pageFiles.length === 0) {
      console.warn(`[pdf] No pages rendered for ${fileName}, falling back to text`);
      await enrichWithZaiDirect(item);
      return;
    }

    console.log(`[pdf] Rendered ${pageFiles.length} pages for ${fileName}`);

    // Analyze each page with MCP vision
    const client = getMcpVisionClient();
    const pageSummaries: string[] = [];

    for (let i = 0; i < pageFiles.length; i++) {
      const pageFile = path.join(tempDir, pageFiles[i]);
      const pageNum = i + 1;

      try {
        // Resize page image if needed
        const prepared = await prepareImageForMcp(pageFile);
        try {
          const prompt = `This is page ${pageNum} of ${pageFiles.length} of a PDF document "${fileName}". Extract ALL text content from this page. Also describe any images, charts, tables, or diagrams.`;
          const summary = await client.analyzeImage(prepared.path, prompt);
          if (summary) {
            pageSummaries.push(`--- Page ${pageNum} ---\n${summary}`);
          }
        } finally {
          prepared.cleanup();
        }
      } catch (pageErr: any) {
        console.warn(`[pdf] Failed to analyze page ${pageNum}: ${pageErr.message}`);
        pageSummaries.push(`--- Page ${pageNum} ---\n[Analysis failed: ${pageErr.message}]`);
      }
    }

    // Combine page summaries into final summary using GLM-5 text API
    const allPageContent = pageSummaries.join('\n\n');
    let finalSummary: string;
    let finalLabels: string[] = ['pdf', 'document'];
    let ocrText = allPageContent;

    if (pageSummaries.length > 1) {
      // Ask GLM-5 to create a combined summary
      try {
        const combinePrompt = `You are summarizing a ${pageFiles.length}-page PDF document titled "${fileName}". Below are the extracted contents from each page. Please provide:

Title
(A concise title for this document)

Summary
(A comprehensive 3-5 sentence summary of the entire document)

Tags
(Comma-separated relevant tags/labels)

Here are the page contents:

${allPageContent}`;

        const response = await fetch(`${Z_AI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ZAI_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: Z_AI_MODEL,
            messages: [{ role: 'user', content: combinePrompt }],
          }),
        });

        if (response.ok) {
          const result = await response.json() as any;
          const content = result?.choices?.[0]?.message?.content || '';
          const parsed = parseStructuredSummary(content);
          finalSummary = parsed.title ? `${parsed.title}: ${parsed.summary}` : parsed.summary;
          if (parsed.tags.length > 0) finalLabels = [...finalLabels, ...parsed.tags];
        } else {
          finalSummary = `PDF Document (${pageFiles.length} pages): ${allPageContent.substring(0, 500)}`;
        }
      } catch {
        finalSummary = `PDF Document (${pageFiles.length} pages): ${allPageContent.substring(0, 500)}`;
      }
    } else {
      // Single page — use page summary directly
      const parsed = parseStructuredSummary(pageSummaries[0] || '');
      finalSummary = parsed.title ? `${parsed.title}: ${parsed.summary}` : parsed.summary;
      if (parsed.tags.length > 0) finalLabels = [...finalLabels, ...parsed.tags];
    }

    // Truncate OCR text if too long
    if (ocrText.length > 50000) {
      ocrText = ocrText.substring(0, 50000) + '\n\n[... truncated ...]';
    }

    // Save to DB
    await pool.query(
      `UPDATE attachments SET 
        summary_text = $1, labels = $2, ocr_text = $3,
        summary_model = $4, summary_updated_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
      WHERE record_id = $6 AND is_active = TRUE`,
      [
        finalSummary || 'PDF document (no content extracted)',
        JSON.stringify([...new Set(finalLabels)]),
        ocrText,
        Z_AI_MODEL,
        JSON.stringify({
          model: 'glm-4v-mcp + ' + Z_AI_MODEL,
          analyzed_by: 'pdf-vision-pipeline',
          pages_analyzed: pageFiles.length,
        }),
        recordId,
      ]
    );

    console.log(`[pdf] Successfully enriched ${fileName} (${pageFiles.length} pages)`);
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function enrichWithMcpVision(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, fileType, fileName } = item;
  let absolutePath = path.resolve(attachmentPath);
  let cleanup: (() => void) | undefined;

  const prompt = buildZaiPrompt(fileType, fileName);
  const client = getMcpVisionClient();

  let summaryText: string;

  try {
    if (fileType === 'video') {
      // Compress video if too large for MCP
      const compressed = await compressVideoIfNeeded(absolutePath);
      absolutePath = compressed.path;
      if (compressed.cleanup) cleanup = compressed.cleanup;
      
      summaryText = await client.analyzeVideo(absolutePath, prompt);
    } else {
      // Prepare image: convert HEIC if needed, then resize if too large
      const prepared = await prepareImageForMcp(absolutePath);
      absolutePath = prepared.path;
      cleanup = prepared.cleanup;
      
      summaryText = await client.analyzeImage(absolutePath, prompt);
    }

    if (!summaryText) {
      throw new Error('No content from MCP vision response');
    }

    const parsed = parseStructuredSummary(summaryText);

    const enrichmentData = {
      summary: parsed.title ? `${parsed.title}: ${parsed.summary}` : parsed.summary,
      ocr_text: parsed.rawContent || null,
      labels: parsed.tags,
      metadata: {
        model: 'glm-4v-mcp',
        analyzed_by: 'zai-mcp-vision',
      },
    };

    await storeEnrichmentResults(recordId, enrichmentData);
  } finally {
    // Cleanup temp resized file if created
    if (cleanup) {
      cleanup();
    }
  }
}

/**
 * Direct Z.AI coding API fallback (for non-vision content)
 */
async function enrichWithZaiDirect(item: EnrichmentQueueItem): Promise<void> {
  const { recordId, attachmentPath, mimeType, fileType, fileName } = item;

  const prompt = buildZaiPrompt(fileType, fileName);
  let userContent: any[];

  // For text-based files, read as text and send as plain text message
  const isTextBased = fileType === 'document' || fileType === 'text' ||
    mimeType?.startsWith('text/') || mimeType?.includes('pdf') ||
    mimeType?.includes('json') || mimeType?.includes('xml') ||
    fileName?.endsWith('.pdf') || fileName?.endsWith('.txt') ||
    fileName?.endsWith('.csv') || fileName?.endsWith('.json') ||
    fileName?.endsWith('.md') || fileName?.endsWith('.html');

  if (isTextBased) {
    // Read file as text (best effort — binary PDFs will be garbled but we try)
    let textContent: string;
    try {
      textContent = fs.readFileSync(attachmentPath, 'utf-8');
      // Truncate to ~8000 chars to fit in context window
      if (textContent.length > 8000) {
        textContent = textContent.substring(0, 8000) + '\n\n[... truncated ...]';
      }
    } catch {
      textContent = `[Could not read file as text: ${fileName}]`;
    }
    userContent = [
      { type: 'text', text: `${prompt}\n\nFile content (${fileName}):\n\n${textContent}` },
    ];
  } else {
    // For images/media, send as base64
    const fileBuffer = fs.readFileSync(attachmentPath);
    const base64Data = fileBuffer.toString('base64');
    const dataUrl = `data:${mimeType || 'application/octet-stream'};base64,${base64Data}`;
    userContent = [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: prompt },
    ];
  }

  const response = await fetch(`${Z_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZAI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Z_AI_MODEL,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    try {
      const errJson = JSON.parse(errorText);
      const code = errJson?.error?.code;
      if (code === 1113) {
        const noRetry = new Error(`Z.AI balance exhausted (code 1113): ${errJson?.error?.message}`);
        (noRetry as any).noRetry = true;
        throw noRetry;
      }
      if (code === 1211) {
        const noRetry = new Error(`Z.AI model not found (code 1211): ${errJson?.error?.message}`);
        (noRetry as any).noRetry = true;
        throw noRetry;
      }
    } catch (parseErr: any) {
      if (parseErr.noRetry) throw parseErr;
    }
    throw new Error(`Z.AI API error (${response.status}): ${errorText}`);
  }

  const result = await response.json() as any;
  const summaryText = result?.choices?.[0]?.message?.content || '';
  if (!summaryText) throw new Error('No content from Z.AI response');

  const parsed = parseStructuredSummary(summaryText);
  const modelUsed = result?.model || Z_AI_MODEL;

  const enrichmentData = {
    summary: parsed.title ? `${parsed.title}: ${parsed.summary}` : parsed.summary,
    ocr_text: parsed.rawContent || null,
    labels: parsed.tags,
    metadata: {
      model: modelUsed,
      analyzed_by: 'zai-glm-direct',
      zai_usage: result?.usage || null,
    },
  };

  await storeEnrichmentResults(recordId, enrichmentData);
}

/**
 * Parse structured summary format from AI response
 */
function parseStructuredSummary(text: string): {
  title: string; summary: string; tags: string[]; rawContent: string;
} {
  const titleMatch = text.match(/Title\n(.+)/);
  // Match both old "Summary" and new "Comprehensive Description" section names
  const summaryMatch = text.match(/(?:Comprehensive Description|Summary)\n([\s\S]*?)(?:\n\n(?:File Description|Tags)|$)/);
  const tagsMatch = text.match(/Tags\n(.+)/);
  const rawContentMatch = text.match(/Raw Content\n([\s\S]*?)(?:\n\nTitle|$)/);

  return {
    title: titleMatch?.[1]?.trim() || '',
    summary: summaryMatch?.[1]?.trim() || text.substring(0, 500),
    tags: tagsMatch?.[1]?.trim().split(/,\s*/).map((t: string) => t.trim()).filter(Boolean) || [],
    rawContent: rawContentMatch?.[1]?.trim() || '',
  };
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

  // Never save error messages as summaries
  if (summary && isErrorSummary(summary)) {
    console.warn(`[store] Refusing to save error message as summary for ${recordId}: ${summary.substring(0, 100)}`);
    throw new Error(`Enrichment produced error text, not a real summary: ${summary.substring(0, 100)}`);
  }

  const model = metadata?.model || metadata?.analyzed_by || 'unknown';
  const now = new Date().toISOString();
  const labelsJson = JSON.stringify(Array.isArray(labels) ? labels : []);
  const metadataJson = JSON.stringify(metadata);

  // Simple update in place (overwrite existing summary if re-enriching)
  await pool.query(
    `UPDATE attachments
     SET summary_text = $1,
         summary_model = $7,
         summary_updated_at = $5,
         ocr_text = COALESCE($2, ocr_text),
         labels = $3::jsonb,
         metadata = jsonb_set(COALESCE(metadata, '{}'), '{enrichment_metadata}', $4::jsonb),
         updated_at = $5
     WHERE record_id = $6::uuid AND is_active = true`,
    [summary, ocr_text, labelsJson, metadataJson, now, recordId, model]
  );
}

/**
 * Process next item in the queue (for a specific API)
 */
async function processNextItem(
  apiName: 'zai'
): Promise<void> {
  // Find next item for this API
  const itemIdx = queue.findIndex(item => item.enrichmentType === 'zai');

  if (itemIdx === -1) return; // No items for this API

  const item = queue[itemIdx];
  const startTime = Date.now();

  try {
    console.log(`[${apiName}] Starting enrichment for ${item.recordId} (${item.fileName})`);

    await enrichWithZai(item);

    // Success
    const duration = Date.now() - startTime;
    queue.splice(itemIdx, 1);
    activeRecordIds.delete(item.recordId);
    recordSuccess();
    console.log(
      `[${apiName}] Successfully enriched ${item.recordId} in ${duration}ms (concurrency: ${adaptiveState.current})`
    );
    item.resolve();
  } catch (err: any) {
    const error = err as Error;
    item.lastError = error.message;
    const duration = Date.now() - startTime;

    // Check for rate limit errors → adjust concurrency down
    if (isRateLimitError(err)) {
      adjustConcurrencyDown();
    }

    // Check if error is non-retryable
    const isNoRetry = (err as any).noRetry === true;

    if (!isNoRetry && item.retries < MAX_RETRIES) {
      // Retry with exponential backoff
      const backoffMs = RETRY_BACKOFF_MS[item.retries] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      item.retries++;
      const backoffLabel = backoffMs >= 60000 ? `${(backoffMs / 60000).toFixed(0)}m` : `${(backoffMs / 1000).toFixed(0)}s`;
      console.warn(
        `[${apiName}] Retry scheduled for ${item.recordId} (attempt ${item.retries}/${MAX_RETRIES}) in ${backoffLabel}. Error: ${error.message}`
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
      activeRecordIds.delete(item.recordId);
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
  // Process Z.AI queue — spin up workers up to adaptive concurrency limit
  while (
    processing.zai < adaptiveState.current &&
    canMakeRequest('zai') &&
    queue.some(item => item.enrichmentType === 'zai')
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
    // Dedup: skip if already queued or being processed
    if (activeRecordIds.has(recordId)) {
      console.log(`[dedup] Skipping ${recordId} (${fileName}) — already in queue/processing`);
      resolve();
      return;
    }
    activeRecordIds.add(recordId);

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
    },
    adaptiveConcurrency: {
      current: adaptiveState.current,
      min: ADAPTIVE_CONCURRENCY.min,
      max: ADAPTIVE_CONCURRENCY.max,
      increment: ADAPTIVE_CONCURRENCY.increaseFactor,
      maxReached: adaptiveState.maxReached,
      consecutiveSuccesses: adaptiveState.consecutiveSuccesses,
      totalSuccesses: adaptiveState.totalSuccesses,
      totalRateLimitHits: adaptiveState.totalRateLimitHits,
      recentHistory: adaptiveState.history.slice(-10),
    },
    rateLimits: {
      zai: {
        used: rateLimiter.zai.count,
        limit: RATE_LIMITS.zai,
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

export function getQueueItems() {
  return queue.slice(0, 50).map(item => ({
    recordId: item.recordId,
    fileName: item.fileName,
    fileType: item.fileType,
    retries: item.retries,
    enrichmentType: item.enrichmentType,
    createdAt: item.createdAt,
  }));
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
    activeRecordIds.delete(item.recordId);
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

/**
 * Update adaptive concurrency settings
 */
export function updateAdaptiveSettings(settings: {
  current?: number;
  min?: number;
  max?: number;
  increment?: number;
}): { current: number; min: number; max: number; increment: number } {
  if (settings.min !== undefined) {
    ADAPTIVE_CONCURRENCY.min = Math.max(1, settings.min);
  }
  if (settings.max !== undefined) {
    ADAPTIVE_CONCURRENCY.max = Math.max(ADAPTIVE_CONCURRENCY.min, settings.max);
  }
  if (settings.increment !== undefined) {
    ADAPTIVE_CONCURRENCY.increaseFactor = Math.max(1, settings.increment);
  }
  if (settings.current !== undefined) {
    adaptiveState.current = Math.max(ADAPTIVE_CONCURRENCY.min, Math.min(settings.current, ADAPTIVE_CONCURRENCY.max));
  }
  // Clamp current to new bounds
  adaptiveState.current = Math.max(ADAPTIVE_CONCURRENCY.min, Math.min(adaptiveState.current, ADAPTIVE_CONCURRENCY.max));
  adaptiveState.history.push({ time: Date.now(), concurrency: adaptiveState.current, reason: 'manual adjustment' });
  console.log(`[adaptive] Settings updated: current=${adaptiveState.current}, min=${ADAPTIVE_CONCURRENCY.min}, max=${ADAPTIVE_CONCURRENCY.max}, increment=${ADAPTIVE_CONCURRENCY.increaseFactor}`);
  return {
    current: adaptiveState.current,
    min: ADAPTIVE_CONCURRENCY.min,
    max: ADAPTIVE_CONCURRENCY.max,
    increment: ADAPTIVE_CONCURRENCY.increaseFactor,
  };
}

/**
 * Shutdown MCP vision server (call on app shutdown)
 */
export function shutdownEnrichments(): void {
  shutdownMcpVisionClient();
}
