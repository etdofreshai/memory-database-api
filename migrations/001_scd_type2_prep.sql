-- SCD Type 2 preparation for messages table
-- DO NOT run automatically — use `npm run migrate` when ready

ALTER TABLE messages ADD COLUMN IF NOT EXISTS record_id UUID DEFAULT gen_random_uuid();
ALTER TABLE messages ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE messages ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
