-- Subscriptions table: SCD Type 2 pattern
-- Tracks which channels/conversations per service are synced to the memory database

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  record_id UUID DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,            -- 'discord', 'slack', 'chatgpt', 'anthropic', 'openclaw', 'imessage', 'gmail'
  channel_id TEXT NOT NULL,         -- external channel/conversation ID
  channel_name TEXT,                -- human-readable name
  server_id TEXT,                   -- parent server/workspace ID (nullable, for Discord/Slack)
  server_name TEXT,                 -- parent server/workspace name
  subscribed BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',      -- extra info (icons, member count, etc.)
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(service, channel_id, effective_from)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_service ON subscriptions (service);
CREATE INDEX IF NOT EXISTS idx_subscriptions_record_id ON subscriptions (record_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_current ON subscriptions (service, channel_id) WHERE effective_to IS NULL AND is_active = TRUE;

-- View for current (non-superseded, active) subscriptions
CREATE OR REPLACE VIEW current_subscriptions AS
  SELECT * FROM subscriptions
  WHERE effective_to IS NULL AND is_active = TRUE;
