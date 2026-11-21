-- Audit Security Hardening Migration
-- Adds unique username enforcement, atomic D1 rate limiting, daily relay budget tracking,
-- and Telegram webhook update_id idempotency.

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_users_username_lower
  ON tg_users(username_lower)
  WHERE username_lower IS NOT NULL;

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_daily_usage (
  day_utc TEXT PRIMARY KEY,
  spent_stroops TEXT NOT NULL,
  tx_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_tg_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
