-- Audit Remediation Migration 0007
-- Fixes silent no-op on unique username index (drops non-unique 0001 index first)
-- and adds missing indexes on alerts, intents, connect_requests, rate_limits, and cleanup timestamps.

DROP INDEX IF EXISTS idx_tg_users_username_lower;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_users_username_lower
  ON tg_users(username_lower)
  WHERE username_lower IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tg_users_alerts_enabled
  ON tg_users(alerts_enabled);

CREATE INDEX IF NOT EXISTS idx_signed_intents_creator_status_created
  ON signed_intents(creator_tg_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_signed_intents_network_status
  ON signed_intents(network, status);

CREATE INDEX IF NOT EXISTS idx_signed_intents_expires_at
  ON signed_intents(expires_at);

CREATE INDEX IF NOT EXISTS idx_connect_requests_network_status
  ON connect_requests(network, status);

CREATE INDEX IF NOT EXISTS idx_connect_requests_expires_at
  ON connect_requests(expires_at);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at
  ON rate_limits(reset_at);

CREATE INDEX IF NOT EXISTS idx_processed_tg_updates_processed_at
  ON processed_tg_updates(processed_at);

CREATE INDEX IF NOT EXISTS idx_processed_alerts_created_at
  ON processed_alerts(created_at);
