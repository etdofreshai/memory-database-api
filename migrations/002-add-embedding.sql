CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
