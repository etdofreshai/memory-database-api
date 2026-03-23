import { Router } from 'express';
import pool from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

function baseTable(includeHistory: boolean): string {
  return includeHistory ? 'transactions' : 'current_transactions';
}

// List/filter transactions with pagination
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const {
    source_id, category, subcategory, merchant, account_name, account_type,
    transaction_type, status, date_from, date_to, currency,
    q, page, limit = '50', offset, sort = 'date', order = 'desc',
    include_history
  } = req.query;

  const table = baseTable(include_history === 'true');
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (source_id) { conditions.push(`t.source_id = $${idx++}`); params.push(Number(source_id)); }
  if (category) { conditions.push(`t.category ILIKE $${idx++}`); params.push(`%${category}%`); }
  if (subcategory) { conditions.push(`t.subcategory ILIKE $${idx++}`); params.push(`%${subcategory}%`); }
  if (merchant) { conditions.push(`t.merchant ILIKE $${idx++}`); params.push(`%${merchant}%`); }
  if (account_name) { conditions.push(`t.account_name ILIKE $${idx++}`); params.push(`%${account_name}%`); }
  if (account_type) { conditions.push(`t.account_type = $${idx++}`); params.push(account_type); }
  if (transaction_type) { conditions.push(`t.transaction_type = $${idx++}`); params.push(transaction_type); }
  if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
  if (currency) { conditions.push(`t.currency = $${idx++}`); params.push(currency); }
  if (date_from) { conditions.push(`t.date >= $${idx++}`); params.push(date_from); }
  if (date_to) { conditions.push(`t.date <= $${idx++}`); params.push(date_to); }
  if (q) {
    conditions.push(`(t.merchant ILIKE $${idx} OR t.category ILIKE $${idx} OR t.notes ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedPage = Math.max(1, Number(page) || 1);
  const parsedOffset = offset !== undefined ? Math.max(0, Number(offset) || 0) : (parsedPage - 1) * parsedLimit;

  const allowedSorts = new Set(['id', 'date', 'amount', 'merchant', 'category', 'account_name', 'created_at']);
  const sortKey = String(sort).toLowerCase();
  const sortColumn = allowedSorts.has(sortKey) ? `t.${sortKey}` : 't.date';
  const sortOrder = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int as total FROM ${table} t ${where}`, params
    );
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT t.*, s.name as source_name
       FROM ${table} t
       LEFT JOIN sources s ON t.source_id = s.id
       ${where}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parsedLimit, parsedOffset]
    );

    const totalPages = Math.max(1, Math.ceil(total / parsedLimit));
    const currentPage = Math.floor(parsedOffset / parsedLimit) + 1;

    res.json({ transactions: dataResult.rows, total, page: currentPage, totalPages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stats: aggregations by category, by month
router.get('/stats', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { date_from, date_to, account_name } = req.query;
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (date_from) { conditions.push(`date >= $${idx++}`); params.push(date_from); }
  if (date_to) { conditions.push(`date <= $${idx++}`); params.push(date_to); }
  if (account_name) { conditions.push(`account_name ILIKE $${idx++}`); params.push(`%${account_name}%`); }

  const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

  try {
    const byCategory = await pool.query(
      `SELECT category, COUNT(*)::int as count, SUM(amount)::numeric as total_amount
       FROM current_transactions
       WHERE category IS NOT NULL ${where}
       GROUP BY category ORDER BY total_amount DESC`,
      params
    );

    const byMonth = await pool.query(
      `SELECT to_char(date, 'YYYY-MM') as month, COUNT(*)::int as count, SUM(amount)::numeric as total_amount
       FROM current_transactions
       WHERE true ${where}
       GROUP BY to_char(date, 'YYYY-MM') ORDER BY month DESC`,
      params
    );

    const summary = await pool.query(
      `SELECT COUNT(*)::int as total_count, SUM(amount)::numeric as total_amount,
              AVG(amount)::numeric as avg_amount, MIN(date) as earliest_date, MAX(date) as latest_date
       FROM current_transactions
       WHERE true ${where}`,
      params
    );

    res.json({
      by_category: byCategory.rows,
      by_month: byMonth.rows,
      summary: summary.rows[0]
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single transaction by record_id
router.get('/:record_id', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.*, s.name as source_name
       FROM current_transactions t
       LEFT JOIN sources s ON t.source_id = s.id
       WHERE t.record_id = $1::uuid LIMIT 1`,
      [record_id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Transaction not found' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create/upsert transaction (SCD Type 2)
router.post('/', requireAuth('write', 'admin'), async (req: AuthRequest, res) => {
  const {
    source, source_id: bodySrcId, external_id, date, amount, currency, merchant,
    category, subcategory, account_name, account_type, transaction_type,
    status, notes, tags, metadata
  } = req.body;

  if (!date || amount === undefined) {
    res.status(400).json({ error: 'date and amount are required' }); return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve source_id
    let source_id = bodySrcId ? Number(bodySrcId) : null;
    if (!source_id && source) {
      let sourceResult = await client.query('SELECT id FROM sources WHERE name = $1', [source]);
      if (sourceResult.rows.length === 0) {
        sourceResult = await client.query('INSERT INTO sources (name) VALUES ($1) RETURNING id', [source]);
      }
      source_id = sourceResult.rows[0].id;
    }

    const tagsJson = tags ? JSON.stringify(tags) : '[]';
    const metaJson = metadata ? JSON.stringify(metadata) : '{}';

    // SCD Type 2 upsert by source_id + external_id
    if (external_id && source_id) {
      const existing = await client.query(
        `SELECT id, record_id, amount, merchant, category, subcategory, account_name, account_type,
                transaction_type, status, notes, tags, metadata
         FROM transactions
         WHERE source_id = $1 AND external_id = $2 AND effective_to IS NULL AND is_active = TRUE
         LIMIT 1`,
        [source_id, external_id]
      );

      if (existing.rows.length > 0) {
        const old = existing.rows[0];

        // Check if anything changed
        const unchanged = (
          String(old.amount) === String(amount) &&
          old.merchant === (merchant || null) &&
          old.category === (category || null) &&
          old.subcategory === (subcategory || null) &&
          old.account_name === (account_name || null) &&
          old.account_type === (account_type || null) &&
          old.transaction_type === (transaction_type || null) &&
          old.status === (status || 'posted') &&
          old.notes === (notes || null)
        );

        if (unchanged) {
          await client.query('COMMIT');
          client.release();
          const fullRow = await pool.query(
            `SELECT t.*, s.name as source_name FROM transactions t LEFT JOIN sources s ON t.source_id = s.id WHERE t.id = $1`,
            [old.id]
          );
          res.status(200).json({ ...fullRow.rows[0], action: 'skipped' });
          return;
        }

        // Close old version
        const now = new Date().toISOString();
        await client.query(`UPDATE transactions SET effective_to = $1, updated_at = NOW() WHERE id = $2`, [now, old.id]);

        // Insert new version with same record_id
        const result = await client.query(
          `INSERT INTO transactions (record_id, source_id, external_id, date, amount, currency, merchant,
            category, subcategory, account_name, account_type, transaction_type, status, notes, tags, metadata, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17) RETURNING *`,
          [old.record_id, source_id, external_id, date, amount, currency || 'USD', merchant,
           category, subcategory, account_name, account_type, transaction_type, status || 'posted',
           notes, tagsJson, metaJson, now]
        );

        await client.query('COMMIT');
        client.release();
        res.status(201).json({ ...result.rows[0], action: 'appended' });
        return;
      }
    }

    // New record
    const result = await client.query(
      `INSERT INTO transactions (source_id, external_id, date, amount, currency, merchant,
        category, subcategory, account_name, account_type, transaction_type, status, notes, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb) RETURNING *`,
      [source_id, external_id, date, amount, currency || 'USD', merchant,
       category, subcategory, account_name, account_type, transaction_type, status || 'posted',
       notes, tagsJson, metaJson]
    );

    await client.query('COMMIT');
    client.release();
    res.status(201).json({ ...result.rows[0], action: 'inserted' });

  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    res.status(500).json({ error: err.message });
  }
});

export default router;
