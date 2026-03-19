import { Router } from 'express';
import pool from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_SERVICES = ['discord', 'slack', 'chatgpt', 'anthropic', 'openclaw', 'imessage', 'gmail'];

function isValidService(service: string): boolean {
  return VALID_SERVICES.includes(service);
}

function getString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return '';
}

// GET /api/subscriptions — list all current subscriptions, optionally filter by ?service=
router.get('/', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.query.service);
    let query = 'SELECT * FROM current_subscriptions';
    const params: string[] = [];

    if (service) {
      if (!isValidService(service)) {
        res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
        return;
      }
      query += ' WHERE service = $1';
      params.push(service);
    }

    query += ' ORDER BY service, server_name NULLS LAST, channel_name NULLS LAST';
    const result = await pool.query(query, params);
    res.json({ subscriptions: result.rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/subscriptions/:service — list subscriptions for a specific service
router.get('/:service', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    const result = await pool.query(
      'SELECT * FROM current_subscriptions WHERE service = $1 ORDER BY server_name NULLS LAST, channel_name NULLS LAST',
      [service]
    );
    res.json({ subscriptions: result.rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/subscriptions/:service/sync-status — stub: compare subscribed channels vs what's in DB
router.get('/:service/sync-status', requireAuth('read', 'write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    // Get subscribed channels
    const subsResult = await pool.query(
      'SELECT channel_id, channel_name, server_name FROM current_subscriptions WHERE service = $1 AND subscribed = true',
      [service]
    );

    // Get message counts per channel from the messages table
    // Map service names to source names in the sources table
    const sourceResult = await pool.query(
      'SELECT id FROM sources WHERE name = $1',
      [service]
    );

    const syncStatus: Array<{
      channel_id: string;
      channel_name: string | null;
      server_name: string | null;
      message_count: number;
    }> = [];

    if (sourceResult.rows.length > 0) {
      const sourceId = sourceResult.rows[0].id;
      for (const sub of subsResult.rows) {
        const countResult = await pool.query(
          `SELECT COUNT(*) as count FROM current_messages WHERE source_id = $1 AND (
            recipient ILIKE $2 OR recipient ILIKE $3
          )`,
          [sourceId, `%${sub.channel_id}%`, `%-channel:${sub.channel_id}%`]
        );
        syncStatus.push({
          channel_id: sub.channel_id,
          channel_name: sub.channel_name,
          server_name: sub.server_name,
          message_count: parseInt(countResult.rows[0].count, 10),
        });
      }
    } else {
      // No source found, return subscriptions with 0 counts
      for (const sub of subsResult.rows) {
        syncStatus.push({
          channel_id: sub.channel_id,
          channel_name: sub.channel_name,
          server_name: sub.server_name,
          message_count: 0,
        });
      }
    }

    res.json({ service, syncStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

interface SubscriptionInput {
  channel_id: string;
  channel_name?: string;
  server_id?: string;
  server_name?: string;
  subscribed?: boolean;
  metadata?: Record<string, unknown>;
}

// PUT /api/subscriptions/:service — bulk upsert subscriptions for a service
router.put('/:service', requireAuth('write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    const items: SubscriptionInput[] = req.body;
    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Body must be an array of subscription objects' });
      return;
    }

    // Validate each item has channel_id
    for (const item of items) {
      if (!item.channel_id) {
        res.status(400).json({ error: 'Each item must have a channel_id' });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const upserted: unknown[] = [];

      for (const item of items) {
        // Check if current version exists
        const existing = await client.query(
          'SELECT * FROM current_subscriptions WHERE service = $1 AND channel_id = $2',
          [service, item.channel_id]
        );

        const newSubscribed = item.subscribed !== undefined ? item.subscribed : true;
        const newChannelName = item.channel_name ?? null;
        const newServerId = item.server_id ?? null;
        const newServerName = item.server_name ?? null;
        const newMetadata = item.metadata ?? {};

        if (existing.rows.length > 0) {
          const old = existing.rows[0];
          // Check if anything actually changed
          const changed =
            old.subscribed !== newSubscribed ||
            old.channel_name !== newChannelName ||
            old.server_id !== newServerId ||
            old.server_name !== newServerName ||
            JSON.stringify(old.metadata) !== JSON.stringify(newMetadata);

          if (changed) {
            // Close out old version (SCD Type 2)
            await client.query(
              'UPDATE subscriptions SET effective_to = NOW(), is_active = false WHERE id = $1',
              [old.id]
            );

            // Insert new version
            const insertResult = await client.query(
              `INSERT INTO subscriptions (record_id, service, channel_id, channel_name, server_id, server_name, subscribed, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING *`,
              [old.record_id, service, item.channel_id, newChannelName, newServerId, newServerName, newSubscribed, JSON.stringify(newMetadata)]
            );
            upserted.push(insertResult.rows[0]);
          } else {
            upserted.push(old);
          }
        } else {
          // Insert new subscription
          const insertResult = await client.query(
            `INSERT INTO subscriptions (service, channel_id, channel_name, server_id, server_name, subscribed, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [service, item.channel_id, newChannelName, newServerId, newServerName, newSubscribed, JSON.stringify(newMetadata)]
          );
          upserted.push(insertResult.rows[0]);
        }
      }

      await client.query('COMMIT');
      res.json({ subscriptions: upserted, count: upserted.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// PATCH /api/subscriptions/:service/:channel_id — toggle single subscription
router.patch('/:service/:channel_id', requireAuth('write', 'admin'), async (req, res) => {
  try {
    const service = getString(req.params.service);
    const channel_id = getString(req.params.channel_id);
    if (!isValidService(service)) {
      res.status(400).json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(', ')}` });
      return;
    }

    // Allow body to specify subscribed, channel_name, etc.
    const updates = req.body || {};

    const existing = await pool.query(
      'SELECT * FROM current_subscriptions WHERE service = $1 AND channel_id = $2',
      [service, channel_id]
    );

    if (existing.rows.length === 0) {
      // If no existing record, create one
      const subscribed = updates.subscribed !== undefined ? updates.subscribed : true;
      const result = await pool.query(
        `INSERT INTO subscriptions (service, channel_id, channel_name, server_id, server_name, subscribed, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [service, channel_id, updates.channel_name ?? null, updates.server_id ?? null, updates.server_name ?? null, subscribed, JSON.stringify(updates.metadata ?? {})]
      );
      res.json({ subscription: result.rows[0] });
      return;
    }

    const old = existing.rows[0];
    const newSubscribed = updates.subscribed !== undefined ? updates.subscribed : !old.subscribed;
    const newChannelName = updates.channel_name !== undefined ? updates.channel_name : old.channel_name;
    const newServerId = updates.server_id !== undefined ? updates.server_id : old.server_id;
    const newServerName = updates.server_name !== undefined ? updates.server_name : old.server_name;
    const newMetadata = updates.metadata !== undefined ? updates.metadata : old.metadata;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Close old version
      await client.query(
        'UPDATE subscriptions SET effective_to = NOW(), is_active = false WHERE id = $1',
        [old.id]
      );

      // Insert new version
      const result = await client.query(
        `INSERT INTO subscriptions (record_id, service, channel_id, channel_name, server_id, server_name, subscribed, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [old.record_id, service, channel_id, newChannelName, newServerId, newServerName, newSubscribed, JSON.stringify(newMetadata)]
      );

      await client.query('COMMIT');
      res.json({ subscription: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
