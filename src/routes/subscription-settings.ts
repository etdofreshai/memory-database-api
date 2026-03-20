import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_SERVICES = ['discord', 'slack', 'chatgpt', 'anthropic', 'openclaw', 'imessage', 'gmail'];

function isValidService(service: string): boolean {
  return VALID_SERVICES.includes(service);
}

function getString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return '';
}

// GET /api/subscriptions/settings — get all service settings
router.get('/', requireAuth('read', 'write', 'admin'), async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT service, auto_subscribe, updated_at FROM subscription_settings ORDER BY service'
    );
    res.json({ settings: result.rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/subscriptions/settings/:service — get setting for one service
router.get('/:service', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    const result = await pool.query(
      'SELECT service, auto_subscribe, updated_at FROM subscription_settings WHERE service = $1',
      [service]
    );

    if (result.rows.length === 0) {
      // Return default (not set yet)
      res.json({ service, auto_subscribe: false, updated_at: null });
      return;
    }

    res.json(result.rows[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// PUT /api/subscriptions/settings/:service — set auto_subscribe for a service
router.put('/:service', requireAuth('write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    const { auto_subscribe } = req.body;
    if (typeof auto_subscribe !== 'boolean') {
      res.status(400).json({ error: 'auto_subscribe must be a boolean' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO subscription_settings (service, auto_subscribe, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (service) DO UPDATE SET auto_subscribe = $2, updated_at = NOW()
       RETURNING service, auto_subscribe, updated_at`,
      [service, auto_subscribe]
    );

    res.json(result.rows[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
