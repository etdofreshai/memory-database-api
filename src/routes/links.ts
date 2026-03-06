import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function baseTable(includeHistory: boolean): string {
  return includeHistory ? 'message_attachment_links' : 'current_message_attachment_links';
}

// List/filter links with pagination
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const {
    message_record_id, attachment_record_id, provider, provider_message_id, provider_attachment_id,
    role, q,
    page, limit = '50', sort = 'created_at', order = 'desc',
    include_history
  } = req.query;

  const table = baseTable(include_history === 'true');
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (message_record_id) { conditions.push(`l.message_record_id = $${idx++}::uuid`); params.push(message_record_id); }
  if (attachment_record_id) { conditions.push(`l.attachment_record_id = $${idx++}::uuid`); params.push(attachment_record_id); }
  if (provider) { conditions.push(`l.provider = $${idx++}`); params.push(provider); }
  if (provider_message_id) { conditions.push(`l.provider_message_id = $${idx++}`); params.push(provider_message_id); }
  if (provider_attachment_id) { conditions.push(`l.provider_attachment_id = $${idx++}`); params.push(provider_attachment_id); }
  if (role) { conditions.push(`l.role = $${idx++}`); params.push(role); }
  if (q) {
    conditions.push(`(l.provider ILIKE $${idx} OR l.provider_message_id ILIKE $${idx} OR l.provider_attachment_id ILIKE $${idx} OR l.role ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedPage = Math.max(1, Number(page) || 1);
  const parsedOffset = (parsedPage - 1) * parsedLimit;

  const allowedSorts = new Set(['id', 'created_at', 'provider', 'role', 'ordinal']);
  const sortKey = String(sort).toLowerCase();
  const sortColumn = allowedSorts.has(sortKey) ? `l.${sortKey}` : 'l.created_at';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int as total FROM ${table} l ${where}`, params);
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT l.*,
              m.sender as msg_sender, m.recipient as msg_recipient,
              LEFT(m.content, 120) as msg_preview, m.timestamp as msg_timestamp,
              s.name as msg_source,
              a.original_file_name as att_filename, a.mime_type as att_mime, a.file_type as att_file_type
       FROM ${table} l
       LEFT JOIN current_messages m ON m.record_id = l.message_record_id
       LEFT JOIN sources s ON m.source_id = s.id
       LEFT JOIN current_attachments a ON a.record_id = l.attachment_record_id
       ${where}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parsedLimit, parsedOffset]
    );

    res.json({
      links: dataResult.rows,
      total,
      page: parsedPage,
      totalPages: Math.max(1, Math.ceil(total / parsedLimit))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
