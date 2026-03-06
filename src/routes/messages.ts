import { Router } from 'express';
import pool from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { generateEmbedding } from '../embeddings.js';

const router = Router();

// Helper: base table or current_messages view depending on include_history param
function baseTable(includeHistory: boolean): string {
  return includeHistory ? 'messages' : 'current_messages';
}

// Search messages
router.get('/search', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { q, limit = '20', offset = '0', include_history } = req.query;
  if (!q) { res.status(400).json({ error: 'q parameter required' }); return; }
  const table = baseTable(include_history === 'true');
  try {
    const result = await pool.query(
      `SELECT m.*, s.name as source_name FROM ${table} m
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
  const q = (req.body?.q ?? req.query?.q ?? '').toString().trim();
  const limit = Number(req.body?.limit ?? req.query?.limit ?? 10);
  const includeHistory = (req.body?.include_history ?? req.query?.include_history) === 'true';

  if (!q) {
    res.status(400).json({ error: 'q is required' }); return;
  }

  try {
    const embedding = await generateEmbedding(q);
    const vecStr = `[${embedding.join(',')}]`;

    const table = baseTable(includeHistory);
    const result = await pool.query(
      `SELECT m.*, s.name as source_name,
       m.embedding <=> $1::vector as distance
       FROM ${table} m
       LEFT JOIN sources s ON m.source_id = s.id
       WHERE m.embedding IS NOT NULL
       ORDER BY m.embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, Math.max(1, Math.min(limit || 10, 200))]
    );

    res.json({ messages: result.rows });
  } catch (err: any) {
    const msg = err?.message || 'Embedding generation failed';
    const status = msg.includes('Ollama') ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

// Get linked attachments for a message by record_id
router.get('/:record_id/attachments', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT l.*, a.original_file_name, a.mime_type, a.file_type, a.size_bytes,
              a.privacy_level, a.summary_text, a.sha256, a.storage_provider,
              a.url_local, a.imported_at
       FROM current_message_attachment_links l
       LEFT JOIN current_attachments a ON a.record_id = l.attachment_record_id
       WHERE l.message_record_id = $1::uuid
       ORDER BY l.ordinal ASC NULLS LAST, l.created_at ASC`,
      [record_id]
    );
    res.json({ attachments: result.rows, total: result.rowCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get version history for a record
router.get('/:record_id/history', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(record_id))) {
    res.status(400).json({ error: 'Invalid record_id format (must be UUID)' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT m.*, s.name as source_name FROM messages m
       LEFT JOIN sources s ON m.source_id = s.id
       WHERE m.record_id = $1
       ORDER BY m.effective_from ASC`,
      [record_id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No messages found for this record_id' });
      return;
    }
    res.json({ versions: result.rows, total: result.rowCount });
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
    order = 'desc',
    include_history
  } = req.query;

  const table = baseTable(include_history === 'true');
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
      `SELECT COUNT(*)::int as total FROM ${table} m
       LEFT JOIN sources s ON m.source_id = s.id
       ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT m.id, m.source_id, m.sender, m.recipient, m.content, m.timestamp, m.metadata,
              m.external_id, m.created_at, m.record_id, m.effective_from, m.effective_to, m.is_active,
              s.name as source_name,
              CASE WHEN m.embedding IS NOT NULL THEN LEFT(m.embedding::text, 60) ELSE NULL END as embedding_preview,
              CASE
                WHEN m.record_id IS NULL THEN 0
                ELSE (SELECT COUNT(*)::int FROM messages mv WHERE mv.record_id = m.record_id)
              END as version_count
       FROM ${table} m
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

// Create message (with SCD Type 2 upsert)
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create source
    let sourceResult = await client.query('SELECT id FROM sources WHERE name = $1', [source]);
    if (sourceResult.rows.length === 0) {
      sourceResult = await client.query('INSERT INTO sources (name) VALUES ($1) RETURNING id', [source]);
    }
    const source_id = sourceResult.rows[0].id;

    const ts = timestamp || new Date().toISOString();
    const meta = metadata ? JSON.stringify(metadata) : null;

    // SCD Type 2 upsert logic
    if (external_id) {
      // Look for an existing current version with same external_id + source_id
      const existing = await client.query(
        `SELECT id, record_id, content FROM messages
         WHERE source_id = $1 AND external_id = $2 AND effective_to IS NULL
         LIMIT 1`,
        [source_id, external_id]
      );

      if (existing.rows.length > 0) {
        const old = existing.rows[0];

        // Content unchanged — skip, return existing row
        if (old.content === content) {
          await client.query('COMMIT');
          client.release();

          // Fetch full row for response
          const fullRow = await pool.query(
            `SELECT m.*, s.name as source_name FROM messages m
             LEFT JOIN sources s ON m.source_id = s.id
             WHERE m.id = $1`,
            [old.id]
          );
          res.status(200).json(fullRow.rows[0]);
          return;
        }

        // Content changed — close old version, insert new version
        const now = new Date().toISOString();

        // Close old row
        await client.query(
          `UPDATE messages SET effective_to = $1 WHERE id = $2`,
          [now, old.id]
        );

        // Insert new version with same record_id
        const result = await client.query(
          `INSERT INTO messages (source_id, sender, recipient, content, timestamp, external_id, metadata, record_id, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [source_id, sender, recipient, content, ts, external_id, meta, old.record_id, now]
        );

        await client.query('COMMIT');
        client.release();

        const newRow = result.rows[0];
        res.status(201).json(newRow);

        // Generate embedding in background
        generateEmbedding(content).then(embedding => {
          if (embedding) {
            pool.query('UPDATE messages SET embedding = $1 WHERE id = $2', [`[${embedding.join(',')}]`, newRow.id])
              .catch(err => console.warn('Failed to save embedding:', err.message));
          }
        }).catch(err => console.warn('Failed to generate embedding:', err.message));

        return;
      }
    }

    // No existing version found, or no external_id — insert as new record
    const result = await client.query(
      `INSERT INTO messages (source_id, sender, recipient, content, timestamp, external_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [source_id, sender, recipient, content, ts, external_id, meta]
    );

    await client.query('COMMIT');
    client.release();

    res.status(201).json(result.rows[0]);

    // Generate embedding in background
    generateEmbedding(content).then(embedding => {
      if (embedding) {
        pool.query('UPDATE messages SET embedding = $1 WHERE id = $2', [`[${embedding.join(',')}]`, result.rows[0].id])
          .catch(err => console.warn('Failed to save embedding:', err.message));
      }
    }).catch(err => console.warn('Failed to generate embedding:', err.message));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();

    // Handle unique constraint violation for concurrent inserts with same external_id
    if (err.code === '23505' && external_id) {
      // Retry: another request inserted the same external_id concurrently
      // Return the existing row
      try {
        const existingResult = await pool.query(
          `SELECT m.*, s.name as source_name FROM messages m
           LEFT JOIN sources s ON m.source_id = s.id
           WHERE m.external_id = $1 AND m.source_id = (SELECT id FROM sources WHERE name = $2) AND m.effective_to IS NULL
           LIMIT 1`,
          [external_id, source]
        );
        if (existingResult.rows.length > 0) {
          res.status(200).json(existingResult.rows[0]);
          return;
        }
      } catch {}
    }

    res.status(500).json({ error: err.message });
  }
});

export default router;
