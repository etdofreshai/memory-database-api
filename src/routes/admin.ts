import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/tokens', requireAuth('admin'), async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, label, permissions, write_sources, created_at, last_used_at, is_active FROM api_tokens ORDER BY created_at DESC'
    );
    res.json({ tokens: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tokens', requireAuth('admin'), async (req, res) => {
  const { label, permissions, write_sources } = req.body;
  if (!label || !permissions || !['read', 'write', 'admin'].includes(permissions)) {
    res.status(400).json({ error: 'label and valid permissions (read/write/admin) required' }); return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const result = await pool.query(
      'INSERT INTO api_tokens (token, label, permissions, write_sources) VALUES ($1, $2, $3, $4) RETURNING id, token, label, permissions, write_sources, created_at',
      [token, label, permissions, write_sources || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/tokens/:id', requireAuth('admin'), async (req, res) => {
  const { id } = req.params;
  const { label, permissions, write_sources, is_active } = req.body;
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (label !== undefined) { sets.push(`label = $${idx++}`); params.push(label); }
  if (permissions !== undefined) { sets.push(`permissions = $${idx++}`); params.push(permissions); }
  if (write_sources !== undefined) { sets.push(`write_sources = $${idx++}`); params.push(write_sources); }
  if (is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(is_active); }
  if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(id);
  try {
    const result = await pool.query(
      `UPDATE api_tokens SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, label, permissions, write_sources, is_active`,
      params
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Token not found' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tokens/:id', requireAuth('admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE api_tokens SET is_active = false WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Token not found' }); return; }
    res.json({ message: 'Token deactivated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
