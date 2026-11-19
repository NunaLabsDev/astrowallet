-- AstroWallet D1 Production Hardening (anti-replay, multi-payer splits, alert dedup)

CREATE UNIQUE INDEX IF NOT EXISTS idx_signed_intents_tx_hash
  ON signed_intents (tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS intent_payments (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  payer_address TEXT,
  tx_hash TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (intent_id) REFERENCES signed_intents (intent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intent_payments_intent
  ON intent_payments (intent_id);

CREATE TABLE IF NOT EXISTS processed_alerts (
  dedup_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
