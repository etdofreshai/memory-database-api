-- Subscription settings: per-service auto-subscribe flag
-- When auto_subscribe is true, ALL channels for that service are considered subscribed
-- (including future ones). Users only need to explicitly unsubscribe what they don't want.

CREATE TABLE IF NOT EXISTS subscription_settings (
  id SERIAL PRIMARY KEY,
  service TEXT NOT NULL UNIQUE,
  auto_subscribe BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
