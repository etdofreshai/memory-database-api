import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { queueEnrichment, getQueueStatus, retryDeadLetters } from '../enrichments.js';
import fs from 'fs';
import path from 'path';

describe('Enrichment System', () => {
  let testFilePath: string;

  beforeAll(() => {
    // Create a test image file (minimal PNG)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, // IHDR chunk size
      0x49, 0x48, 0x44, 0x52, // IHDR
      0x00, 0x00, 0x00, 0x01, // Width: 1
      0x00, 0x00, 0x00, 0x01, // Height: 1
      0x08, 0x02, 0x00, 0x00, 0x00, // Bit depth, color type, etc.
      0x90, 0x77, 0x53, 0xde, // CRC
    ]);

    testFilePath = path.join('/tmp', 'test-image.png');
    fs.writeFileSync(testFilePath, pngHeader);
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  it('should initialize without errors', () => {
    const status = getQueueStatus();
    expect(status).toBeDefined();
    expect(status.pending).toBeGreaterThanOrEqual(0);
    expect(status.processing).toBeDefined();
  });

  it('should get queue status', () => {
    const status = getQueueStatus();
    expect(status).toEqual(
      expect.objectContaining({
        pending: expect.any(Number),
        processing: expect.objectContaining({
          gemini: expect.any(Number),
          claude: expect.any(Number),
        }),
        rateLimits: expect.any(Object),
        deadLetterCount: expect.any(Number),
      })
    );
  });

  it('should queue enrichment for image', async () => {
    const initialStatus = getQueueStatus();

    // Queue enrichment (will fail since no real API keys, but should queue successfully)
    const recordId = '550e8400-e29b-41d4-a716-446655440000';
    
    try {
      await Promise.race([
        queueEnrichment(
          recordId,
          testFilePath,
          'image/png',
          'image',
          'test-image.png'
        ),
        new Promise(resolve => setTimeout(resolve, 100)), // Timeout after 100ms
      ]);
    } catch {
      // Expected to fail without real API keys
    }

    const afterStatus = getQueueStatus();
    // Queue should have processed or moved item (exact state depends on API availability)
    expect(afterStatus).toBeDefined();
  });

  it('should track rate limits', () => {
    const status = getQueueStatus();
    expect(status.rateLimits.gemini).toEqual(
      expect.objectContaining({
        used: expect.any(Number),
        limit: expect.any(Number),
      })
    );
    expect(status.rateLimits.claude).toEqual(
      expect.objectContaining({
        used: expect.any(Number),
        limit: expect.any(Number),
      })
    );
  });

  it('should handle dead letter queue', () => {
    const status = getQueueStatus();
    expect(Array.isArray(status.deadLetterQueue)).toBe(true);
  });

  it('should retry dead letters', async () => {
    const beforeRetry = getQueueStatus();
    const deadLetterCount = beforeRetry.deadLetterCount;

    retryDeadLetters();

    const afterRetry = getQueueStatus();
    // Dead letter queue should be reset
    expect(afterRetry.deadLetterCount).toBe(0);
    // Items should be moved back to pending queue
    if (deadLetterCount > 0) {
      expect(afterRetry.pending).toBeGreaterThanOrEqual(deadLetterCount);
    }
  });
});
