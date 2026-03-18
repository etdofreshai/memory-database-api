-- Attachments V1 migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- vector extension removed (not available on this deployment)

-- attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  sha256 TEXT NOT NULL,
  size_bytes BIGINT,
  mime_type TEXT,
  file_type TEXT,
  original_file_name TEXT,
  created_at_source TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_path TEXT,
  url_local TEXT,
  url_fallback_1 TEXT,
  url_fallback_2 TEXT,
  url_fallback_3 TEXT,
  privacy_level TEXT NOT NULL DEFAULT 'private_consent'
    CHECK (privacy_level IN ('public', 'private_consent', 'private_double_consent')),
  summary_text TEXT,
  summary_model TEXT,
  summary_updated_at TIMESTAMPTZ,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  faces JSONB NOT NULL DEFAULT '[]'::jsonb,
  ocr_text TEXT,
  user_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_input TEXT,
  -- embedding VECTOR(1536),  -- removed: pgvector not available
  embedding_model TEXT,
  embedding_updated_at TIMESTAMPTZ,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(record_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_attachments_current ON attachments(record_id) WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_privacy ON attachments(privacy_level);
CREATE INDEX IF NOT EXISTS idx_attachments_metadata_gin ON attachments USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_attachments_labels_gin ON attachments USING GIN (labels);

CREATE OR REPLACE VIEW current_attachments AS
SELECT * FROM attachments WHERE effective_to IS NULL AND is_active = TRUE;

-- message_attachment_links table
CREATE TABLE IF NOT EXISTS message_attachment_links (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  message_record_id UUID NOT NULL,
  attachment_record_id UUID NOT NULL,
  ordinal INTEGER,
  role TEXT,
  provider TEXT,
  provider_message_id TEXT,
  provider_attachment_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(record_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_mal_message_record_id ON message_attachment_links(message_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_attachment_record_id ON message_attachment_links(attachment_record_id);
CREATE INDEX IF NOT EXISTS idx_mal_provider_attachment_id ON message_attachment_links(provider_attachment_id);

CREATE OR REPLACE VIEW current_message_attachment_links AS
SELECT * FROM message_attachment_links WHERE effective_to IS NULL AND is_active = TRUE;
