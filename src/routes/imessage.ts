import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/imessage/conversations
 * Returns conversation list sorted by most recent message.
 * Query params: ?q=search&limit=50&offset=0
 */
router.get('/conversations', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { q, limit = '50', offset = '0' } = req.query;
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedOffset = Math.max(0, Number(offset) || 0);

  try {
    // Get the imessage source id
    const sourceResult = await pool.query("SELECT id FROM sources WHERE name = 'imessage'");
    if (sourceResult.rows.length === 0) {
      res.json({ conversations: [], total: 0 });
      return;
    }
    const sourceId = sourceResult.rows[0].id;

    // Build the conversation query.
    // A "conversation" is identified by the "other party":
    //   - If sender = 'me', the other party is recipient
    //   - If recipient = 'me', the other party is sender
    //   - For groups, the chat_identifier is in metadata
    // We use a CTE to compute conversation_id per message, then aggregate.
    const searchCondition = q
      ? `AND (m.content ILIKE $4 OR m.sender ILIKE $4 OR m.recipient ILIKE $4)`
      : '';
    const params: any[] = [sourceId, parsedLimit, parsedOffset];
    if (q) params.push(`%${q}%`);

    const query = `
      WITH conversation_messages AS (
        SELECT
          m.id,
          m.record_id,
          m.sender,
          m.recipient,
          m.content,
          m.timestamp,
          m.metadata,
          CASE
            WHEN m.metadata->>'is_group' = 'true' THEN COALESCE(m.metadata->>'chat_identifier', m.recipient)
            WHEN m.sender = 'me' THEN m.recipient
            WHEN m.recipient = 'me' THEN m.sender
            ELSE COALESCE(m.recipient, m.sender, 'unknown')
          END AS conversation_id,
          CASE
            WHEN m.metadata->>'is_group' = 'true' THEN true
            ELSE false
          END AS is_group
        FROM current_messages m
        WHERE m.source_id = $1
        ${searchCondition}
      ),
      ranked AS (
        SELECT
          conversation_id,
          is_group,
          content AS last_message,
          sender AS last_sender,
          timestamp AS last_timestamp,
          metadata,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC) as rn,
          COUNT(*) OVER (PARTITION BY conversation_id) as message_count
        FROM conversation_messages
      )
      SELECT
        conversation_id,
        is_group,
        last_message,
        last_sender,
        last_timestamp,
        message_count,
        metadata->>'display_name' as display_name,
        metadata->>'participants' as participants
      FROM ranked
      WHERE rn = 1
      ORDER BY last_timestamp DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, params);

    // Get total count of conversations
    const countQuery = `
      SELECT COUNT(DISTINCT
        CASE
          WHEN m.metadata->>'is_group' = 'true' THEN COALESCE(m.metadata->>'chat_identifier', m.recipient)
          WHEN m.sender = 'me' THEN m.recipient
          WHEN m.recipient = 'me' THEN m.sender
          ELSE COALESCE(m.recipient, m.sender, 'unknown')
        END
      )::int as total
      FROM current_messages m
      WHERE m.source_id = $1
      ${q ? "AND (m.content ILIKE $2 OR m.sender ILIKE $2 OR m.recipient ILIKE $2)" : ''}
    `;
    const countParams: any[] = [sourceId];
    if (q) countParams.push(`%${q}%`);
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      conversations: result.rows,
      total: countResult.rows[0]?.total || 0
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/imessage/messages/:conversationId
 * Returns messages for a specific conversation.
 * Query params: ?limit=100&offset=0&before=ISO_DATE&after=ISO_DATE
 */
router.get('/messages/:conversationId', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { conversationId } = req.params;
  const { limit = '100', offset = '0', before, after } = req.query;
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const parsedOffset = Math.max(0, Number(offset) || 0);

  try {
    const sourceResult = await pool.query("SELECT id FROM sources WHERE name = 'imessage'");
    if (sourceResult.rows.length === 0) {
      res.json({ messages: [], total: 0 });
      return;
    }
    const sourceId = sourceResult.rows[0].id;

    // Build conditions to match messages belonging to this conversation
    const conditions: string[] = ['m.source_id = $1'];
    const params: any[] = [sourceId];
    let idx = 2;

    // Match conversation by:
    // 1. Group chats: metadata->chat_identifier matches
    // 2. 1:1 chats: sender or recipient matches conversationId
    conditions.push(`(
      (m.metadata->>'chat_identifier' = $${idx} OR m.metadata->>'chat_identifier' IS NULL)
      AND (
        (m.metadata->>'is_group' = 'true' AND COALESCE(m.metadata->>'chat_identifier', m.recipient) = $${idx})
        OR (
          (m.metadata->>'is_group' IS DISTINCT FROM 'true')
          AND (
            (m.sender = 'me' AND m.recipient = $${idx})
            OR (m.recipient = 'me' AND m.sender = $${idx})
          )
        )
      )
    )`);
    params.push(conversationId);
    idx++;

    if (before) {
      conditions.push(`m.timestamp < $${idx++}`);
      params.push(before);
    }
    if (after) {
      conditions.push(`m.timestamp > $${idx++}`);
      params.push(after);
    }

    const where = conditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM current_messages m WHERE ${where}`,
      params
    );

    // Get messages (ordered oldest first for chat view)
    const messagesResult = await pool.query(
      `SELECT m.id, m.record_id, m.sender, m.recipient, m.content, m.timestamp, m.metadata
       FROM current_messages m
       WHERE ${where}
       ORDER BY m.timestamp DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parsedLimit, parsedOffset]
    );

    // Get attachments for these messages
    const messageRecordIds = messagesResult.rows
      .map(m => m.record_id)
      .filter(Boolean);

    let attachmentMap: Record<string, any[]> = {};
    if (messageRecordIds.length > 0) {
      const placeholders = messageRecordIds.map((_, i) => `$${i + 1}::uuid`).join(',');
      const attResult = await pool.query(
        `SELECT l.message_record_id, a.record_id, a.original_file_name, a.mime_type, a.file_type, a.size_bytes, a.summary_text
         FROM current_message_attachment_links l
         JOIN current_attachments a ON a.record_id = l.attachment_record_id
         WHERE l.message_record_id IN (${placeholders})
         ORDER BY l.ordinal ASC NULLS LAST`,
        messageRecordIds
      );
      for (const att of attResult.rows) {
        const key = att.message_record_id;
        if (!attachmentMap[key]) attachmentMap[key] = [];
        attachmentMap[key].push(att);
      }
    }

    // Attach attachments to messages
    const messages = messagesResult.rows.map(m => ({
      ...m,
      attachments: attachmentMap[m.record_id] || []
    }));

    // Reverse to get chronological order (we fetched DESC for pagination)
    messages.reverse();

    res.json({
      messages,
      total: countResult.rows[0]?.total || 0,
      conversationId
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/imessage/contacts
 * Returns a mapping of phone/email to known names from the people table
 */
router.get('/contacts', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, aliases, metadata FROM people WHERE aliases IS NOT NULL`
    );
    const contacts: Record<string, string> = {};
    for (const row of result.rows) {
      if (row.aliases) {
        for (const alias of row.aliases) {
          contacts[alias] = row.name;
        }
      }
      // Also check metadata for phone/email
      if (row.metadata?.phone) {
        contacts[row.metadata.phone] = row.name;
      }
      if (row.metadata?.email) {
        contacts[row.metadata.email] = row.name;
      }
    }
    res.json({ contacts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
