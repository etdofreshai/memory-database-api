import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../db.js';
import { app } from '../app.js';

let token: string;

beforeAll(async () => {
  // Ensure tables exist
  const migrationPath = path.resolve(import.meta.dirname, '../../migrations/005-attachments.sql');
  if (fs.existsSync(migrationPath)) {
    await pool.query(fs.readFileSync(migrationPath, 'utf8'));
  }

  // Create test token
  token = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO api_tokens (token, label, permissions) VALUES ($1, 'test-ingest', 'write')
     ON CONFLICT (token) DO NOTHING`,
    [token]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM api_tokens WHERE token = $1`, [token]);
  await pool.end();
});

describe('POST /api/messages/ingest', () => {
  it('returns 400 when message field is missing', async () => {
    const res = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('nothing', 'here');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('returns 400 for invalid message JSON', async () => {
    const res = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', '{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid message JSON/i);
  });

  it('creates message without attachments (201)', async () => {
    const msg = { source: 'test', sender: 'tester', content: 'hello ingest', timestamp: new Date().toISOString() };
    const res = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', JSON.stringify(msg));

    expect(res.status).toBe(201);
    expect(res.body.message.record_id).toBeTruthy();
    expect(res.body.attachments).toHaveLength(0);
  });

  it('creates message + single attachment (201)', async () => {
    const msg = { source: 'test', sender: 'tester', content: 'with file', timestamp: new Date().toISOString() };
    const fileContent = Buffer.from('test file content ' + Date.now());

    const res = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', JSON.stringify(msg))
      .field('attachments_meta', JSON.stringify([{ original_file_name: 'test.txt', role: 'original' }]))
      .attach('files', fileContent, 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].deduplicated).toBe(false);
    expect(res.body.attachments[0].storage_path).toContain('.txt');

    // Verify file on disk
    expect(fs.existsSync(res.body.attachments[0].storage_path)).toBe(true);

    // Cleanup
    try { fs.unlinkSync(res.body.attachments[0].storage_path); } catch {}
  });

  it('deduplicates same file content', async () => {
    const fileContent = Buffer.from('dedupe-test-content-' + Date.now());
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    // First upload
    const msg1 = { source: 'test', sender: 'a', content: 'msg1', timestamp: new Date().toISOString() };
    const res1 = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', JSON.stringify(msg1))
      .attach('files', fileContent, 'dup.txt');

    expect(res1.status).toBe(201);
    expect(res1.body.attachments[0].deduplicated).toBe(false);
    const firstRecordId = res1.body.attachments[0].record_id;

    // Second upload with same content
    const msg2 = { source: 'test', sender: 'b', content: 'msg2', timestamp: new Date().toISOString() };
    const res2 = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', JSON.stringify(msg2))
      .attach('files', fileContent, 'dup2.txt');

    expect(res2.status).toBe(201);
    expect(res2.body.attachments[0].deduplicated).toBe(true);
    expect(res2.body.attachments[0].record_id).toBe(firstRecordId);
    expect(res2.body.attachments[0].sha256).toBe(sha256);

    // Cleanup
    try { fs.unlinkSync(res1.body.attachments[0].storage_path); } catch {}
  });

  it('handles multi-attachment upload with correct ordinals', async () => {
    const msg = { source: 'test', sender: 'multi', content: 'multi files', timestamp: new Date().toISOString() };
    const f1 = Buffer.from('file-1-' + Date.now());
    const f2 = Buffer.from('file-2-' + Date.now());
    const f3 = Buffer.from('file-3-' + Date.now());

    const res = await request(app)
      .post('/api/messages/ingest')
      .set('Authorization', `Bearer ${token}`)
      .field('message', JSON.stringify(msg))
      .attach('files', f1, 'a.txt')
      .attach('files', f2, 'b.txt')
      .attach('files', f3, 'c.txt');

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(3);

    // Verify ordinals in DB
    const links = await pool.query(
      'SELECT ordinal FROM current_message_attachment_links WHERE message_record_id = $1 ORDER BY ordinal',
      [res.body.message.record_id]
    );
    expect(links.rows.map((r: any) => r.ordinal)).toEqual([0, 1, 2]);

    // Cleanup
    for (const a of res.body.attachments) {
      try { fs.unlinkSync(a.storage_path); } catch {}
    }
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/messages/ingest')
      .field('message', '{"source":"test","content":"no auth"}');
    expect(res.status).toBe(401);
  });
});
