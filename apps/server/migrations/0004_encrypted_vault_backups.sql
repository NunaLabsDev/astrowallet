-- Zero-Knowledge Encrypted Vault Sync (client-side Argon2id + AES-GCM-256 ciphertext only; zero plaintext secrets)

CREATE TABLE IF NOT EXISTS encrypted_vault_backups (
  telegram_user_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  envelope_json TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_user_id, network),
  FOREIGN KEY (telegram_user_id) REFERENCES tg_users (telegram_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_encrypted_vault_backups_updated
  ON encrypted_vault_backups (updated_at);
