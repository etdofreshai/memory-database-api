import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function buildWhereClause(params: Record<string, any>): { where: string; values: any[] } {
  const conditions = ['m.effective_to IS NULL', 'm.is_active = TRUE'];
  const values: any[] = [];
  let idx = 1;

  if (params.source_id) {
    conditions.push(`m.source_id = $${idx++}`);
    values.push(Number(params.source_id));
  }
  if (params.channel) {
    conditions.push(`m.recipient ILIKE $${idx++}`);
    values.push(`%${params.channel}%`);
  }
  if (params.sender) {
    conditions.push(`m.sender ILIKE $${idx++}`);
    values.push(`%${params.sender}%`);
  }
  if (params.date_from) {
    conditions.push(`m.timestamp >= $${idx++}`);
    values.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push(`m.timestamp <= $${idx++}`);
    values.push(params.date_to);
  }

  return { where: conditions.join(' AND '), values };
}

/**
 * GET /api/cleanup/stats
 */
router.get('/stats', requireAuth('admin'), async (req, res) => {
  try {
    const { where, values } = buildWhereClause(req.query);

    // Source breakdown
    const sourcesResult = await pool.query(`
      SELECT s.id as source_id, s.name as source_name,
        COUNT(DISTINCT m.id)::int as count,
        COUNT(DISTINCT mal.attachment_record_id)::int as attachment_count
      FROM messages m
      JOIN sources s ON s.id = m.source_id
      LEFT JOIN message_attachment_links mal ON mal.message_record_id = m.record_id
        AND mal.effective_to IS NULL AND mal.is_active = TRUE
      WHERE ${where}
      GROUP BY s.id, s.name
      ORDER BY count DESC
    `, values);

    // Channel breakdown (recipient field) — names resolved client-side via /api/discord/channels
    const channelsResult = await pool.query(`
      SELECT s.name as source_name, m.source_id, m.recipient as channel,
        COUNT(DISTINCT m.id)::int as count,
        COUNT(DISTINCT mal.attachment_record_id)::int as attachment_count
      FROM messages m
      JOIN sources s ON s.id = m.source_id
      LEFT JOIN message_attachment_links mal ON mal.message_record_id = m.record_id
        AND mal.effective_to IS NULL AND mal.is_active = TRUE
      WHERE ${where}
      GROUP BY s.name, m.source_id, m.recipient
      ORDER BY count DESC
      LIMIT 200
    `, values);

    // Sender breakdown
    const sendersResult = await pool.query(`
      SELECT m.sender,
        COUNT(DISTINCT m.id)::int as count,
        COUNT(DISTINCT mal.attachment_record_id)::int as attachment_count
      FROM messages m
      LEFT JOIN message_attachment_links mal ON mal.message_record_id = m.record_id
        AND mal.effective_to IS NULL AND mal.is_active = TRUE
      WHERE ${where}
      GROUP BY m.sender
      ORDER BY count DESC
      LIMIT 200
    `, values);

    // Total counts
    const totalsResult = await pool.query(`
      SELECT COUNT(*)::int as total_messages
      FROM messages m
      WHERE ${where}
    `, values);

    // Attachment count for filtered messages
    const attachResult = await pool.query(`
      SELECT COUNT(DISTINCT mal.attachment_record_id)::int as total_attachments
      FROM messages m
      JOIN message_attachment_links mal ON mal.message_record_id = m.record_id
        AND mal.effective_to IS NULL AND mal.is_active = TRUE
      WHERE ${where}
    `, values);

    // Date range buckets
    const dateResult = await pool.query(`
      SELECT 
        date_trunc('month', m.timestamp)::date as month,
        COUNT(*)::int as count
      FROM messages m
      WHERE ${where}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 60
    `, values);

    res.json({
      total_messages: totalsResult.rows[0]?.total_messages || 0,
      total_attachments: attachResult.rows[0]?.total_attachments || 0,
      sources: sourcesResult.rows,
      channels: channelsResult.rows,
      senders: sendersResult.rows,
      date_buckets: dateResult.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cleanup/preview
 */
router.get('/preview', requireAuth('admin'), async (req, res) => {
  try {
    const { where, values } = buildWhereClause(req.query);

    // Messages that would be deleted
    const msgResult = await pool.query(`
      SELECT COUNT(*)::int as message_count
      FROM messages m
      WHERE ${where}
    `, values);

    // Attachments that would be orphaned (linked ONLY to these messages)
    const orphanResult = await pool.query(`
      WITH target_messages AS (
        SELECT m.record_id FROM messages m WHERE ${where}
      ),
      target_attachment_ids AS (
        SELECT DISTINCT mal.attachment_record_id
        FROM message_attachment_links mal
        WHERE mal.message_record_id IN (SELECT record_id FROM target_messages)
          AND mal.effective_to IS NULL AND mal.is_active = TRUE
      ),
      non_orphans AS (
        SELECT DISTINCT mal.attachment_record_id
        FROM message_attachment_links mal
        WHERE mal.attachment_record_id IN (SELECT attachment_record_id FROM target_attachment_ids)
          AND mal.message_record_id NOT IN (SELECT record_id FROM target_messages)
          AND mal.effective_to IS NULL AND mal.is_active = TRUE
      )
      SELECT
        (SELECT COUNT(*)::int FROM target_attachment_ids) as total_linked,
        (SELECT COUNT(*)::int FROM target_attachment_ids WHERE attachment_record_id NOT IN (SELECT attachment_record_id FROM non_orphans)) as orphaned_attachments
    `, values);

    // Link count
    const linkResult = await pool.query(`
      SELECT COUNT(*)::int as link_count
      FROM message_attachment_links mal
      WHERE mal.message_record_id IN (
        SELECT m.record_id FROM messages m WHERE ${where}
      ) AND mal.effective_to IS NULL AND mal.is_active = TRUE
    `, values);

    // Breakdown by source
    const sourcesBreakdown = await pool.query(`
      SELECT s.name, COUNT(*)::int as count
      FROM messages m JOIN sources s ON s.id = m.source_id
      WHERE ${where}
      GROUP BY s.name ORDER BY count DESC
    `, values);

    // Breakdown by channel (top 20)
    const channelsBreakdown = await pool.query(`
      SELECT m.recipient as channel, COUNT(*)::int as count
      FROM messages m
      WHERE ${where}
      GROUP BY m.recipient ORDER BY count DESC LIMIT 20
    `, values);

    // Breakdown by sender (top 10)
    const sendersBreakdown = await pool.query(`
      SELECT m.sender, COUNT(*)::int as count
      FROM messages m
      WHERE ${where}
      GROUP BY m.sender ORDER BY count DESC LIMIT 10
    `, values);

    // Date range
    const dateRange = await pool.query(`
      SELECT MIN(m.timestamp) as earliest, MAX(m.timestamp) as latest
      FROM messages m
      WHERE ${where}
    `, values);

    // Sample messages (first 5)
    const sampleMessages = await pool.query(`
      SELECT m.id, m.sender, LEFT(m.content, 200) as content, m.timestamp, s.name as source
      FROM messages m JOIN sources s ON s.id = m.source_id
      WHERE ${where}
      ORDER BY m.timestamp ASC LIMIT 5
    `, values);

    res.json({
      messages: msgResult.rows[0]?.message_count || 0,
      links: linkResult.rows[0]?.link_count || 0,
      orphaned_attachments: orphanResult.rows[0]?.orphaned_attachments || 0,
      total_linked_attachments: orphanResult.rows[0]?.total_linked || 0,
      breakdown: {
        sources: sourcesBreakdown.rows,
        channels: channelsBreakdown.rows,
        senders: sendersBreakdown.rows,
        dateRange: {
          earliest: dateRange.rows[0]?.earliest || null,
          latest: dateRange.rows[0]?.latest || null,
        },
      },
      sampleMessages: sampleMessages.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cleanup/delete
 */
router.delete('/delete', requireAuth('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const params = { ...req.query, ...req.body };
    const { where, values } = buildWhereClause(params);

    // Safety: require at least one filter
    if (!params.source_id && !params.channel && !params.sender && !params.date_from && !params.date_to) {
      res.status(400).json({ error: 'At least one filter is required to prevent accidental full deletion' });
      return;
    }

    await client.query('BEGIN');

    // 1. Find target message record_ids
    const targetMessages = await client.query(`
      SELECT m.id, m.record_id FROM messages m WHERE ${where}
    `, values);
    const messageIds = targetMessages.rows.map((r: any) => r.id);
    const messageRecordIds = targetMessages.rows.map((r: any) => r.record_id);

    if (messageIds.length === 0) {
      await client.query('ROLLBACK');
      res.json({ deleted: { messages: 0, links: 0, attachments: 0 } });
      return;
    }

    // 2. Find orphaned attachment record_ids
    const orphanResult = await client.query(`
      WITH target_attachment_ids AS (
        SELECT DISTINCT mal.attachment_record_id
        FROM message_attachment_links mal
        WHERE mal.message_record_id = ANY($1)
          AND mal.effective_to IS NULL AND mal.is_active = TRUE
      ),
      non_orphans AS (
        SELECT DISTINCT mal.attachment_record_id
        FROM message_attachment_links mal
        WHERE mal.attachment_record_id IN (SELECT attachment_record_id FROM target_attachment_ids)
          AND mal.message_record_id != ALL($1)
          AND mal.effective_to IS NULL AND mal.is_active = TRUE
      )
      SELECT attachment_record_id FROM target_attachment_ids
      WHERE attachment_record_id NOT IN (SELECT attachment_record_id FROM non_orphans)
    `, [messageRecordIds]);
    const orphanedAttachmentIds = orphanResult.rows.map((r: any) => r.attachment_record_id);

    // 3. Delete links for target messages
    const linkDel = await client.query(`
      DELETE FROM message_attachment_links
      WHERE message_record_id = ANY($1)
    `, [messageRecordIds]);

    // 4. Delete orphaned attachments (all versions)
    let attachDel: { rowCount: number | null } = { rowCount: 0 };
    if (orphanedAttachmentIds.length > 0) {
      attachDel = await client.query(`
        DELETE FROM attachments WHERE record_id = ANY($1)
      `, [orphanedAttachmentIds]);
    }

    // 5. Delete messages
    const msgDel = await client.query(`
      DELETE FROM messages WHERE id = ANY($1)
    `, [messageIds]);

    await client.query('COMMIT');

    res.json({
      deleted: {
        messages: msgDel.rowCount ?? 0,
        links: linkDel.rowCount ?? 0,
        attachments: attachDel.rowCount ?? 0,
      }
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/cleanup/orphaned-attachments
 */
router.get('/orphaned-attachments', requireAuth('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*)::int as count,
        COALESCE(SUM(a.size_bytes), 0)::bigint as total_bytes,
        COUNT(CASE WHEN a.mime_type ILIKE 'image/%' THEN 1 END)::int as images,
        COUNT(CASE WHEN a.mime_type ILIKE 'video/%' THEN 1 END)::int as videos,
        COUNT(CASE WHEN a.mime_type ILIKE 'audio/%' THEN 1 END)::int as audio,
        COUNT(CASE WHEN a.mime_type NOT ILIKE 'image/%' AND a.mime_type NOT ILIKE 'video/%' AND a.mime_type NOT ILIKE 'audio/%' THEN 1 END)::int as other
      FROM current_attachments a
      WHERE NOT EXISTS (
        SELECT 1 FROM current_message_attachment_links mal
        WHERE mal.attachment_record_id = a.record_id
      )
    `);
    const row = result.rows[0];
    res.json({
      count: row.count,
      total_bytes: Number(row.total_bytes),
      images: row.images,
      videos: row.videos,
      audio: row.audio,
      other: row.other,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cleanup/orphaned-attachments
 */
router.delete('/orphaned-attachments', requireAuth('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM attachments
      WHERE record_id IN (
        SELECT a.record_id FROM current_attachments a
        WHERE NOT EXISTS (
          SELECT 1 FROM current_message_attachment_links mal
          WHERE mal.attachment_record_id = a.record_id
        )
      )
    `);
    res.json({ deleted: result.rowCount ?? 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

