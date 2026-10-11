import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000),
  keepAlive: true,
});
pool.on('error', (error) => console.error('Idle database connection failed:', error.message));
export default pool;
