import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './db.js';
import healthRouter from './routes/health.js';
import messagesRouter from './routes/messages.js';
import sourcesRouter from './routes/sources.js';
import peopleRouter from './routes/people.js';
import adminRouter from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/health', healthRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/people', peopleRouter);
app.use('/api/admin', adminRouter);

// Serve admin frontend in production
app.use('/admin', express.static(path.join(__dirname, '../admin/dist')));
app.get('/admin/*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../admin/dist/index.html'));
});

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

  // Run embedding migration
  const embeddingMigrationPath = path.join(__dirname, '../migrations/002-add-embedding.sql');
  const embeddingMigrationSql = fs.readFileSync(embeddingMigrationPath, 'utf8');
  await pool.query(embeddingMigrationSql);

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

async function startWithRetry(retries = 10, delayMs = 3000) {
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
