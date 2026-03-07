import { Router } from 'express';
import fs from 'fs';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { queueEnrichment, getQueueStatus, retryDeadLetters } from '../enrichments.js';

const router = Router();

/**
 * GET /api/enrichments/queue-status
 * Get current queue status and rate limiting info
 */
router.get('/queue-status', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const status = getQueueStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enrichments/enrich-attachment/:record_id
 * Manually trigger enrichment for a specific attachment
 */
router.post('/enrich-attachment/:record_id', requireAuth('write', 'admin'), async (req, res) => {
  const record_id = String(req.params.record_id);

  try {
    // Get attachment metadata
    const att = await pool.query(
      `SELECT storage_path, mime_type, file_type, original_file_name 
       FROM current_attachments 
       WHERE record_id = $1::uuid LIMIT 1`,
      [record_id]
    );

    if (att.rows.length === 0) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    const attachment = att.rows[0] as any;
    const storagePath = String(attachment.storage_path || attachment.url_local || '');

    if (!storagePath || !fs.existsSync(storagePath)) {
      res.status(404).json({ error: 'Attachment file not found' });
      return;
    }

    // Queue enrichment
    queueEnrichment(
      record_id,
      storagePath,
      String(attachment.mime_type || 'application/octet-stream'),
      String(attachment.file_type || 'file'),
      String(attachment.original_file_name || 'unknown')
    ).then(() => {
      res.json({
        queued: true,
        record_id,
        message: 'Enrichment queued successfully',
      });
    }).catch(err => {
      res.status(400).json({
        error: 'Failed to queue enrichment',
        details: err.message,
      });
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enrichments/enrich-all
 * Trigger enrichment for all attachments that don't have summary_text yet
 */
router.post('/enrich-all', requireAuth('write', 'admin'), async (req, res) => {
  try {
    const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit || '100';
    const fileTypeParam = Array.isArray(req.query.file_type) ? req.query.file_type[0] : req.query.file_type;
    const parsedLimit = Math.max(1, Math.min(Number(limitParam) || 100, 1000));

    // Get unenriched attachments
    const query = fileTypeParam
      ? `SELECT record_id, storage_path, mime_type, file_type, original_file_name
         FROM current_attachments
         WHERE summary_text IS NULL AND file_type = $1
         LIMIT $2`
      : `SELECT record_id, storage_path, mime_type, file_type, original_file_name
         FROM current_attachments
         WHERE summary_text IS NULL
         LIMIT $1`;

    const params = fileTypeParam ? [fileTypeParam, parsedLimit] : [parsedLimit];
    const result = await pool.query(query, params);

    const attachments = result.rows;
    let queued = 0;
    let failed = 0;
    const errors: any[] = [];

    for (const att of attachments) {
      const storagePath = String(att.storage_path || att.url_local || '');
      if (!storagePath || !fs.existsSync(storagePath)) {
        failed++;
        errors.push({
          record_id: att.record_id,
          error: 'File not found on disk',
        });
        continue;
      }

      try {
        await queueEnrichment(
          String(att.record_id),
          storagePath,
          String(att.mime_type || 'application/octet-stream'),
          String(att.file_type || 'file'),
          String(att.original_file_name || 'unknown')
        );
        queued++;
      } catch (err: any) {
        failed++;
        errors.push({
          record_id: att.record_id,
          error: err.message,
        });
      }
    }

    res.json({
      total: attachments.length,
      queued,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/enrichments/retry-failed
 * Retry all items in the dead letter queue
 */
router.post('/retry-failed', requireAuth('write', 'admin'), async (req, res) => {
  try {
    const status = getQueueStatus();
    const deadLetterCount = status.deadLetterCount;

    retryDeadLetters();

    const newStatus = getQueueStatus();
    res.json({
      retried: deadLetterCount,
      newQueueLength: newStatus.pending,
      message: `${deadLetterCount} failed items moved back to queue`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
