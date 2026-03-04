-- Current messages view (active records only)
-- Run after 001_scd_type2_prep.sql

CREATE OR REPLACE VIEW current_messages AS
SELECT * FROM messages WHERE is_active = TRUE OR is_active IS NULL;
