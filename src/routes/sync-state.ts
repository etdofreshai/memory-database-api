import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Get sync state by key
router.get('/:key', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { key } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM sync_state WHERE key = $1 LIMIT 1`,
      [key]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upsert sync state
router.put('/:key', requireAuth('write', 'admin'), async (req, res) => {
  const { key } = req.params;
  const { source, last_sync_date, last_record_date, total_records, last_run_at, error_message, metadata } = req.body;

  if (!source) { res.status(400).json({ error: 'source is required' }); return; }

  try {
    const result = await pool.query(
      `INSERT INTO sync_state (key, source, last_sync_date, last_record_date, total_records, last_run_at, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         source = EXCLUDED.source,
         last_sync_date = COALESCE(EXCLUDED.last_sync_date, sync_state.last_sync_date),
         last_record_date = COALESCE(EXCLUDED.last_record_date, sync_state.last_record_date),
         total_records = COALESCE(EXCLUDED.total_records, sync_state.total_records),
         last_run_at = COALESCE(EXCLUDED.last_run_at, sync_state.last_run_at),
         error_message = EXCLUDED.error_message,
         metadata = COALESCE(EXCLUDED.metadata, sync_state.metadata),
         updated_at = NOW()
       RETURNING *`,
      [key, source, last_sync_date || null, last_record_date || null, total_records ?? null, last_run_at || null, error_message ?? null, metadata ? JSON.stringify(metadata) : null]
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
