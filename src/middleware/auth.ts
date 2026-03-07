import { Request, Response, NextFunction } from 'express';
import pool from '../db.js';

export interface AuthRequest extends Request {
  token?: { id: number; label: string; permissions: string; write_sources: string[] | null };
}

export function requireAuth(...allowed: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    // Support ?token= query param for media elements (img/video/audio src can't send headers)
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (!header?.startsWith('Bearer ') && !queryToken) {
      res.status(401).json({ error: 'Missing Bearer token' });
      return;
    }
    const token = queryToken || header!.slice(7);
    try {
      const result = await pool.query(
        'SELECT id, label, permissions, write_sources FROM api_tokens WHERE token = $1 AND is_active = true',
        [token]
      );
      if (result.rows.length === 0) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      const row = result.rows[0];
      if (!allowed.includes(row.permissions)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      // Update last_used_at (fire and forget)
      pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]);
      req.token = row;
      next();
    } catch (err) {
      res.status(500).json({ error: 'Auth error' });
    }
  };
}
