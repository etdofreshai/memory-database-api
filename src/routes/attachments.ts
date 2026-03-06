import { Router } from 'express';
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

export default router;
