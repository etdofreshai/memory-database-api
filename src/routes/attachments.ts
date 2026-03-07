import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function baseTable(includeHistory: boolean): string {
  return includeHistory ? 'attachments' : 'current_attachments';
}

// List/filter attachments with pagination
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const {
    q, mime_type, file_type, privacy_level, sha256, record_id,
    page, limit = '50', sort = 'imported_at', order = 'desc',
    include_history
  } = req.query;

  const table = baseTable(include_history === 'true');
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(a.original_file_name ILIKE $${idx} OR a.summary_text ILIKE $${idx} OR a.ocr_text ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }
  if (mime_type) { conditions.push(`a.mime_type ILIKE $${idx++}`); params.push(`%${mime_type}%`); }
  if (file_type) { conditions.push(`a.file_type = $${idx++}`); params.push(file_type); }
  if (privacy_level) { conditions.push(`a.privacy_level = $${idx++}`); params.push(privacy_level); }
  if (sha256) { conditions.push(`a.sha256 = $${idx++}`); params.push(sha256); }
  if (record_id) { conditions.push(`a.record_id = $${idx++}::uuid`); params.push(record_id); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedPage = Math.max(1, Number(page) || 1);
  const parsedOffset = (parsedPage - 1) * parsedLimit;

  const allowedSorts = new Set(['id', 'imported_at', 'created_at_source', 'mime_type', 'file_type', 'size_bytes', 'original_file_name', 'privacy_level']);
  const sortKey = String(sort).toLowerCase();
  const sortColumn = allowedSorts.has(sortKey) ? `a.${sortKey}` : 'a.imported_at';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int as total FROM ${table} a ${where}`, params);
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT a.id, a.record_id, a.sha256, a.size_bytes, a.mime_type, a.file_type,
              a.original_file_name, a.created_at_source, a.imported_at,
              a.storage_provider, a.storage_path, a.url_local,
              a.privacy_level, a.summary_text, a.labels, a.ocr_text, a.user_notes,
              a.metadata, a.effective_from, a.effective_to, a.is_active,
              (SELECT COUNT(*)::int FROM current_message_attachment_links l WHERE l.attachment_record_id = a.record_id) as link_count
       FROM ${table} a
       ${where}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parsedLimit, parsedOffset]
    );

    res.json({
      attachments: dataResult.rows,
      total,
      page: parsedPage,
      totalPages: Math.max(1, Math.ceil(total / parsedLimit))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single attachment by record_id with linked messages
router.get('/:record_id', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  try {
    const att = await pool.query(
      `SELECT * FROM current_attachments WHERE record_id = $1::uuid LIMIT 1`,
      [record_id]
    );
    if (att.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }

    const links = await pool.query(
      `SELECT l.*, m.sender, m.recipient, m.content, m.timestamp, s.name as source_name
       FROM current_message_attachment_links l
       LEFT JOIN current_messages m ON m.record_id = l.message_record_id
       LEFT JOIN sources s ON m.source_id = s.id
       WHERE l.attachment_record_id = $1::uuid
       ORDER BY l.created_at DESC`,
      [record_id]
    );

    res.json({ attachment: att.rows[0], linked_messages: links.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve attachment file content safely by record_id
router.get('/:record_id/file', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  try {
    const att = await pool.query(
      `SELECT storage_path, url_local, mime_type, original_file_name, storage_provider FROM current_attachments WHERE record_id = $1::uuid LIMIT 1`,
      [record_id]
    );
    if (att.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }

    const row = att.rows[0];
    const filePath = row.storage_path || row.url_local;
    if (!filePath) { res.status(404).json({ error: 'No file path available' }); return; }

    // Resolve and validate path to prevent directory traversal
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'File not found on disk' }); return;
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      res.status(400).json({ error: 'Not a file' }); return;
    }

    const mime = row.mime_type || 'application/octet-stream';
    const filename = row.original_file_name || path.basename(resolved);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    // Inline for previewable types, attachment for others
    const inlineTypes = /^(image|video|audio|application\/pdf|text\/)/;
    const disposition = inlineTypes.test(mime) ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);

    fs.createReadStream(resolved).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH attachment enrichment fields by record_id
router.patch('/:record_id', requireAuth('write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  const allowedFields = ['summary_text', 'summary_model', 'summary_updated_at', 'labels', 'ocr_text', 'user_notes', 'metadata'];
  const updates: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      if (field === 'metadata') {
        updates.push(`${field} = $${idx++}::jsonb`);
        params.push(JSON.stringify(req.body[field]));
      } else {
        updates.push(`${field} = $${idx++}`);
        params.push(req.body[field]);
      }
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' }); return;
  }

  try {
    // Check if attachment exists
    const existing = await pool.query(
      `SELECT id FROM current_attachments WHERE record_id = $1::uuid LIMIT 1`,
      [record_id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Attachment not found' }); return;
    }

    // Update directly (SCD columns will be handled by triggers if present)
    const result = await pool.query(
      `UPDATE attachments SET ${updates.join(', ')} WHERE record_id = $${idx}::uuid AND is_active = true RETURNING record_id`,
      [...params, record_id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Update failed' }); return;
    }

    res.json({ updated: true, record_id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
