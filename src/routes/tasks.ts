import { Router } from 'express';
import pool from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = Router();

function baseTable(includeHistory: boolean): string {
  return includeHistory ? 'tasks' : 'current_tasks';
}

// List/filter tasks with pagination
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const {
    source_id, status, project, assignee, reporter, priority,
    due_before, due_after, q,
    page, limit = '50', offset, sort = 'created_at', order = 'desc',
    include_history
  } = req.query;

  const table = baseTable(include_history === 'true');
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (source_id) { conditions.push(`t.source_id = $${idx++}`); params.push(Number(source_id)); }
  if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
  if (project) { conditions.push(`t.project ILIKE $${idx++}`); params.push(`%${project}%`); }
  if (assignee) { conditions.push(`t.assignee ILIKE $${idx++}`); params.push(`%${assignee}%`); }
  if (reporter) { conditions.push(`t.reporter ILIKE $${idx++}`); params.push(`%${reporter}%`); }
  if (priority) { conditions.push(`t.priority = $${idx++}`); params.push(priority); }
  if (due_before) { conditions.push(`t.due_date <= $${idx++}`); params.push(due_before); }
  if (due_after) { conditions.push(`t.due_date >= $${idx++}`); params.push(due_after); }
  if (q) {
    conditions.push(`(t.title ILIKE $${idx} OR t.description ILIKE $${idx})`);
    params.push(`%${q}%`); idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const parsedPage = Math.max(1, Number(page) || 1);
  const parsedOffset = offset !== undefined ? Math.max(0, Number(offset) || 0) : (parsedPage - 1) * parsedLimit;

  const allowedSorts = new Set(['id', 'title', 'status', 'priority', 'due_date', 'created_at', 'completed_at', 'project', 'assignee']);
  const sortKey = String(sort).toLowerCase();
  const sortColumn = allowedSorts.has(sortKey) ? `t.${sortKey}` : 't.created_at';
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

    res.json({ tasks: dataResult.rows, total, page: currentPage, totalPages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task by record_id
router.get('/:record_id', requireAuth('read', 'write', 'admin'), async (req, res) => {
  const { record_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.*, s.name as source_name
       FROM current_tasks t
       LEFT JOIN sources s ON t.source_id = s.id
       WHERE t.record_id = $1::uuid LIMIT 1`,
      [record_id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create/upsert task (SCD Type 2)
router.post('/', requireAuth('write', 'admin'), async (req: AuthRequest, res) => {
  const {
    source, source_id: bodySrcId, external_id, title, description,
    status, priority, assignee, reporter, project, labels,
    due_date, completed_at, external_url, parent_task_id, metadata
  } = req.body;

  if (!title) {
    res.status(400).json({ error: 'title is required' }); return;
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

    const labelsJson = labels ? JSON.stringify(labels) : '[]';
    const metaJson = metadata ? JSON.stringify(metadata) : '{}';

    // SCD Type 2 upsert by source_id + external_id
    if (external_id && source_id) {
      const existing = await client.query(
        `SELECT id, record_id, title, description, status, priority, assignee, reporter,
                project, labels, due_date, completed_at, external_url, parent_task_id, metadata
         FROM tasks
         WHERE source_id = $1 AND external_id = $2 AND effective_to IS NULL AND is_active = TRUE
         LIMIT 1`,
        [source_id, external_id]
      );

      if (existing.rows.length > 0) {
        const old = existing.rows[0];

        // Check if anything changed
        const unchanged = (
          old.title === title &&
          old.description === (description || null) &&
          old.status === (status || 'open') &&
          old.priority === (priority || null) &&
          old.assignee === (assignee || null) &&
          old.reporter === (reporter || null) &&
          old.project === (project || null)
        );

        if (unchanged) {
          await client.query('COMMIT');
          client.release();
          const fullRow = await pool.query(
            `SELECT t.*, s.name as source_name FROM tasks t LEFT JOIN sources s ON t.source_id = s.id WHERE t.id = $1`,
            [old.id]
          );
          res.status(200).json({ ...fullRow.rows[0], action: 'skipped' });
          return;
        }

        // Close old version
        const now = new Date().toISOString();
        await client.query(`UPDATE tasks SET effective_to = $1, updated_at = NOW() WHERE id = $2`, [now, old.id]);

        // Insert new version with same record_id
        const result = await client.query(
          `INSERT INTO tasks (record_id, source_id, external_id, title, description, status, priority,
            assignee, reporter, project, labels, due_date, completed_at, external_url, parent_task_id, metadata, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17) RETURNING *`,
          [old.record_id, source_id, external_id, title, description, status || 'open', priority,
           assignee, reporter, project, labelsJson, due_date, completed_at, external_url,
           parent_task_id, metaJson, now]
        );

        await client.query('COMMIT');
        client.release();
        res.status(201).json({ ...result.rows[0], action: 'appended' });
        return;
      }
    }

    // New record
    const result = await client.query(
      `INSERT INTO tasks (source_id, external_id, title, description, status, priority,
        assignee, reporter, project, labels, due_date, completed_at, external_url, parent_task_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::jsonb) RETURNING *`,
      [source_id, external_id, title, description, status || 'open', priority,
       assignee, reporter, project, labelsJson, due_date, completed_at, external_url,
       parent_task_id, metaJson]
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
