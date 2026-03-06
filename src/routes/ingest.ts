import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { generateEmbedding } from '../embeddings.js';

const router = Router();

const STORAGE_PATH = process.env.ATTACHMENT_STORAGE_PATH || '/memory/attachments';
const MAX_FILE_SIZE = parseInt(process.env.INGEST_MAX_FILE_SIZE || String(1024 * 1024 * 1024)); // 1GB
const MAX_FILES = 10;

// Ensure storage dir exists
fs.mkdirSync(STORAGE_PATH, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

function mimeToFileType(mime: string | undefined): string {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('application/pdf') || mime.startsWith('text/')) return 'document';
  return 'file';
}

function getExtension(originalName?: string, mime?: string): string {
  if (originalName) {
    const ext = path.extname(originalName);
    if (ext) return ext;
  }
  // fallback from mime
  const mimeMap: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'text/plain': '.txt',
  };
  return (mime && mimeMap[mime]) || '.bin';
}

function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// POST /api/messages/ingest
router.post('/', requireAuth('write', 'admin'), upload.array('files', MAX_FILES), async (req: AuthRequest, res) => {
  // Parse message field
  let messageData: any;
  try {
    messageData = typeof req.body.message === 'string' ? JSON.parse(req.body.message) : req.body.message;
  } catch {
    res.status(400).json({ error: 'invalid message JSON' });
    return;
  }

  if (!messageData) {
    res.status(400).json({ error: 'message field required' });
    return;
  }

  const { source, sender, recipient, content, timestamp, external_id, metadata } = messageData;
  if (!source || (!content && !sender)) {
    res.status(400).json({ error: 'message must include source and (content or sender)' });
    return;
  }

  // Check write scope
  if (req.token!.permissions === 'write' && req.token!.write_sources) {
    if (!req.token!.write_sources.includes(source)) {
      res.status(403).json({ error: `Token not authorized to write to source: ${source}` });
      return;
    }
  }

  // Parse attachments_meta
  let attachmentsMeta: any[] = [];
  try {
    if (req.body.attachments_meta) {
      attachmentsMeta = typeof req.body.attachments_meta === 'string'
        ? JSON.parse(req.body.attachments_meta)
        : req.body.attachments_meta;
    }
  } catch {
    res.status(400).json({ error: 'invalid attachments_meta JSON' });
    return;
  }

  const files = (req.files as Express.Multer.File[]) || [];
  const writtenFiles: string[] = []; // track for rollback cleanup

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get or create source
    let sourceResult = await client.query('SELECT id FROM sources WHERE name = $1', [source]);
    if (sourceResult.rows.length === 0) {
      sourceResult = await client.query('INSERT INTO sources (name) VALUES ($1) RETURNING id', [source]);
    }
    const source_id = sourceResult.rows[0].id;

    const ts = timestamp || new Date().toISOString();
    const meta = metadata ? JSON.stringify(metadata) : null;

    // 2. Upsert message (SCD2 logic from messages route)
    let messageRow: any;
    if (external_id) {
      const existing = await client.query(
        `SELECT id, record_id, content FROM messages WHERE source_id = $1 AND external_id = $2 AND effective_to IS NULL LIMIT 1`,
        [source_id, external_id]
      );
      if (existing.rows.length > 0) {
        const old = existing.rows[0];
        if (old.content === content) {
          // Unchanged — reuse
          messageRow = old;
        } else {
          const now = new Date().toISOString();
          await client.query('UPDATE messages SET effective_to = $1 WHERE id = $2', [now, old.id]);
          const ins = await client.query(
            `INSERT INTO messages (source_id, sender, recipient, content, timestamp, external_id, metadata, record_id, effective_from)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [source_id, sender, recipient, content, ts, external_id, meta, old.record_id, now]
          );
          messageRow = ins.rows[0];
        }
      }
    }

    if (!messageRow) {
      const ins = await client.query(
        `INSERT INTO messages (source_id, sender, recipient, content, timestamp, external_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [source_id, sender, recipient, content, ts, external_id, meta]
      );
      messageRow = ins.rows[0];
    }

    const messageRecordId = messageRow.record_id;

    // 3. Process each file
    const attachmentResults: any[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileMeta = attachmentsMeta[i] || {};
      const sha256 = computeSha256(file.buffer);

      // Check dedupe
      const dupeCheck = await client.query(
        'SELECT record_id, storage_path FROM current_attachments WHERE sha256 = $1 LIMIT 1',
        [sha256]
      );

      let attachmentRecordId: string;
      let storagePath: string;
      let deduplicated = false;

      if (dupeCheck.rows.length > 0) {
        // Reuse existing
        attachmentRecordId = dupeCheck.rows[0].record_id;
        storagePath = dupeCheck.rows[0].storage_path;
        deduplicated = true;
      } else {
        // Create new attachment
        const ext = getExtension(fileMeta.original_file_name || file.originalname, file.mimetype);
        const ins = await client.query(
          `INSERT INTO attachments (sha256, size_bytes, mime_type, file_type, original_file_name, storage_provider, storage_path, url_local, created_at_source)
           VALUES ($1,$2,$3,$4,$5,'local',$6,$7,$8) RETURNING record_id, storage_path`,
          [
            sha256,
            file.size,
            file.mimetype,
            mimeToFileType(file.mimetype),
            fileMeta.original_file_name || file.originalname,
            '', // placeholder, will update after we know record_id
            '',
            fileMeta.created_at_source || null,
          ]
        );
        attachmentRecordId = ins.rows[0].record_id;
        storagePath = path.join(STORAGE_PATH, `${attachmentRecordId}${ext}`);

        // Update storage_path and url_local
        await client.query(
          'UPDATE attachments SET storage_path = $1, url_local = $1 WHERE record_id = $2 AND effective_to IS NULL',
          [storagePath, attachmentRecordId]
        );

        // Write file to disk
        fs.writeFileSync(storagePath, file.buffer);
        writtenFiles.push(storagePath);
      }

      // Create link
      const linkResult = await client.query(
        `INSERT INTO message_attachment_links (message_record_id, attachment_record_id, ordinal, role, provider, provider_message_id, provider_attachment_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          messageRecordId,
          attachmentRecordId,
          i,
          fileMeta.role || 'original',
          fileMeta.provider || null,
          fileMeta.provider_message_id || null,
          fileMeta.provider_attachment_id || null,
          fileMeta.metadata ? JSON.stringify(fileMeta.metadata) : '{}',
        ]
      );

      attachmentResults.push({
        record_id: attachmentRecordId,
        sha256,
        deduplicated,
        storage_path: storagePath,
        link_id: linkResult.rows[0].id,
      });
    }

    await client.query('COMMIT');
    client.release();

    res.status(201).json({
      message: {
        id: messageRow.id,
        record_id: messageRecordId,
        source,
        content,
      },
      attachments: attachmentResults,
    });

    // Background embedding
    if (content) {
      generateEmbedding(content).then(embedding => {
        if (embedding) {
          pool.query('UPDATE messages SET embedding = $1 WHERE id = $2', [`[${embedding.join(',')}]`, messageRow.id])
            .catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();

    // Cleanup written files
    for (const fp of writtenFiles) {
      try { fs.unlinkSync(fp); } catch {}
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'file too large' });
    } else if (err.code === '23505') {
      res.status(409).json({ error: 'conflict', detail: err.detail });
    } else {
      console.error('Ingest error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  }
});

export default router;
