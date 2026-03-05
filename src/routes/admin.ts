import { Router } from 'express';
import crypto from 'crypto';
import { promisify } from 'util';
import { execFile } from 'child_process';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { generateEmbedding } from '../embeddings.js';

const router = Router();

type EmbeddingSample = {
  id: number;
  content_preview: string;
  embedding_preview: number[];
};

type BackfillState = {
  isRunning: boolean;
  currentBatch: number;
  totalBatches: number;
  processed: number;
  errorsCount: number;
  errors: string[];
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  recentSamples: EmbeddingSample[];
  logs: string[];
};

const backfillState: BackfillState = {
  isRunning: false,
  currentBatch: 0,
  totalBatches: 0,
  processed: 0,
  errorsCount: 0,
  errors: [],
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  recentSamples: [],
  logs: []
};

const execFileAsync = promisify(execFile);

function pushLog(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  backfillState.logs.push(line);
  if (backfillState.logs.length > 200) {
    backfillState.logs = backfillState.logs.slice(-200);
  }
}

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

router.get('/embeddings/status', requireAuth('admin'), async (_req, res) => {
  try {
    // Count only current (non-superseded, active) messages for embedding stats
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(embedding)::int AS embedded,
        (COUNT(*) - COUNT(embedding))::int AS remaining
      FROM messages
      WHERE effective_to IS NULL AND is_active = TRUE
    `);

    const total = result.rows[0]?.total || 0;
    const embedded = result.rows[0]?.embedded || 0;
    const remaining = result.rows[0]?.remaining || 0;
    const percentage = total > 0 ? Number(((embedded / total) * 100).toFixed(2)) : 0;

    res.json({
      total,
      embedded,
      remaining,
      percentage,
      isRunning: backfillState.isRunning,
      currentBatch: backfillState.currentBatch,
      totalBatches: backfillState.totalBatches,
      processed: backfillState.processed,
      errorsCount: backfillState.errorsCount,
      errors: backfillState.errors,
      logs: backfillState.logs,
      recentSamples: backfillState.recentSamples,
      lastRunStartedAt: backfillState.lastRunStartedAt,
      lastRunFinishedAt: backfillState.lastRunFinishedAt
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

type DockerContainerStats = {
  id: string;
  name: string;
  size: string;
};

async function getDockerContainerStats(): Promise<{ ok: boolean; data?: DockerContainerStats; error?: string }> {
  const hostname = process.env.HOSTNAME || '';

  try {
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '-a',
      '--size',
      '--format',
      '{{json .}}'
    ]);

    const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const containers = lines
      .map(line => {
        try {
          return JSON.parse(line) as { ID?: string; Names?: string; Size?: string };
        } catch {
          return null;
        }
      })
      .filter((row): row is { ID?: string; Names?: string; Size?: string } => row !== null);

    const match = containers.find(row => hostname && row.ID?.startsWith(hostname))
      || containers.find(row => row.Names?.includes('memory-database-api'))
      || null;

    if (!match) {
      return { ok: false, error: 'Container not found in docker ps output' };
    }

    return {
      ok: true,
      data: {
        id: match.ID || '',
        name: match.Names || '',
        size: match.Size || ''
      }
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unable to query docker container stats' };
  }
}

router.get('/stats', requireAuth('admin'), async (_req, res) => {
  try {
    const [dbSizeResult, dbTablesResult, dbCountsResult, dbVersionResult, dbNowResult, containerStats] = await Promise.all([
      pool.query(`
        SELECT
          current_database() AS database,
          pg_database_size(current_database())::bigint AS size_bytes,
          pg_size_pretty(pg_database_size(current_database())) AS size_pretty
      `),
      pool.query(`
        SELECT
          schemaname,
          relname AS table_name,
          pg_total_relation_size(relid)::bigint AS total_bytes,
          pg_size_pretty(pg_total_relation_size(relid)) AS total_pretty,
          pg_relation_size(relid)::bigint AS table_bytes,
          pg_size_pretty(pg_relation_size(relid)) AS table_pretty,
          (pg_total_relation_size(relid) - pg_relation_size(relid))::bigint AS index_bytes,
          pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_pretty
        FROM pg_catalog.pg_statio_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 25
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::bigint FROM messages WHERE effective_to IS NULL AND is_active = TRUE) AS messages_current,
          (SELECT COUNT(*)::bigint FROM people) AS people,
          (SELECT COUNT(*)::bigint FROM sources) AS sources
      `),
      pool.query('SELECT version() AS version'),
      pool.query('SELECT NOW() AS now_utc'),
      getDockerContainerStats()
    ]);

    res.json({
      timestamp: dbNowResult.rows[0]?.now_utc ?? new Date().toISOString(),
      database: {
        name: dbSizeResult.rows[0]?.database,
        size_bytes: Number(dbSizeResult.rows[0]?.size_bytes || 0),
        size_pretty: dbSizeResult.rows[0]?.size_pretty,
        version: dbVersionResult.rows[0]?.version,
        counts: {
          messages_current: Number(dbCountsResult.rows[0]?.messages_current || 0),
          people: Number(dbCountsResult.rows[0]?.people || 0),
          sources: Number(dbCountsResult.rows[0]?.sources || 0)
        },
        top_tables: dbTablesResult.rows.map((row: any) => ({
          schema: row.schemaname,
          table: row.table_name,
          total_bytes: Number(row.total_bytes || 0),
          total_pretty: row.total_pretty,
          table_bytes: Number(row.table_bytes || 0),
          table_pretty: row.table_pretty,
          index_bytes: Number(row.index_bytes || 0),
          index_pretty: row.index_pretty
        }))
      },
      container: containerStats.ok
        ? {
          available: true,
          id: containerStats.data?.id,
          name: containerStats.data?.name,
          size: containerStats.data?.size
        }
        : {
          available: false,
          error: containerStats.error
        }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function runBackfill(batchSize: number, limit: number) {
  backfillState.isRunning = true;
  backfillState.currentBatch = 0;
  backfillState.processed = 0;
  backfillState.errorsCount = 0;
  backfillState.errors = [];
  backfillState.logs = [];
  backfillState.recentSamples = [];
  backfillState.lastRunStartedAt = new Date().toISOString();
  backfillState.lastRunFinishedAt = null;

  try {
    const toProcess = await pool.query(
      `SELECT id, content
       FROM messages
       WHERE embedding IS NULL AND effective_to IS NULL AND is_active = TRUE
       ORDER BY id ASC
       LIMIT $1`,
      [limit]
    );

    const rows = toProcess.rows;
    backfillState.totalBatches = Math.ceil(rows.length / batchSize);
    pushLog(`Backfill started for ${rows.length} messages in ${backfillState.totalBatches} batches.`);

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      backfillState.currentBatch = Math.floor(i / batchSize) + 1;
      let batchEmbedded = 0;

      for (const row of batch) {
        const content = typeof row.content === 'string' ? row.content.trim() : '';
        if (!content) continue;

        try {
          const embedding = await generateEmbedding(content);
          const vecStr = `[${embedding.join(',')}]`;
          await pool.query('UPDATE messages SET embedding = $1::vector WHERE id = $2', [vecStr, row.id]);
          backfillState.processed++;
          batchEmbedded++;

          backfillState.recentSamples.push({
            id: row.id,
            content_preview: content.slice(0, 120),
            embedding_preview: embedding.slice(0, 5)
          });
          backfillState.recentSamples = backfillState.recentSamples.slice(-5);
        } catch (err: any) {
          backfillState.errorsCount++;
          const message = `Message ${row.id}: ${err?.message || 'unknown embedding error'}`;
          backfillState.errors.push(message);
          backfillState.errors = backfillState.errors.slice(-20);
        }
      }

      pushLog(`Batch ${backfillState.currentBatch}/${backfillState.totalBatches}: embedded ${batchEmbedded} messages.`);
    }

    pushLog(`Backfill complete. Processed ${backfillState.processed}, errors ${backfillState.errorsCount}.`);
  } catch (err: any) {
    backfillState.errorsCount++;
    const message = `Backfill failed: ${err?.message || 'unknown error'}`;
    backfillState.errors.push(message);
    backfillState.errors = backfillState.errors.slice(-20);
    pushLog(message);
  } finally {
    backfillState.isRunning = false;
    backfillState.lastRunFinishedAt = new Date().toISOString();
  }
}

router.post('/embeddings/backfill', requireAuth('admin'), async (req, res) => {
  if (backfillState.isRunning) {
    res.status(409).json({ error: 'Backfill already running' });
    return;
  }

  const batchSize = Math.max(1, Math.min(Number(req.body?.batchSize) || 50, 500));
  const limit = Math.max(1, Math.min(Number(req.body?.limit) || 1000000, 1000000));

  void runBackfill(batchSize, limit);

  res.json({
    started: true,
    batchSize,
    limit,
    isRunning: true
  });
});

export default router;
