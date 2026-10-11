// Run after migration 014. Inserts only rebuildable search passages.
// FOR SHARE serializes source edits with each batch so a backfill cannot
// resurrect a stale passage after the live indexing trigger has removed it.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 120000 });
let cursor = Number(process.env.AFTER_MESSAGE_ID || 0);
let processed = 0;
try {
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(`SELECT id FROM messages
        WHERE id>$1 AND effective_to IS NULL AND is_active=TRUE
        ORDER BY id LIMIT 1000 FOR SHARE`,[cursor]);
      if (!rows.rows.length) { await client.query('COMMIT'); break; }
      await client.query(`INSERT INTO memory_search_chunks(message_id,chunk_no,body,document)
        SELECT m.id,pos,substring(COALESCE(m.content,'') FROM pos FOR 12000),
          memory_document(substring(COALESCE(m.content,'') FROM pos FOR 12000),m.metadata)
        FROM messages m CROSS JOIN LATERAL
          generate_series(1,greatest(length(COALESCE(m.content,'')),1),11700) pos
        WHERE m.id=ANY($1::integer[]) ON CONFLICT DO NOTHING`,[rows.rows.map(r=>r.id)]);
      await client.query('COMMIT');
      cursor=rows.rows.at(-1).id; processed+=rows.rows.length;
      if(processed%10000===0) console.log(JSON.stringify({processed,cursor}));
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  await pool.query('ANALYZE memory_search_chunks');
  const missing=await pool.query(`SELECT count(*)::int AS missing FROM current_messages m
    WHERE NOT EXISTS(SELECT 1 FROM memory_search_chunks c WHERE c.message_id=m.id)`);
  if(missing.rows[0].missing) throw new Error(`${missing.rows[0].missing} current records are not indexed`);
  console.log(JSON.stringify({complete:true,processed,cursor,missing:0}));
} finally { await pool.end(); }
