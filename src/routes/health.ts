import { Router } from 'express';
import pool from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      capabilities: {
        message_conflict_modes: ['skip_existing', 'skip_or_append', 'skip_or_overwrite'],
      },
    });
  } catch {
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});

export default router;
