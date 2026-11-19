-- AstroWallet D1 Initial Schema (Zero private keys or seed material)

CREATE TABLE IF NOT EXISTS tg_users (
  telegram_user_id TEXT PRIMARY KEY,
  username_lower TEXT,
  alerts_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_users_username_lower
  ON tg_users (username_lower);

CREATE TABLE IF NOT EXISTS linked_addresses (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('classic', 'smart')),
  label TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  verified_sig_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (telegram_user_id) REFERENCES tg_users (telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_linked_addresses_user
  ON linked_addresses (telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_linked_addresses_address
  ON linked_addresses (address);

CREATE TABLE IF NOT EXISTS signed_intents (
  intent_id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  creator_tg_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  hmac_sig TEXT NOT NULL,
  chat_id TEXT,
  message_id TEXT,
  inline_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'confirmed', 'expired', 'cancelled')),
  tx_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signed_intents_status_exp
  ON signed_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS claim_links (
  claim_id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  sender_address TEXT NOT NULL,
  recipient_tg_username TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_issuer TEXT,
  amount TEXT NOT NULL,
  escrow_contract_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'refunded', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_links_recipient
  ON claim_links (recipient_tg_username, status);
