import type {
  AccountKind,
  ClaimLink,
  ConnectActionType,
  ConnectAppTrustTier,
  ConnectRequestRecord,
  ConnectRequestStatus,
  ContractAddress,
  IntentActionType,
  IntentStatus,
  SignedIntent,
  StellarAddress,
  StellarNetwork,
  TelegramUserBinding,
} from "@astrowallet/domain";
import type { D1Database } from "@cloudflare/workers-types";

export interface TelegramUserRecord {
  telegramUserId: string;
  usernameLower?: string | undefined;
  alertsEnabled: boolean;
}

export interface LinkAddressInput {
  address: string;
  kind: AccountKind;
  label: string;
  isDefault?: boolean | undefined;
  verifiedSigHash: string;
}

export interface WatchedAccountRecord {
  telegramUserId: string;
  address: string;
  label: string;
}

export interface StoredEncryptedVaultBackup {
  telegramUserId: string;
  network: StellarNetwork;
  envelopeJson: string;
  envelopeSha256: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServerRepository {
  upsertTelegramUser(input: {
    telegramUserId: string;
    usernameLower?: string | undefined;
  }): Promise<TelegramUserRecord>;
  getUserById(telegramUserId: string): Promise<TelegramUserRecord | null>;
  getUserByUsername(usernameLower: string): Promise<TelegramUserRecord | null>;
  getUserByLinkedAddress?(address: string): Promise<TelegramUserRecord | null>;
  setUserAlertsEnabled(telegramUserId: string, enabled: boolean): Promise<void>;

  linkVerifiedAddresses(input: {
    telegramUserId: string;
    usernameLower?: string | undefined;
    accounts: readonly LinkAddressInput[];
  }): Promise<readonly TelegramUserBinding[]>;
  listLinkedAddresses(telegramUserId: string): Promise<readonly TelegramUserBinding[]>;
  setDefaultLinkedAddress(telegramUserId: string, address: string): Promise<boolean>;
  unlinkAddress(telegramUserId: string, address: string): Promise<boolean>;
  unlinkUserAddresses(telegramUserId: string): Promise<number>;
  isAddressLinked(address: string): Promise<boolean>;
  listWatchedAccounts(): Promise<readonly WatchedAccountRecord[]>;

  createSignedIntent(intent: SignedIntent): Promise<SignedIntent>;
  getSignedIntent(intentId: string): Promise<SignedIntent | null>;
  attachIntentMessageRef(
    intentId: string,
    ref: {
      chatId?: string | undefined;
      messageId?: string | undefined;
      inlineMessageId?: string | undefined;
    },
  ): Promise<void>;
  markIntentConfirmed(intentId: string, txHash?: string): Promise<SignedIntent | null>;
  markIntentStatus(intentId: string, status: IntentStatus): Promise<SignedIntent | null>;

  createClaimLink(claim: ClaimLink): Promise<ClaimLink>;
  getClaimLink(claimId: string): Promise<ClaimLink | null>;
  markClaimLinkStatus(
    claimId: string,
    status: ClaimLink["status"],
  ): Promise<ClaimLink | null>;

  /** True when `txHash` is already bound to any intent or split payment (anti-replay). */
  isTxHashUsed(txHash: string): Promise<boolean>;
  recordSplitPayment(input: {
    intentId: string;
    payerAddress?: string | undefined;
    txHash: string;
    amount: string;
  }): Promise<{ paidCount: number }>;
  countSplitPayments(intentId: string): Promise<number>;
  listSplitPaymentTxHashes(intentId: string): Promise<readonly string[]>;
  /** Returns true the first time a dedup key is claimed, false on repeats. */
  claimAlertDedupKey(dedupKey: string): Promise<boolean>;
  findRecentPendingIntent(input: {
    creatorTelegramUserId: string;
    actionType: IntentActionType;
    payloadJson: string;
    sinceUnix: number;
  }): Promise<SignedIntent | null>;

  incrementRateLimit(input: {
    key: string;
    windowSec: number;
    limit: number;
    nowSec?: number | undefined;
  }): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }>;
  tryConsumeRelayBudget(input: {
    dayUtc: string;
    feeStroops: string;
    dailyBudgetStroops: string;
  }): Promise<{ allowed: boolean; spentStroops: string }>;
  claimTelegramUpdateId(updateId: number, nowSec?: number): Promise<boolean>;
  purgeExpiredRecords(nowSec: number): Promise<void>;

  upsertEncryptedVaultBackup(input: {
    telegramUserId: string;
    network: StellarNetwork;
    envelopeJson: string;
    envelopeSha256: string;
    version?: number | undefined;
    updatedAt?: number | undefined;
  }): Promise<StoredEncryptedVaultBackup>;
  getEncryptedVaultBackup(
    telegramUserId: string,
    network: StellarNetwork,
  ): Promise<StoredEncryptedVaultBackup | null>;
  deleteEncryptedVaultBackup(
    telegramUserId: string,
    network: StellarNetwork,
  ): Promise<boolean>;

  createConnectRequest(req: ConnectRequestRecord): Promise<ConnectRequestRecord>;
  getConnectRequest(requestId: string): Promise<ConnectRequestRecord | null>;
  completeConnectRequest(input: {
    requestId: string;
    status: "approved" | "rejected" | "expired";
    resultJson?: string | undefined;
    responderTelegramUserId?: string | undefined;
    updatedAt: number;
  }): Promise<ConnectRequestRecord | null>;
}

interface RawUserRow {
  telegram_user_id: string;
  username_lower: string | null;
  alerts_enabled: number;
}

interface RawLinkedAddressRow {
  telegram_user_id: string;
  username_lower: string | null;
  address: string;
  kind: AccountKind;
  label: string;
  is_default: number;
}

interface RawIntentRow {
  intent_id: string;
  network: StellarNetwork;
  creator_tg_id: string;
  action_type: SignedIntent["actionType"];
  payload_json: string;
  hmac_sig: string;
  chat_id: string | null;
  message_id: string | null;
  inline_message_id: string | null;
  status: IntentStatus;
  tx_hash: string | null;
  expires_at: number;
  created_at: number;
}

interface RawClaimRow {
  claim_id: string;
  network: StellarNetwork;
  sender_address: string;
  recipient_tg_username: string;
  asset_code: string;
  asset_issuer: string | null;
  amount: string;
  escrow_contract_id: string;
  status: ClaimLink["status"];
  expires_at: number;
  created_at: number;
}

interface RawEncryptedBackupRow {
  telegram_user_id: string;
  network: StellarNetwork;
  envelope_json: string;
  envelope_sha256: string;
  version: number;
  created_at: number;
  updated_at: number;
}

interface RawConnectRequestRow {
  request_id: string;
  network: StellarNetwork;
  action: ConnectActionType;
  status: ConnectRequestStatus;
  trust_tier: ConnectAppTrustTier;
  hmac_sig: string;
  result_token_hash: string;
  app_json: string;
  payload_json: string;
  result_json: string | null;
  responder_tg_id: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

function mapConnectRequestRow(row: RawConnectRequestRow): ConnectRequestRecord {
  return {
    requestId: row.request_id,
    network: row.network,
    action: row.action,
    status: row.status,
    trustTier: row.trust_tier,
    hmacSig: row.hmac_sig,
    resultTokenHash: row.result_token_hash,
    appJson: row.app_json,
    payloadJson: row.payload_json,
    resultJson: row.result_json ?? undefined,
    responderTelegramUserId: row.responder_tg_id ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEncryptedBackupRow(row: RawEncryptedBackupRow): StoredEncryptedVaultBackup {
  return {
    telegramUserId: row.telegram_user_id,
    network: row.network,
    envelopeJson: row.envelope_json,
    envelopeSha256: row.envelope_sha256,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaimRow(row: RawClaimRow): ClaimLink {
  return {
    claimId: row.claim_id,
    network: row.network,
    senderAddress: row.sender_address as StellarAddress,
    recipientUsernameLower: row.recipient_tg_username,
    assetCode: row.asset_code,
    assetIssuer: (row.asset_issuer ?? undefined) as StellarAddress | undefined,
    amount: row.amount,
    escrowContractId: row.escrow_contract_id as ContractAddress,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

function mapUserRow(row: RawUserRow): TelegramUserRecord {
  return {
    telegramUserId: row.telegram_user_id,
    usernameLower: row.username_lower ?? undefined,
    alertsEnabled: row.alerts_enabled === 1,
  };
}

function mapIntentRow(row: RawIntentRow): SignedIntent {
  return {
    intentId: row.intent_id,
    network: row.network,
    creatorTelegramUserId: row.creator_tg_id,
    actionType: row.action_type,
    payloadJson: row.payload_json,
    hmacSig: row.hmac_sig,
    chatId: row.chat_id ?? undefined,
    messageId: row.message_id ?? undefined,
    inlineMessageId: row.inline_message_id ?? undefined,
    status: row.status,
    txHash: row.tx_hash ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createD1Repository(db: D1Database): ServerRepository {
  return {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      const now = Math.floor(Date.now() / 1000);
      const cleanUsername = usernameLower?.trim().replace(/^@/, "").toLowerCase() || null;
      const upsertStmt = db
        .prepare(
          `INSERT INTO tg_users (telegram_user_id, username_lower, alerts_enabled, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(telegram_user_id) DO UPDATE SET
             username_lower = COALESCE(excluded.username_lower, tg_users.username_lower),
             updated_at = excluded.updated_at`,
        )
        .bind(telegramUserId, cleanUsername, now, now);

      if (cleanUsername) {
        const clearStaleStmt = db
          .prepare(
            "UPDATE tg_users SET username_lower = NULL WHERE username_lower = ? AND telegram_user_id != ?",
          )
          .bind(cleanUsername, telegramUserId);
        await db.batch([clearStaleStmt, upsertStmt]);
      } else {
        await upsertStmt.run();
      }

      const row = await db
        .prepare(
          "SELECT telegram_user_id, username_lower, alerts_enabled FROM tg_users WHERE telegram_user_id = ?",
        )
        .bind(telegramUserId)
        .first<RawUserRow>();

      if (!row) {
        throw new Error("Failed to read upserted Telegram user");
      }
      return mapUserRow(row);
    },

    async getUserById(telegramUserId) {
      const row = await db
        .prepare(
          "SELECT telegram_user_id, username_lower, alerts_enabled FROM tg_users WHERE telegram_user_id = ?",
        )
        .bind(telegramUserId)
        .first<RawUserRow>();
      return row ? mapUserRow(row) : null;
    },

    async getUserByUsername(usernameLower) {
      const normalized = usernameLower.trim().replace(/^@/, "").toLowerCase();
      const row = await db
        .prepare(
          "SELECT telegram_user_id, username_lower, alerts_enabled FROM tg_users WHERE username_lower = ?",
        )
        .bind(normalized)
        .first<RawUserRow>();
      return row ? mapUserRow(row) : null;
    },

    async getUserByLinkedAddress(address) {
      const normalized = address.trim();
      const row = await db
        .prepare(
          `SELECT u.telegram_user_id, u.username_lower, u.alerts_enabled
           FROM linked_addresses la
           JOIN tg_users u ON u.telegram_user_id = la.telegram_user_id
           WHERE la.address = ?
           LIMIT 1`,
        )
        .bind(normalized)
        .first<RawUserRow>();
      return row ? mapUserRow(row) : null;
    },

    async setUserAlertsEnabled(telegramUserId, enabled) {
      const now = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          "UPDATE tg_users SET alerts_enabled = ?, updated_at = ? WHERE telegram_user_id = ?",
        )
        .bind(enabled ? 1 : 0, now, telegramUserId)
        .run();
    },

    async linkVerifiedAddresses({ telegramUserId, usernameLower, accounts }) {
      const now = Math.floor(Date.now() / 1000);
      const cleanUsername = usernameLower?.trim().replace(/^@/, "").toLowerCase() || null;
      const upsertStmt = db
        .prepare(
          `INSERT INTO tg_users (telegram_user_id, username_lower, alerts_enabled, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(telegram_user_id) DO UPDATE SET
             username_lower = COALESCE(excluded.username_lower, tg_users.username_lower),
             updated_at = excluded.updated_at`,
        )
        .bind(telegramUserId, cleanUsername, now, now);

      if (cleanUsername) {
        const clearStaleStmt = db
          .prepare(
            "UPDATE tg_users SET username_lower = NULL WHERE username_lower = ? AND telegram_user_id != ?",
          )
          .bind(cleanUsername, telegramUserId);
        await db.batch([clearStaleStmt, upsertStmt]);
      } else {
        await upsertStmt.run();
      }

      const existing = await this.listLinkedAddresses(telegramUserId);
      const hasDefaultAlready = existing.some((item) => item.isDefault);
      const requestSetsDefault = accounts.some((a) => a.isDefault);

      if (requestSetsDefault) {
        await db
          .prepare("UPDATE linked_addresses SET is_default = 0 WHERE telegram_user_id = ?")
          .bind(telegramUserId)
          .run();
      }

      for (let i = 0; i < accounts.length; i += 1) {
        const acc = accounts[i];
        if (!acc) continue;

        const existingMatch = await db
          .prepare(
            "SELECT id FROM linked_addresses WHERE telegram_user_id = ? AND address = ?",
          )
          .bind(telegramUserId, acc.address)
          .first<{ id: string }>();

        const makeDefault =
          Boolean(acc.isDefault) || (!hasDefaultAlready && !requestSetsDefault && i === 0);

        if (existingMatch) {
          await db
            .prepare(
              `UPDATE linked_addresses
               SET kind = ?, label = ?, is_default = ?, verified_sig_hash = ?
               WHERE id = ?`,
            )
            .bind(
              acc.kind,
              acc.label,
              makeDefault ? 1 : 0,
              acc.verifiedSigHash,
              existingMatch.id,
            )
            .run();
        } else {
          const id = `${telegramUserId}:${acc.address.slice(0, 12)}:${now}:${i}`;
          await db
            .prepare(
              `INSERT INTO linked_addresses
               (id, telegram_user_id, address, kind, label, is_default, verified_sig_hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              id,
              telegramUserId,
              acc.address,
              acc.kind,
              acc.label,
              makeDefault ? 1 : 0,
              acc.verifiedSigHash,
              now,
            )
            .run();
        }
      }

      return this.listLinkedAddresses(telegramUserId);
    },

    async listLinkedAddresses(telegramUserId) {
      const result = await db
        .prepare(
          `SELECT la.telegram_user_id, u.username_lower, la.address, la.kind, la.label, la.is_default
           FROM linked_addresses la
           JOIN tg_users u ON u.telegram_user_id = la.telegram_user_id
           WHERE la.telegram_user_id = ?
           ORDER BY la.is_default DESC, la.created_at ASC`,
        )
        .bind(telegramUserId)
        .all<RawLinkedAddressRow>();

      return (result.results ?? []).map((row) => ({
        telegramUserId: row.telegram_user_id,
        usernameLower: row.username_lower ?? undefined,
        address: row.address,
        kind: row.kind,
        label: row.label,
        isDefault: row.is_default === 1,
      }));
    },

    async setDefaultLinkedAddress(telegramUserId, address) {
      const match = await db
        .prepare(
          "SELECT id FROM linked_addresses WHERE telegram_user_id = ? AND address = ?",
        )
        .bind(telegramUserId, address)
        .first<{ id: string }>();
      if (!match) return false;

      await db
        .prepare("UPDATE linked_addresses SET is_default = 0 WHERE telegram_user_id = ?")
        .bind(telegramUserId)
        .run();
      await db
        .prepare("UPDATE linked_addresses SET is_default = 1 WHERE id = ?")
        .bind(match.id)
        .run();
      return true;
    },

    async unlinkAddress(telegramUserId, address) {
      const res = await db
        .prepare(
          "DELETE FROM linked_addresses WHERE telegram_user_id = ? AND address = ?",
        )
        .bind(telegramUserId, address)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    async unlinkUserAddresses(telegramUserId) {
      const res = await db
        .prepare("DELETE FROM linked_addresses WHERE telegram_user_id = ?")
        .bind(telegramUserId)
        .run();
      return res.meta?.changes ?? 0;
    },

    async isAddressLinked(address) {
      const row = await db
        .prepare("SELECT 1 AS hit FROM linked_addresses WHERE address = ? LIMIT 1")
        .bind(address)
        .first<{ hit: number }>();
      return Boolean(row);
    },

    async listWatchedAccounts() {
      const result = await db
        .prepare(
          `SELECT la.telegram_user_id, la.address, la.label
           FROM linked_addresses la
           JOIN tg_users u ON u.telegram_user_id = la.telegram_user_id
           WHERE u.alerts_enabled = 1`,
        )
        .all<{ telegram_user_id: string; address: string; label: string }>();

      return (result.results ?? []).map((row) => ({
        telegramUserId: row.telegram_user_id,
        address: row.address,
        label: row.label,
      }));
    },

    async createSignedIntent(intent) {
      await db
        .prepare(
          `INSERT INTO signed_intents
           (intent_id, network, creator_tg_id, action_type, payload_json, hmac_sig, chat_id, message_id, inline_message_id, status, tx_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          intent.intentId,
          intent.network,
          intent.creatorTelegramUserId,
          intent.actionType,
          intent.payloadJson,
          intent.hmacSig,
          intent.chatId ?? null,
          intent.messageId ?? null,
          intent.inlineMessageId ?? null,
          intent.status,
          intent.txHash ?? null,
          intent.expiresAt,
          intent.createdAt,
        )
        .run();
      return intent;
    },

    async getSignedIntent(intentId) {
      const row = await db
        .prepare("SELECT * FROM signed_intents WHERE intent_id = ?")
        .bind(intentId)
        .first<RawIntentRow>();
      return row ? mapIntentRow(row) : null;
    },

    async attachIntentMessageRef(intentId, ref) {
      await db
        .prepare(
          `UPDATE signed_intents
           SET chat_id = COALESCE(?, chat_id),
               message_id = COALESCE(?, message_id),
               inline_message_id = COALESCE(?, inline_message_id)
           WHERE intent_id = ?`,
        )
        .bind(
          ref.chatId ?? null,
          ref.messageId ?? null,
          ref.inlineMessageId ?? null,
          intentId,
        )
        .run();
    },

    async markIntentConfirmed(intentId, txHash) {
      await db
        .prepare(
          `UPDATE signed_intents
           SET status = 'confirmed',
               tx_hash = COALESCE(?, tx_hash)
           WHERE intent_id = ?`,
        )
        .bind(txHash ?? null, intentId)
        .run();
      return this.getSignedIntent(intentId);
    },

    async markIntentStatus(intentId, status) {
      await db
        .prepare("UPDATE signed_intents SET status = ? WHERE intent_id = ?")
        .bind(status, intentId)
        .run();
      return this.getSignedIntent(intentId);
    },

    async createClaimLink(claim) {
      const now = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          `INSERT INTO claim_links
           (claim_id, network, sender_address, recipient_tg_username, asset_code, asset_issuer, amount, escrow_contract_id, status, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          claim.claimId,
          claim.network,
          claim.senderAddress,
          claim.recipientUsernameLower,
          claim.assetCode,
          claim.assetIssuer ?? null,
          claim.amount,
          claim.escrowContractId,
          claim.status,
          claim.expiresAt,
          now,
        )
        .run();
      return claim;
    },

    async getClaimLink(claimId) {
      const row = await db
        .prepare("SELECT * FROM claim_links WHERE claim_id = ?")
        .bind(claimId)
        .first<RawClaimRow>();
      return row ? mapClaimRow(row) : null;
    },

    async markClaimLinkStatus(claimId, status) {
      await db
        .prepare("UPDATE claim_links SET status = ? WHERE claim_id = ?")
        .bind(status, claimId)
        .run();
      return this.getClaimLink(claimId);
    },

    async isTxHashUsed(txHash) {
      const normalized = txHash.toLowerCase();
      const intentRow = await db
        .prepare("SELECT 1 AS hit FROM signed_intents WHERE lower(tx_hash) = ? LIMIT 1")
        .bind(normalized)
        .first<{ hit: number }>();
      if (intentRow) return true;
      const payRow = await db
        .prepare("SELECT 1 AS hit FROM intent_payments WHERE lower(tx_hash) = ? LIMIT 1")
        .bind(normalized)
        .first<{ hit: number }>();
      return Boolean(payRow);
    },

    async recordSplitPayment({ intentId, payerAddress, txHash, amount }) {
      const now = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          `INSERT INTO intent_payments (id, intent_id, payer_address, tx_hash, amount, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${intentId}:${txHash.slice(0, 16)}`,
          intentId,
          payerAddress ?? null,
          txHash.toLowerCase(),
          amount,
          now,
        )
        .run();
      return { paidCount: await this.countSplitPayments(intentId) };
    },

    async countSplitPayments(intentId) {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM intent_payments WHERE intent_id = ?")
        .bind(intentId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async listSplitPaymentTxHashes(intentId) {
      const result = await db
        .prepare(
          "SELECT tx_hash FROM intent_payments WHERE intent_id = ? ORDER BY created_at ASC",
        )
        .bind(intentId)
        .all<{ tx_hash: string }>();
      return (result.results ?? []).map((r) => r.tx_hash);
    },

    async claimAlertDedupKey(dedupKey) {
      const now = Math.floor(Date.now() / 1000);
      const res = await db
        .prepare("INSERT OR IGNORE INTO processed_alerts (dedup_key, created_at) VALUES (?, ?)")
        .bind(dedupKey, now)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    async findRecentPendingIntent({ creatorTelegramUserId, actionType, payloadJson, sinceUnix }) {
      const row = await db
        .prepare(
          `SELECT * FROM signed_intents
           WHERE creator_tg_id = ? AND action_type = ? AND payload_json = ?
             AND status = 'pending' AND created_at >= ? AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(
          creatorTelegramUserId,
          actionType,
          payloadJson,
          sinceUnix,
          Math.floor(Date.now() / 1000),
        )
        .first<RawIntentRow>();
      return row ? mapIntentRow(row) : null;
    },

    async incrementRateLimit({ key, windowSec, limit, nowSec }) {
      const now = nowSec ?? Math.floor(Date.now() / 1000);
      const windowId = Math.floor(now / windowSec);
      const resetAt = (windowId + 1) * windowSec;
      const bucketKey = `${key}:${windowId}`;
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (key, count, reset_at)
           VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1
           RETURNING count`,
        )
        .bind(bucketKey, resetAt)
        .first<{ count: number }>();
      const count = row?.count ?? 1;
      return {
        allowed: count <= limit,
        count,
        retryAfterSeconds: Math.max(1, resetAt - now),
      };
    },

    async tryConsumeRelayBudget({ dayUtc, feeStroops, dailyBudgetStroops }) {
      if (!/^\d+$/.test(feeStroops) || !/^\d+$/.test(dailyBudgetStroops)) {
        return { allowed: false, spentStroops: "0" };
      }
      const feeInt = Number(BigInt(feeStroops));
      const budgetInt = Number(BigInt(dailyBudgetStroops));
      if (!Number.isSafeInteger(feeInt) || !Number.isSafeInteger(budgetInt)) {
        return { allowed: false, spentStroops: "0" };
      }

      await db
        .prepare(
          "INSERT OR IGNORE INTO relay_daily_usage (day_utc, spent_stroops, tx_count) VALUES (?, '0', 0)",
        )
        .bind(dayUtc)
        .run();

      const updated = await db
        .prepare(
          `UPDATE relay_daily_usage
           SET spent_stroops = CAST(CAST(spent_stroops AS INTEGER) + ? AS TEXT),
               tx_count = tx_count + 1
           WHERE day_utc = ? AND (CAST(spent_stroops AS INTEGER) + ?) <= ?
           RETURNING spent_stroops`,
        )
        .bind(feeInt, dayUtc, feeInt, budgetInt)
        .first<{ spent_stroops: string }>();

      if (updated) {
        return { allowed: true, spentStroops: updated.spent_stroops };
      }
      const current = await db
        .prepare("SELECT spent_stroops FROM relay_daily_usage WHERE day_utc = ?")
        .bind(dayUtc)
        .first<{ spent_stroops: string }>();
      return {
        allowed: false,
        spentStroops: current?.spent_stroops ?? dailyBudgetStroops,
      };
    },

    async claimTelegramUpdateId(updateId, nowSec) {
      const now = nowSec ?? Math.floor(Date.now() / 1000);
      const res = await db
        .prepare("INSERT OR IGNORE INTO processed_tg_updates (update_id, processed_at) VALUES (?, ?)")
        .bind(updateId, now)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    async purgeExpiredRecords(nowSec) {
      await db.batch([
        db.prepare("DELETE FROM signed_intents WHERE expires_at < ?").bind(nowSec - 3600),
        db.prepare("DELETE FROM connect_requests WHERE expires_at < ?").bind(nowSec - 3600),
        db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(nowSec - 300),
        db
          .prepare("DELETE FROM processed_tg_updates WHERE processed_at < ?")
          .bind(nowSec - 7 * 86_400),
        db
          .prepare("DELETE FROM processed_alerts WHERE created_at < ?")
          .bind(nowSec - 30 * 86_400),
      ]);
    },

    async upsertEncryptedVaultBackup({
      telegramUserId,
      network,
      envelopeJson,
      envelopeSha256,
      version = 1,
      updatedAt,
    }) {
      const now = Math.floor(Date.now() / 1000);
      const effectiveUpdatedAt =
        typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
          ? Math.floor(updatedAt)
          : now;
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO tg_users (telegram_user_id, username_lower, alerts_enabled, created_at, updated_at)
             VALUES (?, NULL, 1, ?, ?)`,
          )
          .bind(telegramUserId, now, now),
        db
          .prepare(
            `INSERT INTO encrypted_vault_backups
             (telegram_user_id, network, envelope_json, envelope_sha256, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(telegram_user_id, network) DO UPDATE SET
               envelope_json = excluded.envelope_json,
               envelope_sha256 = excluded.envelope_sha256,
               version = excluded.version,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at >= encrypted_vault_backups.updated_at`,
          )
          .bind(
            telegramUserId,
            network,
            envelopeJson,
            envelopeSha256,
            version,
            now,
            effectiveUpdatedAt,
          ),
      ]);

      const row = await db
        .prepare(
          `SELECT telegram_user_id, network, envelope_json, envelope_sha256, version, created_at, updated_at
           FROM encrypted_vault_backups
           WHERE telegram_user_id = ? AND network = ?`,
        )
        .bind(telegramUserId, network)
        .first<RawEncryptedBackupRow>();
      if (!row) {
        throw new Error("Failed to read stored encrypted vault backup");
      }
      return mapEncryptedBackupRow(row);
    },

    async getEncryptedVaultBackup(telegramUserId, network) {
      const row = await db
        .prepare(
          `SELECT telegram_user_id, network, envelope_json, envelope_sha256, version, created_at, updated_at
           FROM encrypted_vault_backups
           WHERE telegram_user_id = ? AND network = ?`,
        )
        .bind(telegramUserId, network)
        .first<RawEncryptedBackupRow>();
      return row ? mapEncryptedBackupRow(row) : null;
    },

    async deleteEncryptedVaultBackup(telegramUserId, network) {
      const res = await db
        .prepare(
          "DELETE FROM encrypted_vault_backups WHERE telegram_user_id = ? AND network = ?",
        )
        .bind(telegramUserId, network)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    async createConnectRequest(req) {
      await db
        .prepare(
          `INSERT INTO connect_requests
           (request_id, network, action, status, trust_tier, hmac_sig, result_token_hash, app_json, payload_json, result_json, responder_tg_id, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          req.requestId,
          req.network,
          req.action,
          req.status,
          req.trustTier,
          req.hmacSig,
          req.resultTokenHash,
          req.appJson,
          req.payloadJson,
          req.resultJson ?? null,
          req.responderTelegramUserId ?? null,
          req.expiresAt,
          req.createdAt,
          req.updatedAt,
        )
        .run();
      return req;
    },

    async getConnectRequest(requestId) {
      const row = await db
        .prepare("SELECT * FROM connect_requests WHERE request_id = ?")
        .bind(requestId)
        .first<RawConnectRequestRow>();
      return row ? mapConnectRequestRow(row) : null;
    },

    async completeConnectRequest({
      requestId,
      status,
      resultJson,
      responderTelegramUserId,
      updatedAt,
    }) {
      const res = await db
        .prepare(
          `UPDATE connect_requests
           SET status = ?,
               result_json = COALESCE(?, result_json),
               responder_tg_id = COALESCE(?, responder_tg_id),
               updated_at = ?
           WHERE request_id = ? AND status = 'pending'`,
        )
        .bind(
          status,
          resultJson ?? null,
          responderTelegramUserId ?? null,
          updatedAt,
          requestId,
        )
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        return null;
      }
      return this.getConnectRequest(requestId);
    },
  };
}
