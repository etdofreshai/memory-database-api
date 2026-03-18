-- Base schema: sources, messages, people
-- Safe to run multiple times (IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS sources (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  sender VARCHAR(255),
  recipient VARCHAR(255),
  content TEXT,
  timestamp TIMESTAMPTZ,
  external_id VARCHAR(500),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS messages_source_id_idx ON messages(source_id);
CREATE INDEX IF NOT EXISTS messages_external_id_idx ON messages(external_id);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(sender);

CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  aliases TEXT[],
  relationships JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
