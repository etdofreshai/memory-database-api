import { Response, NextFunction } from 'express';
import pool from '../db.js';
import { AuthRequest } from './auth.js';

// Legacy unscoped tokens retain their explicit broad access. Scoped ingestors
// cannot write other sources through alternate entity routes.
export async function requireSourceScope(req: AuthRequest, res: Response, next: NextFunction) {
  const scope = req.token?.permissions === 'write' ? req.token.write_sources : null;
  if (!scope) { next(); return; }
  try {
    const rows = Array.isArray(req.body.transactions) ? req.body.transactions : [req.body];
    for (const row of rows) {
      let source = row.source;
      if (row.source_id) {
        const result = await pool.query('SELECT name FROM sources WHERE id=$1',[row.source_id]);
        const resolved = result.rows[0]?.name;
        if (source && source !== resolved) { res.status(403).json({error:'Source identity mismatch'}); return; }
        source = resolved;
      }
      if (!source || !scope.includes(source)) { res.status(403).json({error:'Token not authorized for this source'}); return; }
    }
    if (req.params.key) {
      const existing = await pool.query('SELECT source FROM sync_state WHERE key=$1',[req.params.key]);
      if (existing.rows.length && !scope.includes(existing.rows[0].source)) {
        res.status(403).json({error:'Token not authorized for this sync key'}); return;
      }
    }
    next();
  } catch { res.status(503).json({error:'Unable to verify write scope'}); }
}

export async function requireAttachmentScope(req: AuthRequest,res: Response,next: NextFunction) {
  const scope = req.token?.permissions === 'write' ? req.token.write_sources : null;
  if (!scope) { next(); return; }
  try {
    const result = await pool.query(`SELECT DISTINCT s.name FROM current_message_attachment_links l
      JOIN current_messages m ON m.record_id=l.message_record_id JOIN sources s ON s.id=m.source_id
      WHERE l.attachment_record_id=$1::uuid`,[req.params.record_id]);
    if (!result.rows.length || result.rows.some(r => !scope.includes(r.name))) {
      res.status(403).json({error:'Token not authorized for this attachment'}); return;
    }
    next();
  } catch { res.status(503).json({error:'Unable to verify write scope'}); }
}
