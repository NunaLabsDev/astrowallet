-- Audit Remediation Migration 0008
-- Expands connect_requests.action CHECK constraint to permit 'sign_auth_entry' (Smart Account / Soroban auth)
-- safely and idempotently without losing existing rows.

CREATE TABLE IF NOT EXISTS connect_requests_new (
  request_id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  action TEXT NOT NULL CHECK (action IN ('auth', 'sign_xdr', 'sign_message', 'sign_auth_entry')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  trust_tier TEXT NOT NULL CHECK (trust_tier IN ('official', 'verified', 'external')),
  hmac_sig TEXT NOT NULL,
  result_token_hash TEXT NOT NULL,
  app_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  responder_tg_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO connect_requests_new (
  request_id,
  network,
  action,
  status,
  trust_tier,
  hmac_sig,
  result_token_hash,
  app_json,
  payload_json,
  result_json,
  responder_tg_id,
  expires_at,
  created_at,
  updated_at
)
SELECT
  request_id,
  network,
  action,
  status,
  trust_tier,
  hmac_sig,
  result_token_hash,
  app_json,
  payload_json,
  result_json,
  responder_tg_id,
  expires_at,
  created_at,
  updated_at
FROM connect_requests;

DROP TABLE connect_requests;
ALTER TABLE connect_requests_new RENAME TO connect_requests;

CREATE INDEX IF NOT EXISTS idx_connect_requests_status_exp
  ON connect_requests (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_connect_requests_network_status
  ON connect_requests (network, status);

CREATE INDEX IF NOT EXISTS idx_connect_requests_expires_at
  ON connect_requests (expires_at);
