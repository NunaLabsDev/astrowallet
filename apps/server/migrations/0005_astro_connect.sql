-- AstroConnect v1 Open Standard Ephemeral Request Bridge (TTL <= 5 min; zero private keys)

CREATE TABLE IF NOT EXISTS connect_requests (
  request_id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  action TEXT NOT NULL CHECK (action IN ('auth', 'sign_xdr', 'sign_message')),
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

CREATE INDEX IF NOT EXISTS idx_connect_requests_status_exp
  ON connect_requests (status, expires_at);
