CREATE TABLE IF NOT EXISTS discord_channels (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  guild_id TEXT,
  guild_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
