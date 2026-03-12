import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/chatgpt/conversations/stats
// Returns message count and last message timestamp per conversation ID
router.get('/conversations/stats', requireAuth('read', 'write', 'admin'), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        metadata->>'conversationId' AS conversation_id,
        COUNT(*) AS message_count,
        MAX(timestamp) AS last_message_at
      FROM messages
      WHERE source_id = (SELECT id FROM sources WHERE name = 'chatgpt')
        AND metadata->>'conversationId' IS NOT NULL
        AND (effective_to IS NULL OR is_active = TRUE)
      GROUP BY metadata->>'conversationId'
    `);

    const stats: Record<string, { messageCount: number; lastMessageAt: string | null }> = {};
    for (const row of result.rows) {
      stats[row.conversation_id] = {
        messageCount: parseInt(row.message_count, 10),
        lastMessageAt: row.last_message_at ? row.last_message_at.toISOString() : null,
      };
    }

    res.json({ stats });
  } catch (err: any) {
    console.error('Error fetching chatgpt conversation stats:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
