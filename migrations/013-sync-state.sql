-- Sync state table for tracking integration sync metadata
CREATE TABLE IF NOT EXISTS sync_state (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  last_sync_date TIMESTAMPTZ,
  last_record_date DATE,
  total_records INTEGER DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
