import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './db.js';
import { app } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');

// Admin UI has been moved to openclaw-memory-db-manager (standalone repo)

async function bootstrap() {
  // Create api_tokens table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id SERIAL PRIMARY KEY,
      token VARCHAR(64) UNIQUE NOT NULL,
      label VARCHAR(255) NOT NULL,
      permissions VARCHAR(10) NOT NULL,
      write_sources TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT TRUE
    )
  `);

  // Run base schema migration (creates sources, messages, people if not exist)
  const baseSchemaMigrationPath = path.join(__dirname, '../migrations/000-base-schema.sql');
  if (fs.existsSync(baseSchemaMigrationPath)) {
    const baseSchemaSql = fs.readFileSync(baseSchemaMigrationPath, 'utf8');
    await pool.query(baseSchemaSql);
    console.log('✅ Base schema migration applied');
  }

  // Embedding migration skipped — pgvector not available on this deployment

  // Run SCD Type 2 migration
  const scdMigrationPath = path.join(__dirname, '../migrations/003-scd-type2.sql');
  if (fs.existsSync(scdMigrationPath)) {
    const scdMigrationSql = fs.readFileSync(scdMigrationPath, 'utf8');
    await pool.query(scdMigrationSql);
    console.log('✅ SCD Type 2 migration applied');
  }

  // Run attachments migration
  const attachmentsMigrationPath = path.join(__dirname, '../migrations/005-attachments.sql');
  if (fs.existsSync(attachmentsMigrationPath)) {
    const attachmentsMigrationSql = fs.readFileSync(attachmentsMigrationPath, 'utf8');
    await pool.query(attachmentsMigrationSql);
    console.log('✅ Attachments migration applied');
  }

  // Run subscriptions migration
  const subscriptionsMigrationPath = path.join(__dirname, '../migrations/009-subscriptions.sql');
  if (fs.existsSync(subscriptionsMigrationPath)) {
    const subscriptionsMigrationSql = fs.readFileSync(subscriptionsMigrationPath, 'utf8');
    await pool.query(subscriptionsMigrationSql);
    console.log('✅ Subscriptions migration applied');
  }

  // Run subscription settings migration
  const subscriptionSettingsMigrationPath = path.join(__dirname, '../migrations/010-subscription-settings.sql');
  if (fs.existsSync(subscriptionSettingsMigrationPath)) {
    const subscriptionSettingsMigrationSql = fs.readFileSync(subscriptionSettingsMigrationPath, 'utf8');
    await pool.query(subscriptionSettingsMigrationSql);
    console.log('✅ Subscription settings migration applied');
  }

  // Run sync-state migration
  const syncStateMigrationPath = path.join(__dirname, '../migrations/013-sync-state.sql');
  if (fs.existsSync(syncStateMigrationPath)) {
    const syncStateMigrationSql = fs.readFileSync(syncStateMigrationPath, 'utf8');
    await pool.query(syncStateMigrationSql);
    console.log('✅ Sync state migration applied');
  }

  // Bootstrap admin token
  const adminTokenEnv = process.env.ADMIN_TOKEN;
  const existing = await pool.query("SELECT id, token FROM api_tokens WHERE label = 'Bootstrap Admin' AND permissions = 'admin' LIMIT 1");
  if (existing.rows.length === 0) {
    const token = adminTokenEnv || crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO api_tokens (token, label, permissions) VALUES ($1, $2, $3)',
      [token, 'Bootstrap Admin', 'admin']
    );
    console.log(`\n🔑 Admin token created: ${token}\n`);
  } else if (adminTokenEnv && existing.rows[0].token !== adminTokenEnv) {
    await pool.query('UPDATE api_tokens SET token = $1 WHERE id = $2', [adminTokenEnv, existing.rows[0].id]);
    console.log(`\n🔑 Admin token updated from ADMIN_TOKEN env var\n`);
  }

  app.listen(PORT, () => {
    console.log(`🚀 memory-database-api running on port ${PORT}`);
  });
}

async function startWithRetry(retries = 30, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      await bootstrap();
      return;
    } catch (err: any) {
      if (err.code === '57P03' && i < retries - 1) {
        console.log(`DB not ready (attempt ${i + 1}/${retries}), retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('Failed to start:', err);
        process.exit(1);
      }
    }
  }
}

startWithRetry();
