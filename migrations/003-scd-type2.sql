-- SCD Type 2: Append-only versioning for messages
-- Safe to re-run (all statements are idempotent)

-- 1. Add SCD columns (no default on record_id/effective_from — backfill separately)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS record_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- 2. Backfill existing rows (only rows that haven't been backfilled yet)
UPDATE messages SET record_id = gen_random_uuid() WHERE record_id IS NULL;
UPDATE messages SET effective_from = COALESCE(created_at, NOW()) WHERE effective_from IS NULL;
UPDATE messages SET is_active = TRUE WHERE is_active IS NULL;

-- 3. Set defaults for future inserts
ALTER TABLE messages ALTER COLUMN record_id SET DEFAULT gen_random_uuid();
ALTER TABLE messages ALTER COLUMN effective_from SET DEFAULT NOW();

-- 4. Drop the old unique constraint on (source_id, external_id)
--    SCD Type 2 needs multiple rows per (source_id, external_id) — one per version
--    Handle both constraint and standalone index forms
DO $$
BEGIN
  -- Try dropping as a table constraint first
  ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_source_id_external_id_key;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;
DROP INDEX IF EXISTS messages_source_id_external_id_key;

-- 5. Create partial unique index: only one CURRENT version per (source_id, external_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_ext_current
  ON messages (source_id, external_id)
  WHERE effective_to IS NULL AND external_id IS NOT NULL;

-- 6. Create view for current (non-superseded, active) messages
CREATE OR REPLACE VIEW current_messages AS
  SELECT * FROM messages WHERE effective_to IS NULL AND is_active = TRUE;

-- 7. Indexes for SCD queries
CREATE INDEX IF NOT EXISTS idx_messages_record_id ON messages (record_id);
CREATE INDEX IF NOT EXISTS idx_messages_effective_to ON messages (effective_to);
CREATE INDEX IF NOT EXISTS idx_messages_scd_lookup ON messages (external_id, source_id, effective_to);
