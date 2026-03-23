CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  source_id INTEGER REFERENCES sources(id),
  external_id TEXT,                    -- ID from source system (Monarch, bank, etc.)
  date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  merchant TEXT,
  category TEXT,
  subcategory TEXT,
  account_name TEXT,                   -- e.g. "Chase Checking", "Amex Gold"
  account_type TEXT,                   -- checking, credit, savings, investment
  transaction_type TEXT,               -- debit, credit, transfer
  status TEXT DEFAULT 'posted',        -- pending, posted, cleared
  notes TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_record_active ON transactions(record_id) WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_external ON transactions(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);

CREATE VIEW current_transactions AS
  SELECT * FROM transactions WHERE effective_to IS NULL AND is_active = TRUE;
