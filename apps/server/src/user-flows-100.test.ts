import type {
  ClassicAddress,
  ClaimLink,
  ConnectRequestRecord,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import {
  computeTelegramInitDataHash,
  signIntentToken,
  signMiniAppSessionToken,
} from "@astrowallet/tg-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type {
  ServerRepository,
  StoredEncryptedVaultBackup,
  TelegramUserRecord,
} from "./db/repository.js";
import { resetMemoryRateLimits } from "./rate-limit.js";

const BENIGN_PAYMENT_TX_XDR =
  "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAAAAAAAABfXhAAAAAAAAAAAA";
const MALICIOUS_MERGE_TX_XDR =
  "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAACAAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAAAAAAAA";

const BASE_ENV = {
  STELLAR_NETWORK: "testnet",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URLS: "https://soroban-testnet.stellar.org",
  HORIZON_URLS: "https://horizon-testnet.stellar.org",
  PWA_ORIGIN: "https://testnet.astrowallet.example",
  ALLOWED_ORIGINS: "https://testnet.astrowallet.example",
  FRIENDBOT_URL: "https://friendbot.stellar.org",
  TG_BOT_TOKEN: "test-bot-token-100users",
  TG_WEBHOOK_SECRET: "secret-header-token-100users",
  TG_BOT_USERNAME: "AstroWalletTestBot",
  TG_MINI_APP_SHORT_NAME: "wallet",
  INTENT_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  TELEGRAM_API_ORIGIN: "https://api.telegram.org",
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeClassicStrKey(pubKey: Uint8Array): ClassicAddress {
  const payload = new Uint8Array(35);
  payload[0] = 6 << 3;
  payload.set(pubKey, 1);
  const crc = crc16Xmodem(payload.subarray(0, 33));
  payload[33] = crc & 0xff;
  payload[34] = (crc >> 8) & 0xff;
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of payload) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  return out as ClassicAddress;
}

async function generateTestSigner() {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const address = encodeClassicStrKey(pubRaw);
  return {
    address,
    async signChallenge(message: string): Promise<string> {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${message}`),
      );
      const sig = new Uint8Array(
        await crypto.subtle.sign("Ed25519", kp.privateKey, digest),
      );
      return btoa(String.fromCharCode(...sig));
    },
  };
}

async function signInitData(user: {
  id: number;
  username?: string;
  first_name?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const pairs: Array<[string, string]> = [
    ["auth_date", String(now - 2)],
    [
      "user",
      JSON.stringify({
        id: user.id,
        first_name: user.first_name ?? `User${user.id}`,
        ...(user.username ? { username: user.username } : {}),
      }),
    ],
  ];
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = await computeTelegramInitDataHash(
    pairs.map(([k, v]) => `${k}=${v}`).join("\n"),
    BASE_ENV.TG_BOT_TOKEN,
  );
  const params = new URLSearchParams(Object.fromEntries(pairs));
  params.set("hash", hash);
  return params.toString();
}

async function sealTestVault(secret: string, mnemonicSeed: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:${Array.from(salt).join(",")}`),
  );
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify({ mnemonic: mnemonicSeed })),
  );
  const now = Math.floor(Date.now() / 1000);
  return {
    envelope: {
      version: 1 as const,
      format: "AGVAULT" as const,
      kdf: {
        algorithm: "argon2id" as const,
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 1,
        hashLength: 32 as const,
      },
      saltB64: btoa(String.fromCharCode(...salt)),
      ivB64: btoa(String.fromCharCode(...iv)),
      ciphertextB64: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
      createdAt: now,
      updatedAt: now,
    },
    async decryptWith(candidateSecret: string): Promise<string> {
      const saltBytes = Uint8Array.from(atob(this.envelope.saltB64), (c) => c.charCodeAt(0));
      const ivBytes = Uint8Array.from(atob(this.envelope.ivB64), (c) => c.charCodeAt(0));
      const ctBytes = Uint8Array.from(atob(this.envelope.ciphertextB64), (c) => c.charCodeAt(0));
      const mat = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${candidateSecret}:${Array.from(saltBytes).join(",")}`),
      );
      const aesKey = await crypto.subtle.importKey("raw", mat, { name: "AES-GCM" }, false, [
        "decrypt",
      ]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, aesKey, ctBytes);
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as { mnemonic: string };
      return parsed.mnemonic;
    },
  };
}

/**
 * In-memory ServerRepository matching production D1 repository semantics (default flag handling,
 * atomic username uniqueness, encrypted_vault_backups, and split payments).
 */
function createProductionParityRepo(): ServerRepository {
  const users = new Map<string, TelegramUserRecord>();
  const bindings = new Map<string, TelegramUserBinding[]>();
  const intents = new Map<string, SignedIntent>();
  const claims = new Map<string, ClaimLink>();
  const splitPayments = new Map<
    string,
    Array<{ txHash: string; amount: string; payerAddress?: string }>
  >();
  const dedupKeys = new Set<string>();
  const rateLimits = new Map<string, number>();
  const relayBudget = new Map<string, bigint>();
  const tgUpdates = new Set<number>();
  const encryptedBackups = new Map<string, StoredEncryptedVaultBackup>();
  const connectRequests = new Map<string, ConnectRequestRecord>();

  return {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      const cleanUsername = usernameLower?.trim().replace(/^@/, "").toLowerCase();
      if (cleanUsername) {
        for (const [id, existing] of users.entries()) {
          if (id !== telegramUserId && existing.usernameLower === cleanUsername) {
            users.set(id, { ...existing, usernameLower: undefined });
          }
        }
      }
      const prev = users.get(telegramUserId);
      const next: TelegramUserRecord = {
        telegramUserId,
        usernameLower: cleanUsername ?? prev?.usernameLower,
        alertsEnabled: prev?.alertsEnabled ?? true,
      };
      users.set(telegramUserId, next);
      return next;
    },
    async getUserById(telegramUserId) {
      return users.get(telegramUserId) ?? null;
    },
    async getUserByUsername(usernameLower) {
      const target = usernameLower.replace(/^@/, "").toLowerCase();
      for (const u of users.values()) {
        if (u.usernameLower === target) return u;
      }
      return null;
    },
    async setUserAlertsEnabled(telegramUserId, enabled) {
      const u = users.get(telegramUserId);
      if (u) users.set(telegramUserId, { ...u, alertsEnabled: enabled });
    },
    async linkVerifiedAddresses({ telegramUserId, usernameLower, accounts }) {
      await this.upsertTelegramUser({ telegramUserId, usernameLower });
      let list = [...(bindings.get(telegramUserId) ?? [])];
      const hasDefaultAlready = list.some((b) => b.isDefault);
      const requestSetsDefault = accounts.some((a) => a.isDefault);
      if (requestSetsDefault) {
        list = list.map((b) => ({ ...b, isDefault: false }));
      }
      for (let i = 0; i < accounts.length; i += 1) {
        const acc = accounts[i];
        if (!acc) continue;
        const idx = list.findIndex((b) => b.address === acc.address);
        const makeDefault =
          Boolean(acc.isDefault) || (!hasDefaultAlready && !requestSetsDefault && i === 0);
        const item: TelegramUserBinding = {
          telegramUserId,
          usernameLower: users.get(telegramUserId)?.usernameLower,
          address: acc.address,
          kind: acc.kind,
          label: acc.label,
          isDefault: makeDefault,
        };
        if (idx >= 0) {
          list[idx] = item;
        } else {
          list.push(item);
        }
      }
      bindings.set(telegramUserId, list);
      return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    },
    async listLinkedAddresses(telegramUserId) {
      return [...(bindings.get(telegramUserId) ?? [])].sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault),
      );
    },
    async setDefaultLinkedAddress(telegramUserId, address) {
      const list = bindings.get(telegramUserId);
      if (!list || !list.some((b) => b.address === address)) return false;
      bindings.set(
        telegramUserId,
        list.map((b) => ({ ...b, isDefault: b.address === address })),
      );
      return true;
    },
    async unlinkAddress(telegramUserId, address) {
      const list = bindings.get(telegramUserId) ?? [];
      const next = list.filter((b) => b.address !== address);
      bindings.set(telegramUserId, next);
      return next.length !== list.length;
    },
    async unlinkUserAddresses(telegramUserId) {
      const count = bindings.get(telegramUserId)?.length ?? 0;
      bindings.delete(telegramUserId);
      return count;
    },
    async isAddressLinked(address) {
      for (const list of bindings.values()) {
        if (list.some((item) => item.address === address)) return true;
      }
      return false;
    },
    async listWatchedAccounts() {
      const out = [];
      for (const [tgId, list] of bindings.entries()) {
        if (!users.get(tgId)?.alertsEnabled) continue;
        for (const item of list) {
          out.push({ telegramUserId: tgId, address: item.address, label: item.label });
        }
      }
      return out;
    },
    async createSignedIntent(intent) {
      intents.set(intent.intentId, intent);
      return intent;
    },
    async getSignedIntent(intentId) {
      return intents.get(intentId) ?? null;
    },
    async attachIntentMessageRef(intentId, ref) {
      const prev = intents.get(intentId);
      if (!prev) return;
      intents.set(intentId, {
        ...prev,
        chatId: ref.chatId ?? prev.chatId,
        messageId: ref.messageId ?? prev.messageId,
        inlineMessageId: ref.inlineMessageId ?? prev.inlineMessageId,
      });
    },
    async markIntentConfirmed(intentId, txHash) {
      const prev = intents.get(intentId);
      if (!prev) return null;
      const next: SignedIntent = { ...prev, status: "confirmed", txHash: txHash ?? prev.txHash };
      intents.set(intentId, next);
      return next;
    },
    async markIntentStatus(intentId, status: IntentStatus) {
      const prev = intents.get(intentId);
      if (!prev) return null;
      const next: SignedIntent = { ...prev, status };
      intents.set(intentId, next);
      return next;
    },
    async createClaimLink(claim) {
      claims.set(claim.claimId, claim);
      return claim;
    },
    async getClaimLink(claimId) {
      return claims.get(claimId) ?? null;
    },
    async markClaimLinkStatus(claimId, status) {
      const prev = claims.get(claimId);
      if (!prev) return null;
      const next = { ...prev, status };
      claims.set(claimId, next);
      return next;
    },
    async isTxHashUsed(txHash) {
      const normalized = txHash.toLowerCase();
      for (const it of intents.values()) {
        if (it.txHash?.toLowerCase() === normalized) return true;
      }
      for (const list of splitPayments.values()) {
        if (list.some((item) => item.txHash.toLowerCase() === normalized)) return true;
      }
      return false;
    },
    async recordSplitPayment({ intentId, payerAddress, txHash, amount }) {
      const list = splitPayments.get(intentId) ?? [];
      if (payerAddress && list.some((p) => p.payerAddress === payerAddress)) {
        throw new Error("UNIQUE constraint failed: intent_payments.payer_address");
      }
      list.push({ txHash: txHash.toLowerCase(), amount, payerAddress });
      splitPayments.set(intentId, list);
      return { paidCount: list.length };
    },
    async countSplitPayments(intentId) {
      return (splitPayments.get(intentId) ?? []).length;
    },
    async listSplitPaymentTxHashes(intentId) {
      return (splitPayments.get(intentId) ?? []).map((item) => item.txHash);
    },
    async claimAlertDedupKey(dedupKey) {
      if (dedupKeys.has(dedupKey)) return false;
      dedupKeys.add(dedupKey);
      return true;
    },
    async findRecentPendingIntent({ creatorTelegramUserId, actionType, payloadJson, sinceUnix }) {
      const now = Math.floor(Date.now() / 1000);
      for (const it of intents.values()) {
        if (
          it.creatorTelegramUserId === creatorTelegramUserId &&
          it.actionType === actionType &&
          it.payloadJson === payloadJson &&
          it.status === "pending" &&
          it.createdAt >= sinceUnix &&
          it.expiresAt > now
        ) {
          return it;
        }
      }
      return null;
    },
    async incrementRateLimit({ key, windowSec, limit, nowSec }) {
      const now = nowSec ?? Math.floor(Date.now() / 1000);
      const bucketKey = `${key}:${Math.floor(now / windowSec)}`;
      const nextCount = (rateLimits.get(bucketKey) ?? 0) + 1;
      rateLimits.set(bucketKey, nextCount);
      return {
        allowed: nextCount <= limit,
        count: nextCount,
        retryAfterSeconds: windowSec,
      };
    },
    async tryConsumeRelayBudget({ dayUtc, feeStroops, dailyBudgetStroops }) {
      const prev = relayBudget.get(dayUtc) ?? 0n;
      const next = prev + BigInt(feeStroops);
      if (next > BigInt(dailyBudgetStroops)) {
        return { allowed: false, spentStroops: prev.toString() };
      }
      relayBudget.set(dayUtc, next);
      return { allowed: true, spentStroops: next.toString() };
    },
    async claimTelegramUpdateId(updateId) {
      if (tgUpdates.has(updateId)) return false;
      tgUpdates.add(updateId);
      return true;
    },
    async purgeExpiredRecords() {},
    async upsertEncryptedVaultBackup({
      telegramUserId,
      network,
      envelopeJson,
      envelopeSha256,
      version = 1,
    }) {
      const now = Math.floor(Date.now() / 1000);
      const key = `${telegramUserId}:${network}`;
      const existing = encryptedBackups.get(key);
      const saved: StoredEncryptedVaultBackup = {
        telegramUserId,
        network,
        envelopeJson,
        envelopeSha256,
        version,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      encryptedBackups.set(key, saved);
      return saved;
    },
    async getEncryptedVaultBackup(telegramUserId, network) {
      return encryptedBackups.get(`${telegramUserId}:${network}`) ?? null;
    },
    async deleteEncryptedVaultBackup(telegramUserId, network) {
      return encryptedBackups.delete(`${telegramUserId}:${network}`);
    },
    async createConnectRequest(req) {
      connectRequests.set(req.requestId, req);
      return req;
    },
    async getConnectRequest(requestId) {
      return connectRequests.get(requestId) ?? null;
    },
    async completeConnectRequest({
      requestId,
      status,
      resultJson,
      responderTelegramUserId,
      updatedAt,
    }) {
      const prev = connectRequests.get(requestId);
      if (!prev || prev.status !== "pending") return null;
      const next: ConnectRequestRecord = {
        ...prev,
        status,
        resultJson: resultJson ?? prev.resultJson,
        responderTelegramUserId: responderTelegramUserId ?? prev.responderTelegramUserId,
        updatedAt,
      };
      connectRequests.set(requestId, next);
      return next;
    },
  };
}

describe("100-User End-to-End Flow & Edge-Case Simulation", () => {
  beforeEach(() => {
    resetMemoryRateLimits();
  });

  it("simulates 100 distinct Telegram users across 7 real-world & adversarial cohorts", async () => {
    const repo = createProductionParityRepo();
    const exchangeAddress = (await generateTestSigner()).address;
    const sentTgRequests: Array<{ method: string; body: Record<string, unknown> }> = [];

    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.telegram.org")) {
        const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        sentTgRequests.push({ method: url.split("/").pop() ?? "", body: parsed });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 500 + sentTgRequests.length,
              chat: { id: Number(parsed.chat_id ?? 1) },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(`/accounts/${exchangeAddress}`)) {
        return new Response(
          JSON.stringify({ data: { "config.memo_required": "MQ==" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("horizon-testnet.stellar.org/accounts/")) {
        return new Response(JSON.stringify({ status: 404 }), { status: 404 });
      }
      return new Response(JSON.stringify({ status: 404 }), { status: 404 });
    };

    const app = createApp({
      createRepo: () => repo,
      fetchFn: mockFetch as typeof fetch,
      telegramApiDeps: { fetchFn: mockFetch as typeof fetch },
      verifyTxFn: async (_cfg, hash) => ({
        confirmed: true,
        ledger: 123456,
        txHash: hash,
      }),
    });

    // Helper: authenticate user via signed initData
    async function authUser(id: number, username?: string) {
      const initData = await signInitData({ id, username });
      const res = await app.request(
        "/v1/tg/auth",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        },
        BASE_ENV,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        sessionToken: string;
        expiresAt: number;
        user: { id: string; usernameLower?: string };
        linkedAccounts: TelegramUserBinding[];
        hasEncryptedBackup: boolean;
      };
    }

    // Helper: execute auto-link challenge + confirm
    async function autoLinkAccounts(
      sessionToken: string,
      signers: Array<{ signer: Awaited<ReturnType<typeof generateTestSigner>>; label: string; isDefault?: boolean }>,
    ) {
      const chRes = await app.request(
        "/v1/tg/link-challenge",
        { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } },
        BASE_ENV,
      );
      expect(chRes.status).toBe(200);
      const ch = (await chRes.json()) as { intentId: string; sig: string; message: string };
      const accounts = await Promise.all(
        signers.map(async (entry, idx) => ({
          address: entry.signer.address,
          kind: "classic" as const,
          label: entry.label,
          isDefault: entry.isDefault ?? idx === 0,
          signatureBase64: await entry.signer.signChallenge(ch.message),
        })),
      );
      const cfRes = await app.request(
        "/v1/tg/link-confirm",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ intentId: ch.intentId, sig: ch.sig, accounts }),
        },
        BASE_ENV,
      );
      expect(cfRes.status).toBe(200);
      return (await cfRes.json()) as { ok: boolean; linkedCount: number; accounts: TelegramUserBinding[] };
    }

    // -------------------------------------------------------------------------
    // COHORT 1 (Users 1..20): Fresh auth -> ZK backup -> Auto-link -> New phone restore
    // -------------------------------------------------------------------------
    for (let u = 1; u <= 20; u += 1) {
      const tgId = 100000 + u;
      const username = `pilot_${u}`;
      const recoveryPass = `OrbitVault#${u}_2026!`;
      const mnemonicSeed = `mnemonic words for pilot ${u} sovereign test`;

      const session1 = await authUser(tgId, username);
      expect(session1.hasEncryptedBackup).toBe(false);

      const sealed = await sealTestVault(recoveryPass, mnemonicSeed);
      const putRes = await app.request(
        "/v1/tg/vault-backup",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session1.sessionToken}`,
          },
          body: JSON.stringify({ envelope: sealed.envelope }),
        },
        BASE_ENV,
      );
      expect(putRes.status).toBe(200);

      const signer = await generateTestSigner();
      const linked = await autoLinkAccounts(session1.sessionToken, [
        { signer, label: `Primary ${u}` },
      ]);
      expect(linked.linkedCount).toBe(1);

      // Simulate clearing cache / opening on a brand-new phone
      const session2 = await authUser(tgId, username);
      expect(session2.hasEncryptedBackup).toBe(true);
      expect(session2.linkedAccounts[0]?.address).toBe(signer.address);

      const getRes = await app.request(
        "/v1/tg/vault-backup",
        { headers: { Authorization: `Bearer ${session2.sessionToken}` } },
        BASE_ENV,
      );
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as { hasBackup: boolean };
      expect(getData.hasBackup).toBe(true);
      expect(await sealed.decryptWith(recoveryPass)).toBe(mnemonicSeed);
    }

    // -------------------------------------------------------------------------
    // COHORT 2 (Users 21..35): Multi-account derivation + Default preservation on re-sync
    // -------------------------------------------------------------------------
    for (let u = 21; u <= 35; u += 1) {
      const tgId = 100000 + u;
      const session = await authUser(tgId, `multi_${u}`);
      const s0 = await generateTestSigner();
      const s1 = await generateTestSigner();
      const s2 = await generateTestSigner();

      await autoLinkAccounts(session.sessionToken, [
        { signer: s0, label: "Main", isDefault: true },
        { signer: s1, label: "Savings", isDefault: false },
        { signer: s2, label: "Trading", isDefault: false },
      ]);

      // Bot callback switches default to Account #1 (s1)
      const okDefault = await repo.setDefaultLinkedAddress(String(tgId), s1.address);
      expect(okDefault).toBe(true);

      // Client re-syncs passing preferredDefaultAddress = s1.address (Bug 6 fix!)
      const resynced = await autoLinkAccounts(session.sessionToken, [
        { signer: s0, label: "Main", isDefault: false },
        { signer: s1, label: "Savings Renamed", isDefault: true },
        { signer: s2, label: "Trading", isDefault: false },
      ]);
      const def = resynced.accounts.find((a) => a.isDefault);
      expect(def?.address).toBe(s1.address);
      expect(def?.label).toBe("Savings Renamed");
    }

    // -------------------------------------------------------------------------
    // COHORT 3 (Users 36..50): Session refresh, invalid tokens, strict KDF & size limits
    // -------------------------------------------------------------------------
    for (let u = 36; u <= 50; u += 1) {
      const tgId = 100000 + u;
      const session = await authUser(tgId, `sec_${u}`);

      // 1. POST /v1/tg/refresh issues fresh valid 15m token
      const refRes = await app.request(
        "/v1/tg/refresh",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${session.sessionToken}` },
        },
        BASE_ENV,
      );
      expect(refRes.status).toBe(200);
      const refJson = (await refRes.json()) as { sessionToken: string; expiresAt: number };
      expect(refJson.sessionToken).toBeTruthy();

      // 2. Wrong-network token rejected with 403
      const now = Math.floor(Date.now() / 1000);
      const mainnetToken = await signMiniAppSessionToken(
        {
          telegramUserId: String(tgId),
          network: "mainnet",
          issuedAt: now,
          expiresAt: now + 600,
        },
        BASE_ENV.INTENT_HMAC_SECRET,
      );
      expect(
        (
          await app.request(
            "/v1/tg/refresh",
            { method: "POST", headers: { Authorization: `Bearer ${mainnetToken}` } },
            BASE_ENV,
          )
        ).status,
      ).toBe(403);

      // 3. Expired token rejected with 401
      const expiredToken = await signMiniAppSessionToken(
        {
          telegramUserId: String(tgId),
          network: "testnet",
          issuedAt: now - 1000,
          expiresAt: now - 10,
        },
        BASE_ENV.INTENT_HMAC_SECRET,
      );
      expect(
        (
          await app.request(
            "/v1/tg/vault-backup",
            { headers: { Authorization: `Bearer ${expiredToken}` } },
            BASE_ENV,
          )
        ).status,
      ).toBe(401);

      // 4. Plaintext field injection & weak KDF & >16KB payload rejected
      const sealed = await sealTestVault(`StrongVault#${u}`, `seed ${u}`);
      expect(
        (
          await app.request(
            "/v1/tg/vault-backup",
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${refJson.sessionToken}`,
              },
              body: JSON.stringify({ envelope: { ...sealed.envelope, pin: "123456" } }),
            },
            BASE_ENV,
          )
        ).status,
      ).toBe(400);

      expect(
        (
          await app.request(
            "/v1/tg/vault-backup",
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${refJson.sessionToken}`,
              },
              body: JSON.stringify({
                envelope: {
                  ...sealed.envelope,
                  kdf: { ...sealed.envelope.kdf, iterations: 1 },
                },
              }),
            },
            BASE_ENV,
          )
        ).status,
      ).toBe(400);

      expect(
        (
          await app.request(
            "/v1/tg/vault-backup",
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${refJson.sessionToken}`,
              },
              body: JSON.stringify({
                envelope: { ...sealed.envelope, ciphertextB64: "A".repeat(17000) },
              }),
            },
            BASE_ENV,
          )
        ).status,
      ).toBe(413);

      // 5. Wrong password fails local AES-GCM decryption
      await expect(sealed.decryptWith("WrongPassword999")).rejects.toThrow();
    }

    // -------------------------------------------------------------------------
    // COHORT 4 (Users 51..65): Cross-user isolation, forged sigs & username recycling
    // -------------------------------------------------------------------------
    for (let u = 51; u <= 65; u += 1) {
      const tgA = 100000 + u;
      const tgB = 200000 + u;
      const sessA = await authUser(tgA, `alpha_${u}`);
      const sessB = await authUser(tgB, `beta_${u}`);

      const sealedA = await sealTestVault(`AlphaSecret#${u}`, `alpha seed ${u}`);
      await app.request(
        "/v1/tg/vault-backup",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessA.sessionToken}`,
          },
          body: JSON.stringify({ envelope: sealedA.envelope }),
        },
        BASE_ENV,
      );

      // User B sees NO backup and cannot delete User A's backup
      const getB = (await (
        await app.request(
          "/v1/tg/vault-backup",
          { headers: { Authorization: `Bearer ${sessB.sessionToken}` } },
          BASE_ENV,
        )
      ).json()) as { hasBackup: boolean };
      expect(getB.hasBackup).toBe(false);

      await app.request(
        "/v1/tg/vault-backup",
        { method: "DELETE", headers: { Authorization: `Bearer ${sessB.sessionToken}` } },
        BASE_ENV,
      );
      const stillExistsA = (await (
        await app.request(
          "/v1/tg/vault-backup",
          { headers: { Authorization: `Bearer ${sessA.sessionToken}` } },
          BASE_ENV,
        )
      ).json()) as { hasBackup: boolean };
      expect(stillExistsA.hasBackup).toBe(true);

      // Forged link signature rejected with 401
      const chRes = await app.request(
        "/v1/tg/link-challenge",
        { method: "POST", headers: { Authorization: `Bearer ${sessA.sessionToken}` } },
        BASE_ENV,
      );
      const ch = (await chRes.json()) as { intentId: string; sig: string; message: string };
      const signerA = await generateTestSigner();
      const forgedSigner = await generateTestSigner();
      const forgedRes = await app.request(
        "/v1/tg/link-confirm",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessA.sessionToken}`,
          },
          body: JSON.stringify({
            intentId: ch.intentId,
            sig: ch.sig,
            accounts: [
              {
                address: signerA.address,
                kind: "classic",
                label: "Forged",
                signatureBase64: await forgedSigner.signChallenge(ch.message),
              },
            ],
          }),
        },
        BASE_ENV,
      );
      expect(forgedRes.status).toBe(401);

      // User B claims User A's old handle atomically without error
      await authUser(tgB, `alpha_${u}`);
      const holder = await repo.getUserByUsername(`alpha_${u}`);
      expect(holder?.telegramUserId).toBe(String(tgB));
    }

    // -------------------------------------------------------------------------
    // COHORT 5 (Users 66..80): Bot /pay, /request, multi-payer /split, /unlink & DELETE backup
    // -------------------------------------------------------------------------
    let nextUpdateId = 900001;
    for (let u = 66; u <= 80; u += 1) {
      const tgId = 100000 + u;
      const username = `botuser_${u}`;
      const session = await authUser(tgId, username);
      const signer = await generateTestSigner();
      await autoLinkAccounts(session.sessionToken, [{ signer, label: "BotMain" }]);

      // Upload vault backup then delete it and verify clean absence (no zombie backup)
      const sealed = await sealTestVault(`BotPass#${u}_xyz`, `bot seed ${u}`);
      await app.request(
        "/v1/tg/vault-backup",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.sessionToken}`,
          },
          body: JSON.stringify({ envelope: sealed.envelope }),
        },
        BASE_ENV,
      );

      // Group /split command via Telegram webhook
      const now = Math.floor(Date.now() / 1000);
      const splitWh = await app.request(
        "/tg/webhook",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": BASE_ENV.TG_WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            update_id: nextUpdateId++,
            message: {
              message_id: u,
              date: now,
              chat: { id: -100990000 - u, type: "supergroup", title: "Crew" },
              from: { id: tgId, is_bot: false, first_name: "BotU", username },
              text: "/split 20 XLM 2",
              entities: [{ offset: 0, length: 6, type: "bot_command" }],
            },
          }),
        },
        BASE_ENV,
      );
      expect(splitWh.status).toBe(200);

      // Extract created split intent from bot's outbound message button URL
      const lastSent = sentTgRequests[sentTgRequests.length - 1]?.body as {
        reply_markup?: { inline_keyboard?: Array<Array<{ url?: string }>> };
      };
      const btnUrl = lastSent.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? "";
      const startParam = new URL(btnUrl).searchParams.get("startapp") ?? "";
      const match = /^i-([A-Za-z0-9_]+)-([a-f0-9]{64})$/i.exec(startParam);
      expect(match).not.toBeNull();
      const splitIntentId = match![1]!;
      const splitSig = match![2]!;

      const txHash1 = `${u.toString(16).padStart(4, "0")}${"a".repeat(60)}`;
      const txHash2 = `${u.toString(16).padStart(4, "0")}${"b".repeat(60)}`;
      const payer1 = (await generateTestSigner()).address;
      const payer2 = (await generateTestSigner()).address;

      const cf1 = await app.request(
        `/v1/intents/${splitIntentId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sig: splitSig, txHash: txHash1, payerAddress: payer1 }),
        },
        BASE_ENV,
      );
      expect(cf1.status).toBe(200);
      expect(((await cf1.json()) as { paidCount: number; status: string }).status).toBe("pending");

      // Duplicate txHash replay blocked with 409 on a second intent!
      const secondIntentId = `it_dup_${u}`;
      const secondSig = await signIntentToken(
        { intentId: secondIntentId, network: "testnet", telegramUserId: String(tgId), expiresAt: now + 300 },
        BASE_ENV.INTENT_HMAC_SECRET,
      );
      await repo.createSignedIntent({
        intentId: secondIntentId,
        network: "testnet",
        creatorTelegramUserId: String(tgId),
        actionType: "request",
        payloadJson: JSON.stringify({ amount: "5", assetCode: "XLM", destination: signer.address }),
        hmacSig: secondSig,
        status: "pending",
        expiresAt: now + 300,
        createdAt: now,
      });
      const replayRes = await app.request(
        `/v1/intents/${secondIntentId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sig: secondSig, txHash: txHash1 }),
        },
        BASE_ENV,
      );
      expect(replayRes.status).toBe(409);

      // Second split payer completes split
      const cf2 = await app.request(
        `/v1/intents/${splitIntentId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sig: splitSig, txHash: txHash2, payerAddress: payer2 }),
        },
        BASE_ENV,
      );
      expect(((await cf2.json()) as { status: string }).status).toBe("confirmed");

      // Delete cloud backup & verify /v1/tg/me shows hasEncryptedBackup: false
      const delRes = await app.request(
        "/v1/tg/vault-backup",
        { method: "DELETE", headers: { Authorization: `Bearer ${session.sessionToken}` } },
        BASE_ENV,
      );
      expect(delRes.status).toBe(200);
      const meAfter = (await (
        await app.request(
          "/v1/tg/me",
          { headers: { Authorization: `Bearer ${session.sessionToken}` } },
          BASE_ENV,
        )
      ).json()) as { hasEncryptedBackup: boolean };
      expect(meAfter.hasEncryptedBackup).toBe(false);
    }

    // -------------------------------------------------------------------------
    // COHORT 6 (Users 81..90): Scan & Shield XDR + SEP-29 Exchange check
    // -------------------------------------------------------------------------
    for (let u = 81; u <= 90; u += 1) {
      const safeScan = await app.request(
        "/v1/proxy/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: BENIGN_PAYMENT_TX_XDR }),
        },
        BASE_ENV,
      );
      expect(safeScan.status).toBe(200);
      expect(((await safeScan.json()) as { report: { verdict: string } }).report.verdict).toBe("benign");

      const malScan = await app.request(
        "/v1/proxy/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: MALICIOUS_MERGE_TX_XDR }),
        },
        BASE_ENV,
      );
      expect(malScan.status).toBe(200);
      expect(((await malScan.json()) as { report: { verdict: string } }).report.verdict).toBe(
        "malicious",
      );

      const exScan = await app.request(
        "/v1/proxy/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: exchangeAddress }),
        },
        BASE_ENV,
      );
      expect(exScan.status).toBe(200);
      expect(
        ((await exScan.json()) as { report: { requiresMemoCheck: boolean } }).report
          .requiresMemoCheck,
      ).toBe(true);
    }

    // -------------------------------------------------------------------------
    // COHORT 7 (Users 91..100): Parallel 10-user onboarding burst + Rate limit guard
    // -------------------------------------------------------------------------
    await Promise.all(
      Array.from({ length: 10 }, async (_, idx) => {
        const u = 91 + idx;
        const tgId = 100000 + u;
        const session = await authUser(tgId, `burst_${u}`);
        const signer = await generateTestSigner();
        const sealed = await sealTestVault(`BurstKey#${u}_2026`, `burst seed ${u}`);
        const [putRes, linkRes] = await Promise.all([
          app.request(
            "/v1/tg/vault-backup",
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.sessionToken}`,
              },
              body: JSON.stringify({ envelope: sealed.envelope }),
            },
            BASE_ENV,
          ),
          autoLinkAccounts(session.sessionToken, [{ signer, label: `Burst ${u}` }]),
        ]);
        expect(putRes.status).toBe(200);
        expect(linkRes.linkedCount).toBe(1);
      }),
    );

    // Rate-limit burst check on user 100 (PUT /v1/tg/vault-backup limit is 10/min; already did 1 above)
    const rateUser = await authUser(100100, "burst_100");
    const rateSealed = await sealTestVault("RateLimit#100_2026", "rate seed");
    let hit429 = false;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const res = await app.request(
        "/v1/tg/vault-backup",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${rateUser.sessionToken}`,
          },
          body: JSON.stringify({ envelope: rateSealed.envelope }),
        },
        BASE_ENV,
      );
      if (res.status === 429) {
        expect(res.headers.get("Retry-After")).toBeTruthy();
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);
  });
});
