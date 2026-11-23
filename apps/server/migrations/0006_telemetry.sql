-- Privacy-first telemetry & SCF verifiable on-chain metrics (zero PII, zero raw IPs)

CREATE TABLE IF NOT EXISTS daily_user_activity (
  day_utc TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  platform TEXT NOT NULL DEFAULT 'unknown',
  lang TEXT NOT NULL DEFAULT 'en',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, user_hash, network)
);
CREATE INDEX IF NOT EXISTS idx_dau_network_day
  ON daily_user_activity (network, day_utc DESC);

CREATE TABLE IF NOT EXISTS product_events_daily (
  day_utc TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  event_type TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, network, event_type)
);
CREATE INDEX IF NOT EXISTS idx_events_network_day
  ON product_events_daily (network, day_utc DESC);

CREATE TABLE IF NOT EXISTS verified_tx_log (
  tx_hash TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  action_type TEXT NOT NULL,
  asset_code TEXT,
  amount_est TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verified_tx_net_time
  ON verified_tx_log (network, created_at DESC);
