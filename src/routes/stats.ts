import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth('read', 'write', 'admin'), async (_req, res) => {
  try {
    const [dbSizeResult, dbTablesResult, dbCountsResult, dbVersionResult, dbNowResult] = await Promise.all([
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
      pool.query('SELECT NOW() AS now_utc')
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
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
