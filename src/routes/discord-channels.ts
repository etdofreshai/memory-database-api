import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/discord/channels — return all stored channel mappings
 */
router.get('/', requireAuth('read'), async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT channel_id, channel_name, guild_id, guild_name, updated_at FROM discord_channels ORDER BY guild_name, channel_name'
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/discord/channels — upsert channel metadata (single or batch)
 * Accepts: { channelId, channelName, guildId, guildName }
 * Or an array of the same.
 */
router.post('/', requireAuth('write'), async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let upserted = 0;

    for (const item of items) {
      const { channelId, channelName, guildId, guildName } = item;
      if (!channelId) continue;

      await pool.query(
        `INSERT INTO discord_channels (channel_id, channel_name, guild_id, guild_name, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id) DO UPDATE SET
           channel_name = COALESCE(EXCLUDED.channel_name, discord_channels.channel_name),
           guild_id = COALESCE(EXCLUDED.guild_id, discord_channels.guild_id),
           guild_name = COALESCE(EXCLUDED.guild_name, discord_channels.guild_name),
           updated_at = NOW()`,
        [channelId, channelName || null, guildId || null, guildName || null]
      );
      upserted++;
    }

    res.json({ upserted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
