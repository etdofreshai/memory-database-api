import { Router } from 'express';
import pool from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Search messages
router.get('/search', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { q, limit = '20', offset = '0' } = req.query;
  if (!q) { res.status(400).json({ error: 'q parameter required' }); return; }
  try {
    const result = await pool.query(
      `SELECT m.*, s.name as source_name FROM messages m
       LEFT JOIN sources s ON m.source_id = s.id
       WHERE m.content ILIKE $1
       ORDER BY m.timestamp DESC LIMIT $2 OFFSET $3`,
      [`%${q}%`, Number(limit), Number(offset)]
    );
    res.json({ messages: result.rows, total: result.rowCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Vector search
router.get('/vector-search', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { embedding, limit = 10 } = req.body || {};
  if (!embedding || !Array.isArray(embedding)) {
    res.status(400).json({ error: 'embedding array required in body' }); return;
  }
  try {
    const vecStr = `[${embedding.join(',')}]`;
    const result = await pool.query(
      `SELECT m.*, s.name as source_name,
       m.embedding <=> $1::vector as distance
       FROM messages m
       LEFT JOIN sources s ON m.source_id = s.id
       WHERE m.embedding IS NOT NULL
       ORDER BY m.embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, Number(limit)]
    );
    res.json({ messages: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List/filter messages with pagination + sorting + search
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const {
    source,
    sender,
    after,
    before,
    q,
    page,
    limit = '20',
    offset,
    sort = 'timestamp',
    order = 'desc'
  } = req.query;

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (source) { conditions.push(`s.name = $${idx++}`); params.push(source); }
  if (sender) { conditions.push(`m.sender ILIKE $${idx++}`); params.push(`%${sender}%`); }
  if (after) { conditions.push(`m.timestamp >= $${idx++}`); params.push(after); }
  if (before) { conditions.push(`m.timestamp <= $${idx++}`); params.push(before); }
  if (q) {
    conditions.push(`(m.content ILIKE $${idx} OR m.sender ILIKE $${idx} OR m.recipient ILIKE $${idx})`);
    params.push(`%${q}%`);
    idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const parsedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const parsedPage = Math.max(1, Number(page) || 1);
  const parsedOffset = offset !== undefined ? Math.max(0, Number(offset) || 0) : (parsedPage - 1) * parsedLimit;

  const allowedSorts = new Set(['id', 'timestamp', 'sender', 'recipient', 'content', 'source']);
  const sortKey = String(sort).toLowerCase();
  const sortColumn = !allowedSorts.has(sortKey)
    ? 'm.timestamp'
    : sortKey === 'source'
      ? 's.name'
      : `m.${sortKey}`;

  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM messages m
       LEFT JOIN sources s ON m.source_id = s.id
       ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT m.*, s.name as source_name FROM messages m
       LEFT JOIN sources s ON m.source_id = s.id
       ${where}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parsedLimit, parsedOffset]
    );

    const totalPages = Math.max(1, Math.ceil(total / parsedLimit));
    const currentPage = Math.floor(parsedOffset / parsedLimit) + 1;

    res.json({
      messages: dataResult.rows,
      total,
      page: currentPage,
      totalPages
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create message
router.post('/', requireAuth('write', 'admin'), async (req: AuthRequest, res) => {
  const { source, sender, recipient, content, timestamp, external_id, metadata } = req.body;
  if (!source || !content) {
    res.status(400).json({ error: 'source and content required' }); return;
  }

  // Check write scope
  if (req.token!.permissions === 'write' && req.token!.write_sources) {
    if (!req.token!.write_sources.includes(source)) {
      res.status(403).json({ error: `Token not authorized to write to source: ${source}` }); return;
    }
  }

  try {
    // Get or verify source
    let sourceResult = await pool.query('SELECT id FROM sources WHERE name = $1', [source]);
    if (sourceResult.rows.length === 0) {
      sourceResult = await pool.query('INSERT INTO sources (name) VALUES ($1) RETURNING id', [source]);
    }
    const source_id = sourceResult.rows[0].id;

    const result = await pool.query(
      `INSERT INTO messages (source_id, sender, recipient, content, timestamp, external_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [source_id, sender, recipient, content, timestamp || new Date().toISOString(), external_id, metadata ? JSON.stringify(metadata) : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
