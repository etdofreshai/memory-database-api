import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth('read', 'write', 'admin'), async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM people ORDER BY name');
    res.json({ people: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
