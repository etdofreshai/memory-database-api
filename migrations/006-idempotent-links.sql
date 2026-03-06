-- Idempotent link creation: prevent duplicate links on rerun
-- Unique constraint on (message_record_id, attachment_record_id) for active links
-- Also on (message_record_id, provider, provider_attachment_id) for provider-keyed dedup

CREATE UNIQUE INDEX IF NOT EXISTS idx_mal_unique_msg_att
  ON message_attachment_links (message_record_id, attachment_record_id)
  WHERE effective_to IS NULL AND is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mal_unique_provider
  ON message_attachment_links (message_record_id, provider, provider_attachment_id)
  WHERE effective_to IS NULL AND is_active = TRUE
    AND provider IS NOT NULL AND provider_attachment_id IS NOT NULL;
