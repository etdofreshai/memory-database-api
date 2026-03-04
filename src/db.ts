import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:bmm34neuoh99j8v6@ai-applications-openclaw-database-nztjfr:5432/postgres',
});

export default pool;
