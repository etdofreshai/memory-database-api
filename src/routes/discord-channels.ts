import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const DISCORD_INGESTOR_URL = (process.env.DISCORD_INGESTOR_URL ?? 'http://localhost:3456').replace(/\/+$/, '');

// In-memory cache with 5-minute TTL
let cachedChannels: any = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/discord/channels — proxy to Discord ingestor's channel cache
 */
router.get('/', requireAuth('read'), async (_req, res) => {
  try {
    const now = Date.now();
    if (cachedChannels && now - cachedAt < CACHE_TTL_MS) {
      res.json(cachedChannels);
      return;
    }

    const response = await fetch(`${DISCORD_INGESTOR_URL}/api/channels`);
    if (!response.ok) {
      throw new Error(`Ingestor returned ${response.status}`);
    }

    cachedChannels = await response.json();
    cachedAt = now;
    res.json(cachedChannels);
  } catch (err: any) {
    // Return stale cache if available
    if (cachedChannels) {
      res.json(cachedChannels);
      return;
    }
    res.status(502).json({ error: `Failed to fetch channels from ingestor: ${err.message}` });
  }
});

export default router;
