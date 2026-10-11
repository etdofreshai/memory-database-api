-- Run this migration explicitly, outside a transaction: indexes are concurrent.
-- Raw messages and their version history are not rewritten.
CREATE OR REPLACE FUNCTION memory_conversation(meta jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(NULLIF(meta->>'conversation_id',''), NULLIF(meta->>'conversationId',''),
    NULLIF(meta->>'sessionId',''), NULLIF(meta->>'session_id',''),
    NULLIF(meta->>'threadId',''), NULLIF(meta->>'chat_identifier',''),
    NULLIF(meta->>'chat_id',''), NULLIF(meta->>'jid',''),
    CASE WHEN meta ? 'channelId' AND meta ? 'ts'
      THEN (meta->>'channelId') || ':' || COALESCE(meta->>'threadTs',meta->>'ts')
      ELSE NULLIF(meta->>'channelId','') END)
$$;
CREATE OR REPLACE FUNCTION memory_document(body text, meta jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT setweight(to_tsvector('simple', left(COALESCE(meta->>'subject',meta->>'conversationTitle',meta->>'sessionTitle',''),2000)), 'A')
    || setweight(to_tsvector('simple', COALESCE(body,'')), 'B')
$$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_current_id
  ON messages (id) WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_current_source_time
  ON messages (source_id, timestamp DESC, id DESC)
  WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_current_conversation
  ON messages (source_id, memory_conversation(metadata), timestamp, id)
  WHERE effective_to IS NULL AND is_active = TRUE;
-- Rebuildable passage index. Large imported messages exceed tsvector's 1 MiB
-- limit; overlapping passages preserve their full contents without truncation.
CREATE TABLE IF NOT EXISTS memory_search_chunks (
  message_id integer REFERENCES messages(id) ON DELETE CASCADE,
  chunk_no integer NOT NULL,
  body text NOT NULL,
  document tsvector NOT NULL,
  PRIMARY KEY(message_id,chunk_no)
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_chunks_document
  ON memory_search_chunks USING GIN(document);
CREATE OR REPLACE FUNCTION memory_index_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_search_chunks WHERE message_id=NEW.id;
  IF NEW.effective_to IS NULL AND NEW.is_active THEN
    INSERT INTO memory_search_chunks(message_id,chunk_no,body,document)
      SELECT NEW.id,pos,substring(COALESCE(NEW.content,'') FROM pos FOR 12000),
        memory_document(substring(COALESCE(NEW.content,'') FROM pos FOR 12000),NEW.metadata)
      FROM generate_series(1,greatest(length(COALESCE(NEW.content,'')),1),11700) pos;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS memory_message_index ON messages;
CREATE TRIGGER memory_message_index AFTER INSERT OR UPDATE OF content,metadata,effective_to,is_active
  ON messages FOR EACH ROW EXECUTE FUNCTION memory_index_message();

