import type {
  ClassicAddress,
  ClaimLink,
  ConnectRequestRecord,
  ContractAddress,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import { deriveCounterfactualContractAddress } from "@astrowallet/security-shield";
import {
  computeTelegramInitDataHash,
  deriveClaimId,
  encodeStartAppTabParam,
  formatConnectChallengeMessage,
  formatSmartAccountLinkMessage,
  signIntentToken,
  signMiniAppSessionToken,
  type ConnectChallengePayload,
} from "@astrowallet/tg-protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ChannelPoolDO } from "./durable-objects/channel-pool.js";
import type {
  ServerRepository,
  StoredEncryptedVaultBackup,
  TelegramUserRecord,
} from "./db/repository.js";
import { resetMemoryRateLimits } from "./rate-limit.js";
import {
  fetchLiveAccountReserveInfo,
  verifyTransactionConfirmed,
} from "./stellar-verifier.js";

const BENIGN_PAYMENT_TX_XDR =
  "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAAAAAAAABfXhAAAAAAAAAAAA";
const MALICIOUS_MERGE_TX_XDR =
  "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAACAAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAAAAAAAA";
const SOROBAN_HOST_FN_CONTRACT =
  "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR" as ContractAddress;
const OTHER_CONTRACT =
  "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L" as ContractAddress;
const SOROBAN_HOST_FN_XDR =
  "AAAAAAAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAAh0cmFuc2ZlcgAAAAA=";

const TEST_ENV = {
  STELLAR_NETWORK: "testnet",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URLS: "https://soroban-testnet.stellar.org",
  HORIZON_URLS: "https://horizon-testnet.stellar.org",
  PWA_ORIGIN: "https://testnet.astrowallet.example",
  ALLOWED_ORIGINS: "https://testnet.astrowallet.example,http://localhost:5173",
  FRIENDBOT_URL: "https://friendbot.stellar.org",
  TG_BOT_TOKEN: "test-bot-token",
  TG_WEBHOOK_SECRET: "secret-header-token-1234",
  INTENT_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
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

async function signRelayWalletAuth(
  signer: Awaited<ReturnType<typeof generateTestSigner>>,
  network: "testnet" | "mainnet",
  mode: "soroban" | "feebump",
  rawPayload: string,
  nonce = `nonce_${crypto.randomUUID().slice(0, 8)}`,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawPayload)),
  );
  const payloadHash = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const msg = `astrowallet-relay:v1:${network}:${mode}:${payloadHash}:${timestamp}:${nonce}`;
  return {
    address: signer.address,
    timestamp,
    nonce,
    payloadHash,
    signatureBase64: await signer.signChallenge(msg),
  };
}

function createMemoryRepo(): ServerRepository {
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
  const dauSet = new Map<string, { day: string; userHash: string; platform: string }>();
  const eventCounts = new Map<string, { day: string; eventType: string; count: number }>();
  const verifiedTxs = new Map<
    string,
    { txHash: string; actionType: string; assetCode?: string; amountEst?: string; createdAt: number }
  >();

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
      const list = [...(bindings.get(telegramUserId) ?? [])];
      for (let i = 0; i < accounts.length; i += 1) {
        const acc = accounts[i];
        if (!acc) continue;
        const idx = list.findIndex((b) => b.address === acc.address);
        const item: TelegramUserBinding = {
          telegramUserId,
          usernameLower,
          address: acc.address,
          kind: acc.kind,
          label: acc.label,
          isDefault: Boolean(acc.isDefault) || (list.length === 0 && i === 0),
        };
        if (idx >= 0) {
          list[idx] = item;
        } else {
          list.push(item);
        }
      }
      bindings.set(telegramUserId, list);
      return list;
    },
    async listLinkedAddresses(telegramUserId) {
      return bindings.get(telegramUserId) ?? [];
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
    async getUserByLinkedAddress(address) {
      for (const [tgId, list] of bindings.entries()) {
        const hit = list.find((item) => item.address === address);
        if (hit) {
          const user = users.get(tgId);
          return {
            telegramUserId: tgId,
            usernameLower: user?.usernameLower,
            label: hit.label,
          };
        }
      }
      return null;
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
    async recordDailyUserActivity(input) {
      dauSet.set(`${input.dayUtc}:${input.userHash}:${input.network}`, {
        day: input.dayUtc,
        userHash: input.userHash,
        platform: input.platform ?? "unknown",
      });
    },
    async incrementProductEvent(input) {
      const k = `${input.dayUtc}:${input.network}:${input.eventType}`;
      const prev = eventCounts.get(k);
      eventCounts.set(k, {
        day: input.dayUtc,
        eventType: input.eventType,
        count: (prev?.count ?? 0) + (input.delta ?? 1),
      });
    },
    async recordVerifiedTx(input) {
      verifiedTxs.set(input.txHash.toLowerCase(), {
        txHash: input.txHash.toLowerCase(),
        actionType: input.actionType,
        ...(input.assetCode ? { assetCode: input.assetCode } : {}),
        ...(input.amountEst ? { amountEst: input.amountEst } : {}),
        createdAt: input.nowSec ?? Math.floor(Date.now() / 1000),
      });
    },
    async getPublicMetricsSnapshot(network) {
      const uniqueUsers = new Set(Array.from(dauSet.values()).map((d) => d.userHash));
      const eventBreakdown: Record<string, number> = {};
      const platforms: Record<string, number> = {};
      for (const d of dauSet.values()) {
        platforms[d.platform] = (platforms[d.platform] ?? 0) + 1;
      }
      for (const ev of eventCounts.values()) {
        eventBreakdown[ev.eventType] = (eventBreakdown[ev.eventType] ?? 0) + ev.count;
      }
      const allBindings = Array.from(bindings.values()).flat();
      return {
        totalRegisteredUsers: users.size,
        totalLinkedWallets: allBindings.length,
        classicWallets: allBindings.filter((a) => a.accountKind === "classic").length,
        smartWallets: allBindings.filter((a) => a.accountKind === "smart").length,
        encryptedVaultBackups: Array.from(encryptedBackups.values()).filter((b) => b.network === network).length,
        confirmedIntents: Array.from(intents.values()).filter((i) => i.status === "confirmed").length,
        approvedConnectRequests: Array.from(connectRequests.values()).filter((c) => c.status === "approved").length,
        relayTxCount: 0,
        verifiedTxCount: verifiedTxs.size,
        dau: uniqueUsers.size,
        wau: uniqueUsers.size,
        mau: uniqueUsers.size,
        dailySeries: [],
        platforms,
        eventBreakdown,
        recentVerifiedTxs: Array.from(verifiedTxs.values()).slice(0, 15),
      };
    },
  };
}

describe("apps/server Phase 0 + Phase 1 endpoints", () => {
  beforeEach(() => {
    resetMemoryRateLimits();
  });
  it("responds 200 on /health and enforces CORS allowlist", async () => {
    const app = createApp();
    const res = await app.request("/health", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { network: string }).network).toBe("testnet");

    const blocked = await app.request(
      "/health",
      { method: "OPTIONS", headers: { Origin: "https://evil.example" } },
      TEST_ENV,
    );
    expect(blocked.status).toBe(403);
  });

  it("fails closed with 401 on /tg/webhook without valid secret header", async () => {
    const repo = createMemoryRepo();
    const app = createApp({ createRepo: () => repo });

    const missing = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      },
      TEST_ENV,
    );
    expect(missing.status).toBe(401);
  });

  it("verifies signed connect challenge and links multiple accounts for a Telegram user", async () => {
    const repo = createMemoryRepo();
    const telegramCalls: string[] = [];
    const app = createApp({
      createRepo: () => repo,
      telegramApiDeps: {
        fetchFn: async (input) => {
          telegramCalls.push(String(input));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const signer0 = await generateTestSigner();
    const signer1 = await generateTestSigner();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_connect_001";

    const challenge: ConnectChallengePayload = {
      challengeId: "ch_001",
      network: "testnet",
      telegramUserId: "5551234",
      usernameLower: "alice",
      issuedAt: now,
      expiresAt,
    };
    const message = formatConnectChallengeMessage(challenge);
    const hmacSig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "5551234", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "5551234",
      actionType: "connect",
      payloadJson: JSON.stringify({ challenge, message, confirmCode: "AB12CD" }),
      hmacSig,
      chatId: "5551234",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    // GET /v1/intents/:id must strip confirmCode from response payload
    const getRes = await app.request(`/v1/intents/${intentId}?sig=${hmacSig}`, { method: "GET" }, TEST_ENV);
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { payload?: { confirmCode?: string } };
    expect(getJson.payload?.confirmCode).toBeUndefined();

    // Wrong confirmCode must fail with 403
    const badCodeRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: hmacSig,
          confirmCode: "ZZZZZZ",
          accounts: [
            {
              address: signer0.address,
              kind: "classic",
              label: "Primary",
              isDefault: true,
              signatureBase64: await signer0.signChallenge(message),
            },
          ],
        }),
      },
      TEST_ENV,
    );
    expect(badCodeRes.status).toBe(403);

    // Tampered signature must fail with 401
    const badRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: hmacSig,
          confirmCode: "AB12CD",
          accounts: [
            {
              address: signer0.address,
              kind: "classic",
              label: "Primary",
              isDefault: true,
              signatureBase64: btoa("x".repeat(64)),
            },
          ],
        }),
      },
      TEST_ENV,
    );
    expect(badRes.status).toBe(401);

    // Valid multi-account Ed25519 signatures succeed and notify chat
    const goodRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: hmacSig,
          confirmCode: "ab12cd",
          accounts: [
            {
              address: signer0.address,
              kind: "classic",
              label: "Primary",
              isDefault: true,
              signatureBase64: await signer0.signChallenge(message),
            },
            {
              address: signer1.address,
              kind: "classic",
              label: "Savings",
              isDefault: false,
              signatureBase64: await signer1.signChallenge(message),
            },
          ],
        }),
      },
      TEST_ENV,
    );
    expect(goodRes.status).toBe(200);
    const linked = await repo.listLinkedAddresses("5551234");
    expect(linked).toHaveLength(2);
    expect(telegramCalls.some((url) => url.includes("/sendMessage"))).toBe(true);
  });

  it("confirms payment intent after Horizon tx check and edits Telegram card live", async () => {
    const repo = createMemoryRepo();
    const telegramPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async (_cfg, hash) => {
        if (hash === "a".repeat(64)) {
          return { confirmed: true, ledger: 9001 };
        }
        return { confirmed: false, reason: "Transaction not found" };
      },
      telegramApiDeps: {
        fetchFn: async (url, init) => {
          telegramPayloads.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_pay_001";
    const hmacSig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "5551234", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "5551234",
      actionType: "pay",
      payloadJson: JSON.stringify({
        amount: "15",
        assetCode: "XLM",
        senderLabel: "@alice",
        recipientLabel: "@bob",
      }),
      hmacSig,
      chatId: "-100999",
      messageId: "77",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    // GET intent checks HMAC & TTL
    const getRes = await app.request(
      `/v1/intents/${intentId}?sig=${hmacSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(getRes.status).toBe(200);

    // Unconfirmed tx rejected 409
    const unconfirmed = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig: hmacSig, txHash: "b".repeat(64) }),
      },
      TEST_ENV,
    );
    expect(unconfirmed.status).toBe(409);

    // Confirmed tx edits Telegram message in-place
    const confirmed = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig: hmacSig, txHash: "a".repeat(64) }),
      },
      TEST_ENV,
    );
    expect(confirmed.status).toBe(200);
    const json = (await confirmed.json()) as { telegramCardUpdated: boolean };
    expect(json.telegramCardUpdated).toBe(true);
    expect(telegramPayloads[0]?.url).toContain("/editMessageText");
    expect(String(telegramPayloads[0]?.body.text)).toContain("Confirmed on Stellar");
  });

  it("rejects mainnet configuration with FRIENDBOT_URL and serves Phase 2 proxy/relay endpoints", async () => {
    const repo = createMemoryRepo();
    const relaySigner = await generateTestSigner();
    await repo.linkVerifiedAddresses({
      telegramUserId: "70001",
      accounts: [
        {
          address: relaySigner.address,
          kind: "classic",
          label: "Main",
          isDefault: true,
          verifiedSigHash: "sig_0",
        },
      ],
    });
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (url) => {
        const str = String(url);
        if (str.includes("/paths/strict-send")) {
          return new Response(
            JSON.stringify({
              _embedded: { records: [{ destination_amount: "19.85" }] },
            }),
            { status: 200 },
          );
        }
        if (str.includes("channels.openzeppelin.com")) {
          return new Response(
            JSON.stringify({ hash: "c".repeat(64), status: "submitted" }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const mainnetFail = await app.request(
      "/health",
      { method: "GET" },
      {
        ...TEST_ENV,
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      },
    );
    expect(mainnetFail.status).toBe(500);

    // Phase 2 Swap quote via proxy
    const swapRes = await app.request(
      "/v1/proxy/soroswap/quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAsset: "XLM",
          toAsset: "USDC:GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
          amount: "50",
          slippageBps: 50,
        }),
      },
      TEST_ENV,
    );
    expect(swapRes.status).toBe(200);
    const swapJson = (await swapRes.json()) as { expectedOutputAmount: string };
    expect(swapJson.expectedOutputAmount).toBe("19.85");

    // Phase 2 Scan & Shield endpoint
    const scanRes = await app.request(
      "/v1/proxy/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        }),
      },
      TEST_ENV,
    );
    expect(scanRes.status).toBe(200);

    // Phase 2 OpenZeppelin Channels relay proxy (walletAuth + allowlisted contracts + valid benign XDR)
    const walletAuth = await signRelayWalletAuth(
      relaySigner,
      "testnet",
      "feebump",
      BENIGN_PAYMENT_TX_XDR,
    );
    const relayRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_ENV.PWA_ORIGIN,
        },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          walletAuth,
        }),
      },
      {
        ...TEST_ENV,
        OZ_CHANNELS_API_URL: "https://channels.openzeppelin.com/testnet",
        RELAY_ALLOWED_CONTRACTS: SOROBAN_HOST_FN_CONTRACT,
      },
    );
    expect(relayRes.status).toBe(200);
  });

  it("verifies Goldsky/Mercury webhooks on POST /webhooks/indexer and dispatches alerts", async () => {
    const repo = createMemoryRepo();
    const signer = await generateTestSigner();
    await repo.linkVerifiedAddresses({
      telegramUserId: "888999",
      usernameLower: "bob",
      accounts: [
        {
          address: signer.address,
          kind: "classic",
          label: "Primary",
          isDefault: true,
          verifiedSigHash: "sig_hash_1",
        },
      ],
    });

    const sentAlerts: Array<{ chat_id: string; text: string }> = [];
    const app = createApp({
      createRepo: () => repo,
      telegramApiDeps: {
        fetchFn: async (_url, init) => {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as {
            chat_id: string;
            text: string;
          };
          sentAlerts.push(parsed);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const envWithIndexer = {
      ...TEST_ENV,
      INDEXER_WEBHOOK_SECRET: "indexer-hmac-secret-32chars-minimum!",
    };

    const payloadBody = JSON.stringify({
      events: [
        {
          txHash: "e".repeat(64),
          from: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
          to: signer.address,
          amount: "42.5",
          assetCode: "USDC",
        },
      ],
    });

    // Invalid signature -> 401
    const badRes = await app.request(
      "/webhooks/indexer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goldsky-Signature": "0".repeat(64),
        },
        body: payloadBody,
      },
      envWithIndexer,
    );
    expect(badRes.status).toBe(401);

    // Valid HMAC-SHA256 X-Goldsky-Signature -> 200 + Telegram alert
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(envWithIndexer.INDEXER_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadBody)),
    );
    const hmacHex = Array.from(sigBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const goodHmacRes = await app.request(
      "/webhooks/indexer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goldsky-Signature": `sha256=${hmacHex}`,
        },
        body: payloadBody,
      },
      envWithIndexer,
    );
    expect(goodHmacRes.status).toBe(200);
    const hmacJson = (await goodHmacRes.json()) as { processed: number; alertsSent: number };
    expect(hmacJson.processed).toBe(1);
    expect(hmacJson.alertsSent).toBe(1);

    // Replay of same txHash with valid shared secret header -> 200 but deduped (0 alertsSent)
    const replaySecretRes = await app.request(
      "/webhooks/indexer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Indexer-Secret": envWithIndexer.INDEXER_WEBHOOK_SECRET,
        },
        body: payloadBody,
      },
      envWithIndexer,
    );
    expect(replaySecretRes.status).toBe(200);
    const replayJson = (await replaySecretRes.json()) as { alertsSent: number };
    expect(replayJson.alertsSent).toBe(0);

    // Distinct event with valid shared secret header -> 200 + second alert
    const distinctPayload = JSON.stringify({
      events: [
        {
          txHash: "f".repeat(64),
          from: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
          to: signer.address,
          amount: "12.0",
          assetCode: "XLM",
        },
      ],
    });
    const secretRes = await app.request(
      "/webhooks/indexer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Indexer-Secret": envWithIndexer.INDEXER_WEBHOOK_SECRET,
        },
        body: distinctPayload,
      },
      envWithIndexer,
    );
    expect(secretRes.status).toBe(200);
    const secretJson = (await secretRes.json()) as { alertsSent: number };
    expect(secretJson.alertsSent).toBe(1);
    expect(sentAlerts).toHaveLength(2);
    expect(sentAlerts[0]?.chat_id).toBe("888999");
    expect(sentAlerts[0]?.text).toContain("42.5 USDC");
  });

  it("computes live Horizon account reserves and handles /reserve Telegram command", async () => {
    const signer = await generateTestSigner();
    const issuer = (await generateTestSigner()).address;

    const reserve = await fetchLiveAccountReserveInfo(
      { horizonUrls: [TEST_ENV.HORIZON_URLS] },
      signer.address,
      async () =>
        new Response(
          JSON.stringify({
            subentry_count: 2,
            num_sponsoring: 1,
            num_sponsored: 0,
            balances: [
              { asset_type: "native", balance: "50.0000000", selling_liabilities: "2.0000000" },
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: issuer,
                balance: "0.0000000",
              },
            ],
          }),
          { status: 200 },
        ),
    );

    expect(reserve.funded).toBe(true);
    // (2 + 2 + 1 - 0) * 0.5 = 2.5 XLM
    expect(reserve.summary?.minReserveXlm).toBe("2.5");
    expect(reserve.summary?.spendableXlm).toBe("45.5000000");
    expect(reserve.summary?.reclaimableXlm).toBe("0.5");
    expect(reserve.summary?.reclaimableTrustlines).toHaveLength(1);
  });

  it("enforces relay policy gates: cryptographic auth, contract allowlist, Scan & Shield, daily budget, and rate limits", async () => {
    const repo = createMemoryRepo();
    const relaySigner = await generateTestSigner();
    await repo.linkVerifiedAddresses({
      telegramUserId: "9001",
      accounts: [
        {
          address: relaySigner.address,
          kind: "classic",
          label: "Main",
          isDefault: true,
          verifiedSigHash: "sig_relay_1",
        },
      ],
    });
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (url) => {
        if (String(url).includes("channels.openzeppelin.com")) {
          return new Response(
            JSON.stringify({ hash: "d".repeat(64), status: "submitted" }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const relayEnv = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.openzeppelin.com/testnet",
      RELAY_ALLOWED_CONTRACTS: SOROBAN_HOST_FN_CONTRACT,
      RELAY_RATE_LIMIT_PER_MIN: "7",
    };

    // 0. Empty RELAY_ALLOWED_CONTRACTS fails closed -> 503
    const emptyAllowlistRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          walletAuth: await signRelayWalletAuth(
            relaySigner,
            "testnet",
            "feebump",
            BENIGN_PAYMENT_TX_XDR,
          ),
        }),
      },
      { ...relayEnv, RELAY_ALLOWED_CONTRACTS: "" },
    );
    expect(emptyAllowlistRes.status).toBe(503);

    // 1. Origin header alone (without walletAuth or intentAuth) -> 403
    const originOnlyRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_ENV.PWA_ORIGIN,
        },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
        }),
      },
      relayEnv,
    );
    expect(originOnlyRes.status).toBe(403);

    // 2. Malicious accountMerge XDR -> 403 Scan & Shield block
    const maliciousRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: MALICIOUS_MERGE_TX_XDR,
          walletAuth: await signRelayWalletAuth(
            relaySigner,
            "testnet",
            "feebump",
            MALICIOUS_MERGE_TX_XDR,
          ),
        }),
      },
      relayEnv,
    );
    expect(maliciousRes.status).toBe(403);

    // 3. Malformed XDR -> 400
    const badXdrRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: "not_valid_xdr_base64_string",
          walletAuth: await signRelayWalletAuth(
            relaySigner,
            "testnet",
            "feebump",
            "not_valid_xdr_base64_string",
          ),
        }),
      },
      relayEnv,
    );
    expect(badXdrRes.status).toBe(400);

    // 4. Valid intentAuth without Origin -> 200
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_relay_01";
    const sig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "9001", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "9001",
      actionType: "pay",
      payloadJson: "{}",
      hmacSig: sig,
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    const intentRelayRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          intentAuth: { intentId, sig },
        }),
      },
      relayEnv,
    );
    expect(intentRelayRes.status).toBe(200);

    // 5. Soroban contract allowlist enforcement & single-use walletAuth nonce anti-replay
    const disallowedRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: SOROBAN_HOST_FN_XDR,
          walletAuth: await signRelayWalletAuth(
            relaySigner,
            "testnet",
            "soroban",
            SOROBAN_HOST_FN_XDR,
          ),
        }),
      },
      { ...relayEnv, RELAY_ALLOWED_CONTRACTS: OTHER_CONTRACT },
    );
    expect(disallowedRes.status).toBe(403);

    const replayProof = await signRelayWalletAuth(
      relaySigner,
      "testnet",
      "soroban",
      SOROBAN_HOST_FN_XDR,
      "fixed_nonce_001",
    );
    const allowedSorobanRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: SOROBAN_HOST_FN_XDR,
          walletAuth: replayProof,
        }),
      },
      relayEnv,
    );
    expect(allowedSorobanRes.status).toBe(200);

    // Replaying same nonce must fail -> 403
    const replayedRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: SOROBAN_HOST_FN_XDR,
          walletAuth: replayProof,
        }),
      },
      relayEnv,
    );
    expect(replayedRes.status).toBe(403);

    // 6. Rate limit enforcement -> 9th request in window returns 429
    const limitedRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: SOROBAN_HOST_FN_XDR,
          walletAuth: await signRelayWalletAuth(
            relaySigner,
            "testnet",
            "soroban",
            SOROBAN_HOST_FN_XDR,
          ),
        }),
      },
      relayEnv,
    );
    expect(limitedRes.status).toBe(429);
  });

  it("blocks SSRF private/local domains and unsafe redirects on /v1/proxy/stellar-toml while following safe HTTPS redirects", async () => {
    const app = createApp();
    for (const domain of ["localhost", "127.0.0.1", "169.254.169.254", "internal.local"]) {
      const res = await app.request(
        `/v1/proxy/stellar-toml?domain=${encodeURIComponent(domain)}`,
        { method: "GET" },
        TEST_ENV,
      );
      expect(res.status).toBe(400);
    }

    const redirectApp = createApp({
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://redirect.example/.well-known/stellar.toml") {
          return new Response(null, {
            status: 301,
            headers: { Location: "https://www.circle.com/.well-known/stellar.toml" },
          });
        }
        if (url === "https://www.circle.com/.well-known/stellar.toml") {
          return new Response('VERSION="2.0.0"\n', { status: 200 });
        }
        if (url === "https://evil-redir.example/.well-known/stellar.toml") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1/.well-known/stellar.toml" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const okRedirect = await redirectApp.request(
      "/v1/proxy/stellar-toml?domain=redirect.example",
      { method: "GET" },
      TEST_ENV,
    );
    expect(okRedirect.status).toBe(200);
    expect(await okRedirect.text()).toContain('VERSION="2.0.0"');

    const unsafeRedirect = await redirectApp.request(
      "/v1/proxy/stellar-toml?domain=evil-redir.example",
      { method: "GET" },
      TEST_ENV,
    );
    expect(unsafeRedirect.status).toBe(502);
  });

  it("enforces anti-replay txHash checks and Horizon op-level intent matching", async () => {
    const repo = createMemoryRepo();
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => ({ confirmed: true, ledger: 42 }),
    });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const sharedHash = "1".repeat(64);

    for (const intentId of ["it_replay_a", "it_replay_b"]) {
      const sig = await signIntentToken(
        { intentId, network: "testnet", telegramUserId: "7001", expiresAt },
        TEST_ENV.INTENT_HMAC_SECRET,
      );
      await repo.createSignedIntent({
        intentId,
        network: "testnet",
        creatorTelegramUserId: "7001",
        actionType: "pay",
        payloadJson: JSON.stringify({ amount: "5", assetCode: "XLM" }),
        hmacSig: sig,
        status: "pending",
        expiresAt,
        createdAt: now,
      });
    }

    const intentA = (await repo.getSignedIntent("it_replay_a"))!;
    const intentB = (await repo.getSignedIntent("it_replay_b"))!;

    const firstConfirm = await app.request(
      `/v1/intents/${intentA.intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig: intentA.hmacSig, txHash: sharedHash }),
      },
      TEST_ENV,
    );
    expect(firstConfirm.status).toBe(200);

    const replayConfirm = await app.request(
      `/v1/intents/${intentB.intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig: intentB.hmacSig, txHash: sharedHash }),
      },
      TEST_ENV,
    );
    expect(replayConfirm.status).toBe(409);

    const dest = (await generateTestSigner()).address;
    const oldCheck = await verifyTransactionConfirmed(
      { horizonUrls: [TEST_ENV.HORIZON_URLS] },
      "2".repeat(64),
      async (url) => {
        if (String(url).includes("/transactions/")) {
          return new Response(
            JSON.stringify({
              successful: true,
              ledger: 100,
              created_at: new Date((now - 3600) * 1000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
      { destination: dest, amount: "10", assetCode: "XLM", minCreatedAtUnix: now },
    );
    expect(oldCheck.confirmed).toBe(false);

    const mismatchCheck = await verifyTransactionConfirmed(
      { horizonUrls: [TEST_ENV.HORIZON_URLS] },
      "3".repeat(64),
      async (url) => {
        if (String(url).endsWith("/operations?limit=50")) {
          return new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  {
                    type: "payment",
                    to: dest,
                    amount: "2.0000000",
                    asset_type: "native",
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            successful: true,
            ledger: 101,
            created_at: new Date(now * 1000).toISOString(),
          }),
          { status: 200 },
        );
      },
      { destination: dest, amount: "10", assetCode: "XLM", minCreatedAtUnix: now },
    );
    expect(mismatchCheck.confirmed).toBe(false);
  });

  it("verifies Smart Account C... Guardian signatures on /v1/intents/:id/connect", async () => {
    const repo = createMemoryRepo();
    const app = createApp({ createRepo: () => repo });
    const guardian = await generateTestSigner();

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_smart_connect_01";
    const challenge: ConnectChallengePayload = {
      challengeId: "ch_smart_01",
      network: "testnet",
      telegramUserId: "555777",
      usernameLower: "carol",
      issuedAt: now,
      expiresAt,
    };
    const message = formatConnectChallengeMessage(challenge);
    const sig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "555777", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "555777",
      actionType: "connect",
      payloadJson: JSON.stringify({ challenge, message, confirmCode: "SM88RT" }),
      hmacSig: sig,
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const wasmHash = "ab".repeat(32);
    const derivedSmartAddr = (await deriveCounterfactualContractAddress({
      guardianAddress: guardian.address,
      wasmHashHex: wasmHash,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })) as ContractAddress;
    const smartEnv = { ...TEST_ENV, SMART_ACCOUNT_WASM_HASH: wasmHash };

    const wrongSmartSigRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          confirmCode: "SM88RT",
          accounts: [
            {
              address: derivedSmartAddr,
              kind: "smart",
              label: "Smart Account",
              guardianAddress: guardian.address,
              signatureBase64: await guardian.signChallenge(message),
            },
          ],
        }),
      },
      smartEnv,
    );
    expect(wrongSmartSigRes.status).toBe(401);

    // Mismatched counterfactual C... under configured SMART_ACCOUNT_WASM_HASH must fail -> 403
    const mismatchBoundMsg = formatSmartAccountLinkMessage(message, SOROBAN_HOST_FN_CONTRACT);
    const mismatchedSmartRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          confirmCode: "SM88RT",
          accounts: [
            {
              address: guardian.address,
              kind: "classic",
              label: "Primary",
              isDefault: true,
              signatureBase64: await guardian.signChallenge(message),
            },
            {
              address: SOROBAN_HOST_FN_CONTRACT,
              kind: "smart",
              label: "Smart Account",
              guardianAddress: guardian.address,
              signatureBase64: await guardian.signChallenge(mismatchBoundMsg),
            },
          ],
        }),
      },
      smartEnv,
    );
    expect(mismatchedSmartRes.status).toBe(403);

    const boundMessage = formatSmartAccountLinkMessage(message, derivedSmartAddr);
    const validSmartRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          confirmCode: "SM88RT",
          accounts: [
            {
              address: guardian.address,
              kind: "classic",
              label: "Primary",
              isDefault: true,
              signatureBase64: await guardian.signChallenge(message),
            },
            {
              address: derivedSmartAddr,
              kind: "smart",
              label: "Smart Account",
              guardianAddress: guardian.address,
              signatureBase64: await guardian.signChallenge(boundMessage),
            },
          ],
        }),
      },
      smartEnv,
    );
    expect(validSmartRes.status).toBe(200);
    const linked = await repo.listLinkedAddresses("555777");
    expect(linked).toHaveLength(2);
    expect(linked.some((a) => a.kind === "smart" && a.address === derivedSmartAddr)).toBe(
      true,
    );
  });

  it("tracks multi-payer /split intents and edits Telegram progress until fully paid", async () => {
    const repo = createMemoryRepo();
    const editedCards: Array<{ text: string; reply_markup?: unknown }> = [];
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => ({ confirmed: true, ledger: 777 }),
      telegramApiDeps: {
        fetchFn: async (_url, init) => {
          editedCards.push(
            JSON.parse(String(init?.body ?? "{}")) as { text: string; reply_markup?: unknown },
          );
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const dest = (await generateTestSigner()).address;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_split_01";
    const sig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "333444", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "333444",
      actionType: "split",
      payloadJson: JSON.stringify({
        amount: "10",
        totalAmount: "20",
        participantCount: 2,
        assetCode: "XLM",
        destination: dest,
        recipientLabel: "@alice",
      }),
      hmacSig: sig,
      chatId: "-100222",
      messageId: "55",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const pay1 = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig, txHash: "a1".repeat(32) }),
      },
      TEST_ENV,
    );
    expect(pay1.status).toBe(200);
    const json1 = (await pay1.json()) as { status: string; paidCount: number };
    expect(json1.status).toBe("pending");
    expect(json1.paidCount).toBe(1);
    expect(editedCards[0]?.text).toContain("Paid:</b> 1/2");
    expect(editedCards[0]?.reply_markup).toBeDefined();

    const pay2 = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig, txHash: "b2".repeat(32) }),
      },
      TEST_ENV,
    );
    expect(pay2.status).toBe(200);
    const json2 = (await pay2.json()) as { status: string; paidCount: number };
    expect(json2.status).toBe("confirmed");
    expect(json2.paidCount).toBe(2);
    expect(editedCards[1]?.text).toContain("Split Fully Paid (2/2)");
  });

  it("handles 2-stage Claim Link escrow funding and claiming while blocking txHash replay", async () => {
    const repo = createMemoryRepo();
    const sender = await generateTestSigner();
    const editedCards: string[] = [];
    const seenInvokes: Array<{ fn?: string; arg0?: string }> = [];

    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async (_cfg, _hash, expected) => {
        seenInvokes.push({
          fn: expected?.sorobanInvoke?.functionName,
          arg0: expected?.sorobanInvoke?.firstArgHex,
        });
        return { confirmed: true, ledger: 888 };
      },
      telegramApiDeps: {
        fetchFn: async (_url, init) => {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          if (parsed.text) editedCards.push(parsed.text);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const envWithEscrow = {
      ...TEST_ENV,
      CLAIM_ESCROW_CONTRACT_ID: SOROBAN_HOST_FN_CONTRACT,
    };

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 86_400;
    const intentId = "it_claim_01";
    const expectedClaimId = await deriveClaimId(intentId);
    const sig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "444555", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "444555",
      actionType: "claim",
      payloadJson: JSON.stringify({
        amount: "25",
        assetCode: "XLM",
        recipientUsername: "newfriend",
        senderLabel: "@alice",
        claimId: expectedClaimId,
        escrowContractId: SOROBAN_HOST_FN_CONTRACT,
      }),
      hmacSig: sig,
      chatId: "-100333",
      messageId: "88",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const fundTxHash = "c3".repeat(32);
    const fundRes = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          txHash: fundTxHash,
          stage: "funded",
          senderAddress: sender.address,
        }),
      },
      envWithEscrow,
    );
    expect(fundRes.status).toBe(200);
    const fundJson = (await fundRes.json()) as { status: string; stage: string; claimId: string };
    expect(fundJson.status).toBe("signed");
    expect(fundJson.stage).toBe("funded");
    expect(fundJson.claimId).toBe(expectedClaimId);
    expect(seenInvokes[0]).toEqual({ fn: "create_claim", arg0: expectedClaimId });
    expect((await repo.getClaimLink(expectedClaimId))?.status).toBe("open");
    expect(editedCards[0]).toContain("Stellar Claim Link Ready");

    // Replaying funding txHash as claim txHash must fail with 409
    const replayClaimRes = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          txHash: fundTxHash,
          stage: "claimed",
        }),
      },
      envWithEscrow,
    );
    expect(replayClaimRes.status).toBe(409);

    const claimRes = await app.request(
      `/v1/intents/${intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          txHash: "d4".repeat(32),
          stage: "claimed",
        }),
      },
      envWithEscrow,
    );
    expect(claimRes.status).toBe(200);
    const claimJson = (await claimRes.json()) as { status: string; stage: string };
    expect(claimJson.status).toBe("confirmed");
    expect(claimJson.stage).toBe("claimed");
    expect(seenInvokes[1]).toEqual({ fn: "claim", arg0: expectedClaimId });
    expect((await repo.getClaimLink(expectedClaimId))?.status).toBe("claimed");
    expect(editedCards[1]).toContain("Claim Link Claimed");

    // Cancelling an open Claim Link intent updates claim -> refunded, intent -> cancelled, and edits card
    const cancelIntentId = "it_claim_cancel_01";
    const cancelClaimId = await deriveClaimId(cancelIntentId);
    const cancelSig = await signIntentToken(
      { intentId: cancelIntentId, network: "testnet", telegramUserId: "444555", expiresAt },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: cancelIntentId,
      network: "testnet",
      creatorTelegramUserId: "444555",
      actionType: "claim",
      payloadJson: JSON.stringify({
        amount: "10",
        assetCode: "XLM",
        recipientUsername: "bob",
        senderLabel: "@alice",
        claimId: cancelClaimId,
        escrowContractId: SOROBAN_HOST_FN_CONTRACT,
      }),
      hmacSig: cancelSig,
      chatId: "-100333",
      messageId: "89",
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    const fundCancelRes = await app.request(
      `/v1/intents/${cancelIntentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: cancelSig,
          txHash: "e5".repeat(32),
          stage: "funded",
          senderAddress: sender.address,
        }),
      },
      envWithEscrow,
    );
    expect(fundCancelRes.status).toBe(200);

    const cancelTxHash = "f6".repeat(32);
    const cancelRes = await app.request(
      `/v1/intents/${cancelIntentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: cancelSig,
          txHash: cancelTxHash,
          stage: "cancelled",
          payerAddress: sender.address,
        }),
      },
      envWithEscrow,
    );
    expect(cancelRes.status).toBe(200);
    const cancelJson = (await cancelRes.json()) as { status: string; stage: string };
    expect(cancelJson.status).toBe("cancelled");
    expect(cancelJson.stage).toBe("cancelled");
    expect(seenInvokes[3]).toEqual({ fn: "cancel_claim", arg0: cancelClaimId });
    expect((await repo.getClaimLink(cancelClaimId))?.status).toBe("refunded");
    expect((await repo.getSignedIntent(cancelIntentId))?.status).toBe("cancelled");
    expect(editedCards[3]).toContain("Claim Link Refunded");

    // Claiming after cancellation is blocked
    const claimAfterCancel = await app.request(
      `/v1/intents/${cancelIntentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: cancelSig,
          txHash: "a7".repeat(32),
          stage: "claimed",
        }),
      },
      envWithEscrow,
    );
    expect(claimAfterCancel.status).toBe(409);

    // Verifies expectedActionType and expectedSourceAccount against decoded envelope XDR
    const paymentTxFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          successful: true,
          ledger: 999,
          created_at: new Date().toISOString(),
          envelope_xdr: BENIGN_PAYMENT_TX_XDR,
        }),
        { status: 200 },
      );

    const badReclaim = await verifyTransactionConfirmed(
      {
        horizonUrls: [TEST_ENV.HORIZON_URLS],
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
      },
      "b8".repeat(32),
      paymentTxFetch,
      { expectedActionType: "reclaim_reserve" },
    );
    expect(badReclaim.confirmed).toBe(false);

    const badSwap = await verifyTransactionConfirmed(
      {
        horizonUrls: [TEST_ENV.HORIZON_URLS],
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
      },
      "b8".repeat(32),
      paymentTxFetch,
      { expectedActionType: "swap" },
    );
    expect(badSwap.confirmed).toBe(false);

    const badSource = await verifyTransactionConfirmed(
      {
        horizonUrls: [TEST_ENV.HORIZON_URLS],
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
      },
      "b8".repeat(32),
      paymentTxFetch,
      { expectedSourceAccount: sender.address },
    );
    expect(badSource.confirmed).toBe(false);

    const goodSource = await verifyTransactionConfirmed(
      {
        horizonUrls: [TEST_ENV.HORIZON_URLS],
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
      },
      "b8".repeat(32),
      paymentTxFetch,
      {
        expectedSourceAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      },
    );
    expect(goodSource).toEqual({ confirmed: true, ledger: 999 });
  });

  it("enforces daily relay budget, streaming 128KB stellar.toml cap, update_id dedup, and dust/SEP-42 indexer filtering", async () => {
    const repo = createMemoryRepo();
    const signer = await generateTestSigner();
    await repo.linkVerifiedAddresses({
      telegramUserId: "444000",
      usernameLower: "dave",
      accounts: [
        {
          address: signer.address,
          kind: "classic",
          label: "Main",
          isDefault: true,
          verifiedSigHash: "sig_dave",
        },
      ],
    });

    const alerts: string[] = [];
    const app = createApp({
      createRepo: () => repo,
      telegramApiDeps: {
        fetchFn: async (_url, init) => {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          if (parsed.text) alerts.push(parsed.text);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      fetchFn: async (url) => {
        const str = String(url);
        if (str.includes("/getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 1,
                is_bot: true,
                first_name: "AstroWallet",
                username: "AstroWalletTestBot",
                can_join_groups: true,
                can_read_all_group_messages: false,
                supports_inline_queries: true,
              },
            }),
            { status: 200 },
          );
        }
        if (str.includes("channels.openzeppelin.com")) {
          return new Response(JSON.stringify({ hash: "e".repeat(64), status: "submitted" }), {
            status: 200,
          });
        }
        if (str.includes("stellar.toml")) {
          const chunk = new Uint8Array(40 * 1024).fill(65);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 4; i += 1) controller.enqueue(chunk); // 160 KB > 128 KB
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // 1. Relay daily budget exhaustion -> 429
    const tightBudgetEnv = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.openzeppelin.com/testnet",
      RELAY_ALLOWED_CONTRACTS: SOROBAN_HOST_FN_CONTRACT,
      RELAY_MAX_FEE_STROOPS: "100",
      RELAY_DAILY_BUDGET_STROOPS: "150",
    };
    const r1 = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          walletAuth: await signRelayWalletAuth(
            signer,
            "testnet",
            "feebump",
            BENIGN_PAYMENT_TX_XDR,
          ),
        }),
      },
      tightBudgetEnv,
    );
    expect(r1.status).toBe(200);
    const r2 = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          walletAuth: await signRelayWalletAuth(
            signer,
            "testnet",
            "feebump",
            BENIGN_PAYMENT_TX_XDR,
          ),
        }),
      },
      tightBudgetEnv,
    );
    expect(r2.status).toBe(429);

    // 2. Streaming stellar.toml > 128 KB returns 413 even without Content-Length
    const tomlRes = await app.request(
      "/v1/proxy/stellar-toml?domain=issuer.example.org",
      { method: "GET" },
      TEST_ENV,
    );
    expect(tomlRes.status).toBe(413);

    // 3. Telegram webhook duplicate update_id short-circuits cleanly
    const tgDup1 = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": TEST_ENV.TG_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ update_id: 987654321 }),
      },
      TEST_ENV,
    );
    // Second request with identical update_id returns duplicate: true immediately
    const tgDup2 = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": TEST_ENV.TG_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ update_id: 987654321 }),
      },
      TEST_ENV,
    );
    expect(tgDup2.status).toBe(200);
    expect(((await tgDup2.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(tgDup1.status).not.toBe(401);

    // 4. Indexer drops native dust < 0.05 XLM and marks unverified non-SEP-42 issuers
    const idxEnv = { ...TEST_ENV, INDEXER_WEBHOOK_SECRET: "idx-secret-123" };
    const idxRes = await app.request(
      "/webhooks/indexer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Indexer-Secret": "idx-secret-123",
        },
        body: JSON.stringify({
          events: [
            {
              txHash: "1a".repeat(32),
              from: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
              to: signer.address,
              amount: "0.0001000",
              assetCode: "XLM",
            },
            {
              txHash: "2b".repeat(32),
              from: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
              to: signer.address,
              amount: "10.0000000",
              assetCode: "USDC",
              assetIssuer: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
            },
          ],
        }),
      },
      idxEnv,
    );
    expect(idxRes.status).toBe(200);
    const idxJson = (await idxRes.json()) as { alertsSent: number };
    expect(idxJson.alertsSent).toBe(1);
    expect(alerts[0]).toContain("Unverified");
  });

  it("authenticates Mini App initData sessions, prevents cross-user intent access, and emits native web_app vs t.me startapp bot buttons", async () => {
    const repo = createMemoryRepo();
    const sentPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 999000,
                is_bot: true,
                first_name: "AstroWallet",
                username: "AstroWalletTestBot",
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          sentPayloads.push({ url, body: parsedBody });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: 101, chat: { id: Number(parsedBody.chat_id ?? 1) } },
            }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const miniAppEnv = {
      ...TEST_ENV,
      TG_BOT_USERNAME: "AstroWalletTestBot",
      TG_MINI_APP_SHORT_NAME: "wallet",
    };

    // 1. Valid Telegram.WebApp.initData exchanges cleanly for a 15m Mini App sessionToken
    const now = Math.floor(Date.now() / 1000);
    const initPairs: Array<[string, string]> = [
      ["auth_date", String(now - 5)],
      ["start_param", encodeStartAppTabParam("ton")],
      ["user", JSON.stringify({ id: 777111, username: "alice_tg", first_name: "Alice" })],
    ];
    initPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const initHash = await computeTelegramInitDataHash(
      initPairs.map(([k, v]) => `${k}=${v}`).join("\n"),
      miniAppEnv.TG_BOT_TOKEN,
    );
    const initParams = new URLSearchParams(Object.fromEntries(initPairs));
    initParams.set("hash", initHash);

    const authRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initParams.toString() }),
      },
      miniAppEnv,
    );
    expect(authRes.status).toBe(200);
    const authJson = (await authRes.json()) as {
      sessionToken: string;
      startParam: string;
      user: { id: string };
    };
    expect(authJson.startParam).toBe("t-ton");
    expect(authJson.user.id).toBe("777111");

    // Bad initData fails closed (401)
    const badAuthRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: `${initParams.toString()}&extra=tamper` }),
      },
      miniAppEnv,
    );
    expect(badAuthRes.status).toBe(401);

    // 2. Link wallet directly inside Mini App via /v1/tg/link-challenge + /v1/tg/link-confirm
    const signer = await generateTestSigner();
    const challengeRes = await app.request(
      "/v1/tg/link-challenge",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${authJson.sessionToken}` },
      },
      miniAppEnv,
    );
    expect(challengeRes.status).toBe(200);
    const challengeJson = (await challengeRes.json()) as {
      intentId: string;
      sig: string;
      message: string;
    };

    const sigB64 = await signer.signChallenge(challengeJson.message);
    const confirmRes = await app.request(
      "/v1/tg/link-confirm",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authJson.sessionToken}`,
        },
        body: JSON.stringify({
          intentId: challengeJson.intentId,
          sig: challengeJson.sig,
          accounts: [
            {
              address: signer.address,
              kind: "classic",
              label: "MiniApp Primary",
              isDefault: true,
              signatureBase64: sigB64,
            },
          ],
        }),
      },
      miniAppEnv,
    );
    expect(confirmRes.status).toBe(200);

    const meRes = await app.request(
      "/v1/tg/me",
      { headers: { Authorization: `Bearer ${authJson.sessionToken}` } },
      miniAppEnv,
    );
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as { linkedAccounts: Array<{ address: string }> };
    expect(meJson.linkedAccounts.some((a) => a.address === signer.address)).toBe(true);

    // 3. Session-authenticated POST /v1/intents/:id/connect works without manual confirmCode,
    // while another user's sessionToken is blocked with 403!
    const bob = await signMiniAppSessionToken(
      {
        telegramUserId: "999222",
        network: "testnet",
        issuedAt: now,
        expiresAt: now + 900,
      },
      miniAppEnv.INTENT_HMAC_SECRET,
    );
    const ch2: ConnectChallengePayload = {
      challengeId: "ch_session_1",
      network: "testnet",
      telegramUserId: "777111",
      issuedAt: now,
      expiresAt: now + 300,
    };
    const msg2 = formatConnectChallengeMessage(ch2);
    const sig2 = await signIntentToken(
      { intentId: "it_conn_session", network: "testnet", telegramUserId: "777111", expiresAt: now + 300 },
      miniAppEnv.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "it_conn_session",
      network: "testnet",
      creatorTelegramUserId: "777111",
      actionType: "connect",
      payloadJson: JSON.stringify({ message: msg2, confirmCode: "ZZ99AA" }),
      hmacSig: sig2,
      status: "pending",
      expiresAt: now + 300,
      createdAt: now,
    });

    const bobGet = await app.request(
      `/v1/intents/it_conn_session?sig=${sig2}`,
      { headers: { Authorization: `Bearer ${bob}` } },
      miniAppEnv,
    );
    expect(bobGet.status).toBe(403);

    const aliceConnect = await app.request(
      `/v1/intents/it_conn_session/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authJson.sessionToken}`,
        },
        body: JSON.stringify({
          sig: sig2,
          accounts: [
            {
              address: signer.address,
              kind: "classic",
              label: "Primary",
              signatureBase64: await signer.signChallenge(msg2),
            },
          ],
        }),
      },
      miniAppEnv,
    );
    expect(aliceConnect.status).toBe(200);

    // 4. Bot emits web_app button in private DM and t.me/...?startapp=... in groups
    const startWebhook = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": miniAppEnv.TG_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 445501,
          message: {
            message_id: 10,
            date: now,
            chat: { id: 777111, type: "private" },
            from: { id: 777111, is_bot: false, first_name: "Alice", username: "alice_tg" },
            text: "/start",
            entities: [{ offset: 0, length: 6, type: "bot_command" }],
          },
        }),
      },
      miniAppEnv,
    );
    expect(startWebhook.status).toBe(200);

    const groupPayWebhook = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": miniAppEnv.TG_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 445502,
          message: {
            message_id: 11,
            date: now,
            chat: { id: -100123456, type: "supergroup", title: "Stellar Group" },
            from: { id: 777111, is_bot: false, first_name: "Alice", username: "alice_tg" },
            text: `/pay 5 XLM ${signer.address}`,
            entities: [{ offset: 0, length: 4, type: "bot_command" }],
          },
        }),
      },
      miniAppEnv,
    );
    expect(groupPayWebhook.status).toBe(200);

    const startMsg = sentPayloads[0]?.body as {
      reply_markup?: { inline_keyboard?: Array<Array<{ web_app?: { url: string }; url?: string }>> };
    };
    expect(startMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(
      "https://testnet.astrowallet.example/app",
    );

    const groupMsg = sentPayloads[1]?.body as {
      reply_markup?: { inline_keyboard?: Array<Array<{ web_app?: { url: string }; url?: string }>> };
    };
    const groupUrl = groupMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? "";
    expect(groupUrl).toMatch(/^https:\/\/t\.me\/AstroWalletTestBot\/wallet\?startapp=i-/);
  });

  it("stores, verifies, and deletes Zero-Knowledge encrypted vault backups strictly per telegram_user_id", async () => {
    const repo = createMemoryRepo();
    const app = createApp({ createRepo: () => repo });

    // 1. Unauthenticated requests fail closed (401)
    expect((await app.request("/v1/tg/vault-backup", {}, TEST_ENV)).status).toBe(401);
    expect(
      (await app.request("/v1/tg/vault-backup", { method: "PUT", body: "{}" }, TEST_ENV)).status,
    ).toBe(401);

    const now = Math.floor(Date.now() / 1000);
    const sessionToken = await signMiniAppSessionToken(
      {
        telegramUserId: "555777",
        usernameLower: "zk_tester",
        network: "testnet",
        issuedAt: now,
        expiresAt: now + 900,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    const validEnvelope = {
      version: 1,
      format: "AGVAULT",
      kdf: {
        algorithm: "argon2id",
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 1,
        hashLength: 32,
      },
      saltB64: "AAAAAAAAAAAAAAAAAAAAAA==",
      ivB64: "AAAAAAAAAAAAAAAA",
      ciphertextB64: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      createdAt: now,
      updatedAt: now,
    };

    // 2. Rejects plaintext extra fields and weak Argon2id params
    const badExtra = await app.request(
      "/v1/tg/vault-backup",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          envelope: { ...validEnvelope, mnemonic: "secret phrase" },
        }),
      },
      TEST_ENV,
    );
    expect(badExtra.status).toBe(400);

    const weakKdf = await app.request(
      "/v1/tg/vault-backup",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          envelope: {
            ...validEnvelope,
            kdf: { ...validEnvelope.kdf, memoryKiB: 1024 },
          },
        }),
      },
      TEST_ENV,
    );
    expect(weakKdf.status).toBe(400);

    // 3. Round-trip PUT -> GET /me -> GET /vault-backup -> /v1/tg/auth -> DELETE -> GET empty
    const putRes = await app.request(
      "/v1/tg/vault-backup",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ envelope: validEnvelope }),
      },
      TEST_ENV,
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { ok: boolean; envelopeSha256: string };
    expect(putJson.ok).toBe(true);
    expect(putJson.envelopeSha256).toMatch(/^[a-f0-9]{64}$/);

    const meRes = await app.request(
      "/v1/tg/me",
      { headers: { Authorization: `Bearer ${sessionToken}` } },
      TEST_ENV,
    );
    const meJson = (await meRes.json()) as { hasEncryptedBackup: boolean; backupUpdatedAt?: number };
    expect(meJson.hasEncryptedBackup).toBe(true);
    expect(meJson.backupUpdatedAt).toBeGreaterThan(0);

    const getRes = await app.request(
      "/v1/tg/vault-backup",
      { headers: { Authorization: `Bearer ${sessionToken}` } },
      TEST_ENV,
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      hasBackup: boolean;
      backup?: { envelope: typeof validEnvelope; envelopeSha256: string };
    };
    expect(getJson.hasBackup).toBe(true);
    expect(getJson.backup?.envelope).toEqual(validEnvelope);
    expect(getJson.backup?.envelopeSha256).toBe(putJson.envelopeSha256);

    const authPairs: Array<[string, string]> = [
      ["auth_date", String(now - 2)],
      ["user", JSON.stringify({ id: 555777, username: "zk_tester", first_name: "ZK" })],
    ];
    authPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const authHash = await computeTelegramInitDataHash(
      authPairs.map(([k, v]) => `${k}=${v}`).join("\n"),
      TEST_ENV.TG_BOT_TOKEN,
    );
    const authParams = new URLSearchParams(Object.fromEntries(authPairs));
    authParams.set("hash", authHash);
    const authRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: authParams.toString() }),
      },
      TEST_ENV,
    );
    const authJson = (await authRes.json()) as { hasEncryptedBackup: boolean };
    expect(authJson.hasEncryptedBackup).toBe(true);

    const delRes = await app.request(
      "/v1/tg/vault-backup",
      { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` } },
      TEST_ENV,
    );
    expect(delRes.status).toBe(200);
    expect((await delRes.json()) as { ok: boolean; deleted: boolean }).toEqual({
      ok: true,
      deleted: true,
    });

    const afterDel = await app.request(
      "/v1/tg/vault-backup",
      { headers: { Authorization: `Bearer ${sessionToken}` } },
      TEST_ENV,
    );
    expect((await afterDel.json()) as { hasBackup: boolean }).toEqual({ hasBackup: false });
  });

  it("resolves AstroID public accounts via /v1/identity/resolve without leaking encrypted vault backups", async () => {
    const repo = createMemoryRepo();
    const signer = await generateTestSigner();
    await repo.linkVerifiedAddresses({
      telegramUserId: "777888",
      usernameLower: "astro_pilot",
      accounts: [
        {
          address: signer.address,
          kind: "classic",
          label: "Primary",
          isDefault: true,
          verifiedSigHash: "sig_identity_test",
        },
      ],
    });
    await repo.upsertEncryptedVaultBackup({
      telegramUserId: "777888",
      network: "testnet",
      envelopeJson: JSON.stringify({ secret: "must-never-leak" }),
      envelopeSha256: "a".repeat(64),
      version: 1,
    });

    const app = createApp({ createRepo: () => repo });

    for (const q of ["777888", "@astro_pilot", signer.address]) {
      const res = await app.request(
        `/v1/identity/resolve?q=${encodeURIComponent(q)}`,
        {},
        TEST_ENV,
      );
      expect(res.status).toBe(200);
      const rawText = await res.text();
      expect(rawText).not.toContain("must-never-leak");
      expect(rawText).not.toContain("envelopeJson");
      const json = JSON.parse(rawText) as {
        ok: boolean;
        found: boolean;
        telegramUserId: string;
        username?: string;
        primaryAddress: string;
        accounts: Array<{ address: string; kind: string; isDefault: boolean }>;
      };
      expect(json.ok).toBe(true);
      expect(json.found).toBe(true);
      expect(json.telegramUserId).toBe("777888");
      expect(json.username).toBe("astro_pilot");
      expect(json.primaryAddress).toBe(signer.address);
      expect(json.accounts).toHaveLength(1);
    }

    const unknownRes = await app.request("/v1/identity/resolve?q=@unknown_user_99", {}, TEST_ENV);
    expect(unknownRes.status).toBe(200);
    expect((await unknownRes.json()) as { ok: boolean; found: boolean }).toEqual({
      ok: true,
      found: false,
      accounts: [],
    });
  });

  it("federates CrossAppIntentEnvelope v1 via POST /v1/intents/external and verifies confirmation", async () => {
    const repo = createMemoryRepo();
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => ({ confirmed: true, ledger: 551100 }),
    });

    const sharedSecret = "ecosystem-shared-secret-at-least-32-chars!!";
    const envWithEcosystem = {
      ...TEST_ENV,
      TG_BOT_USERNAME: "AstroWalletAppBot",
      TG_MINI_APP_SHORT_NAME: "wallet",
      ECOSYSTEM_SHARED_INTENT_SECRET: sharedSecret,
    };

    const xdrBytes = new TextEncoder().encode(BENIGN_PAYMENT_TX_XDR);
    const xdrDigest = await crypto.subtle.digest("SHA-256", xdrBytes);
    const xdrSha256 = Array.from(new Uint8Array(xdrDigest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const validBody = {
      intentId: "ad_sync_intent_01",
      telegramUserId: "777888",
      actionType: "sign_xdr" as const,
      envelope: {
        version: 1 as const,
        originApp: "astrodex" as const,
        subAction: "sdex_limit_order_create",
        humanSummary: "Create SDEX Sell Offer: 100 XLM @ 0.12 USDC",
        unsignedXdr: BENIGN_PAYMENT_TX_XDR,
        xdrSha256,
        returnStartAppParam: "token_XLM",
      },
    };

    // 1. Rejects missing/bad X-Ecosystem-Secret
    const unauthRes = await app.request(
      "/v1/intents/external",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ecosystem-Secret": "wrong-secret-0000000000000000000000000000",
        },
        body: JSON.stringify(validBody),
      },
      envWithEcosystem,
    );
    expect(unauthRes.status).toBe(401);

    // 2. Rejects mismatched xdrSha256
    const badShaRes = await app.request(
      "/v1/intents/external",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ecosystem-Secret": sharedSecret,
        },
        body: JSON.stringify({
          ...validBody,
          envelope: { ...validBody.envelope, xdrSha256: "f".repeat(64) },
        }),
      },
      envWithEcosystem,
    );
    expect(badShaRes.status).toBe(400);

    // 3. Accepts valid swap & sign_xdr CrossAppIntentEnvelope v1
    const okRes = await app.request(
      "/v1/intents/external",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ecosystem-Secret": sharedSecret,
        },
        body: JSON.stringify(validBody),
      },
      envWithEcosystem,
    );
    expect(okRes.status).toBe(200);
    const created = (await okRes.json()) as {
      ok: boolean;
      intentId: string;
      sig: string;
      expiresAt: number;
      deepLink: string;
    };
    expect(created.ok).toBe(true);
    expect(created.intentId).toBe("ad_sync_intent_01");
    expect(created.sig).toMatch(/^[a-f0-9]{64}$/);
    expect(created.deepLink).toContain(
      `startapp=i-${created.intentId}-${created.sig}`,
    );

    // 4. Fetch intent + confirm transaction
    const getRes = await app.request(
      `/v1/intents/${created.intentId}?sig=${created.sig}`,
      {},
      envWithEcosystem,
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      actionType: string;
      payload: { originApp: string; subAction: string; xdrSha256: string };
    };
    expect(fetched.actionType).toBe("sign_xdr");
    expect(fetched.payload.originApp).toBe("astrodex");
    expect(fetched.payload.xdrSha256).toBe(xdrSha256);

    const confirmRes = await app.request(
      `/v1/intents/${created.intentId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          txHash: "1".repeat(64),
        }),
      },
      envWithEcosystem,
    );
    expect(confirmRes.status).toBe(200);
    expect(((await confirmRes.json()) as { status: string }).status).toBe("confirmed");
  });

  it("dispatches Boomerang callback to ASTRODEX binding and resolves AstroID via O(1) linked address lookup", async () => {
    const repo = createMemoryRepo();
    const callbacks: Array<{ url: string; secret: string | null; body: unknown }> = [];
    const envWithBindings = {
      ...TEST_ENV,
      TG_BOT_USERNAME: "AstroWalletAppBot",
      TG_MINI_APP_SHORT_NAME: "wallet",
      ECOSYSTEM_SHARED_INTENT_SECRET: "eco_secret_boomerang_1234567890_ok",
      ASTRODEX_API_BASE_URL: "https://astrodex-testnet.pages.dev",
      ASTRODEX: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          const headers = new Headers(
            input instanceof Request ? input.headers : init?.headers,
          );
          const rawBody =
            input instanceof Request
              ? await input.clone().text()
              : typeof init?.body === "string"
                ? init.body
                : "{}";
          callbacks.push({
            url,
            secret: headers.get("X-Ecosystem-Secret"),
            body: JSON.parse(rawBody),
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    };
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => ({ confirmed: true, ledger: 551100 }),
    });

    const payerAddress = encodeClassicStrKey(new Uint8Array(32).fill(19));
    await repo.linkVerifiedAddresses({
      telegramUserId: "55112233",
      usernameLower: "boomerang_trader",
      accounts: [{ address: payerAddress, kind: "G", label: "Main", isDefault: true }],
    });

    const resolveRes = await app.request(`/v1/identity/resolve?q=${payerAddress}`, {}, envWithBindings);
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as { found: boolean; telegramUserId?: string; username?: string };
    expect(resolved.found).toBe(true);
    expect(resolved.telegramUserId).toBe("55112233");
    expect(resolved.username).toBe("boomerang_trader");

    const xdrBytes = new TextEncoder().encode(BENIGN_PAYMENT_TX_XDR);
    const xdrDigest = await crypto.subtle.digest("SHA-256", xdrBytes);
    const xdrSha256 = Array.from(new Uint8Array(xdrDigest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const extRes = await app.request(
      "/v1/intents/external",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ecosystem-Secret": envWithBindings.ECOSYSTEM_SHARED_INTENT_SECRET,
        },
        body: JSON.stringify({
          intentId: "ad_boomerang_01",
          telegramUserId: "55112233",
          actionType: "sign_xdr",
          envelope: {
            version: 1,
            originApp: "astrodex",
            subAction: "sdex_limit_order_create",
            humanSummary: "Swap 10 XLM -> USDC",
            unsignedXdr: BENIGN_PAYMENT_TX_XDR,
            xdrSha256,
            callbackUrl: "https://astrodex-testnet.pages.dev/v1/intents/ad_boomerang_01/confirm",
            sourceAddress: payerAddress,
            originConfirmSig: "c".repeat(64),
          },
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        }),
      },
      envWithBindings,
    );
    expect(extRes.status).toBe(200);
    const created = (await extRes.json()) as { sig: string };

    const confirmRes = await app.request(
      "/v1/intents/ad_boomerang_01/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          txHash: "2".repeat(64),
          payerAddress,
        }),
      },
      envWithBindings,
    );
    expect(confirmRes.status).toBe(200);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.url).toBe("https://astrodex.internal/v1/intents/ad_boomerang_01/confirm");
    expect(callbacks[0]?.secret).toBe(envWithBindings.ECOSYSTEM_SHARED_INTENT_SECRET);
    expect(callbacks[0]?.body).toEqual({
      sig: "c".repeat(64),
      txHash: "2".repeat(64),
    });
  });

  it("supports ChannelPoolDO tx_bad_seq retry, /v1/connect/scan, and /v1/relay/bootstrap fail-closed gates", async () => {
    const repo = createMemoryRepo();
    const pool = new ChannelPoolDO({} as never, {});
    const channel1 = Keypair.random().publicKey();
    const channel2 = Keypair.random().publicKey();
    const sponsorKp = Keypair.random();
    const newUserKp = Keypair.random();
    const fundedKp = Keypair.random();

    const usedChannels: string[] = [];
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("channels.openzeppelin.com")) {
          const headers = new Headers(init?.headers);
          const ch = headers.get("X-Channel-Account") ?? "";
          usedChannels.push(ch);
          if (usedChannels.length === 1) {
            return new Response("tx_bad_seq", { status: 400 });
          }
          return new Response(JSON.stringify({ hash: "9".repeat(64), status: "submitted" }), {
            status: 200,
          });
        }
        if (url.includes(`/accounts/${newUserKp.publicKey()}`)) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes(`/accounts/${fundedKp.publicKey()}`)) {
          return new Response(JSON.stringify({ sequence: "10" }), { status: 200 });
        }
        if (url.includes(`/accounts/${sponsorKp.publicKey()}`)) {
          return new Response(JSON.stringify({ sequence: "100" }), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // 1. Open-CORS /v1/connect/scan
    const scanRes = await app.request(
      "/v1/connect/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://external.example" },
        body: JSON.stringify({ target: newUserKp.publicKey() }),
      },
      TEST_ENV,
    );
    expect(scanRes.status).toBe(200);
    expect(scanRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // 2. ChannelPoolDO lease + tx_bad_seq retry
    const intentNow = Math.floor(Date.now() / 1000);
    const intentExpiresAt = intentNow + 300;
    const intentSig = await signIntentToken(
      {
        intentId: "int_chan01",
        network: "testnet",
        telegramUserId: "55112233",
        expiresAt: intentExpiresAt,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "int_chan01",
      network: "testnet",
      actionType: "sign_xdr",
      creatorTelegramUserId: "55112233",
      payloadJson: JSON.stringify({ humanSummary: "Test channel pool" }),
      hmacSig: intentSig,
      status: "pending",
      expiresAt: intentExpiresAt,
      createdAt: intentNow,
    });

    const envWithPool = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.openzeppelin.com/testnet",
      RELAY_ALLOWED_CONTRACTS: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      RELAY_CHANNEL_ACCOUNTS: `${channel1},${channel2}`,
      CHANNEL_POOL: {
        idFromName: (name: string) => name as never,
        get: () => pool as never,
      },
    };

    const relayRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: BENIGN_PAYMENT_TX_XDR,
          intentAuth: { intentId: "int_chan01", sig: intentSig },
        }),
      },
      envWithPool as never,
    );
    expect(relayRes.status).toBe(200);
    expect(usedChannels).toHaveLength(2);
    expect(usedChannels[0]).not.toBe(usedChannels[1]);

    // 3. /v1/relay/bootstrap fail-closed checks
    const unconfiguredBoot = await app.request(
      "/v1/relay/bootstrap",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      TEST_ENV,
    );
    expect(unconfiguredBoot.status).toBe(503);

    const now = Math.floor(Date.now() / 1000);
    const initPairs: Array<[string, string]> = [
      ["auth_date", String(now - 5)],
      ["user", JSON.stringify({ id: 888999, username: "boot_user", first_name: "Boot" })],
    ];
    initPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const initHash = await computeTelegramInitDataHash(
      initPairs.map(([k, v]) => `${k}=${v}`).join("\n"),
      TEST_ENV.TG_BOT_TOKEN,
    );
    const initParams = new URLSearchParams(Object.fromEntries(initPairs));
    initParams.set("hash", initHash);
    const authRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initParams.toString() }),
      },
      TEST_ENV,
    );
    const { sessionToken } = (await authRes.json()) as { sessionToken: string };
    const bootEnv = { ...TEST_ENV, RELAY_SPONSOR_SECRET: sponsorKp.secret() };

    const makeBootSig = async (kp: Keypair, nonce: string) => {
      const msg = `astrowallet-bootstrap:v1:testnet:${kp.publicKey()}:${now}:${nonce}`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${msg}`),
      );
      return Buffer.from(kp.sign(Buffer.from(digest))).toString("base64");
    };

    // Already funded -> 409
    const fundedRes = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          address: fundedKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "nonce_funded_1",
          signatureBase64: await makeBootSig(fundedKp, "nonce_funded_1"),
        }),
      },
      bootEnv,
    );
    expect(fundedRes.status).toBe(409);

    // Invalid sig -> 403
    const badSigRes = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          address: newUserKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "nonce_badsig_1",
          signatureBase64: Buffer.alloc(64, 1).toString("base64"),
        }),
      },
      bootEnv,
    );
    expect(badSigRes.status).toBe(403);

    // Valid sponsored_reserve -> 200 with sponsorSignedXdr, then replay -> 409
    const goodSig = await makeBootSig(newUserKp, "nonce_good_1");
    const okBoot = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          address: newUserKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "nonce_good_1",
          signatureBase64: goodSig,
        }),
      },
      bootEnv,
    );
    expect(okBoot.status).toBe(200);
    const bootJson = (await okBoot.json()) as {
      ok: boolean;
      sponsorSignedXdr: string;
      sponsorAddress: string;
    };
    expect(bootJson.ok).toBe(true);
    expect(bootJson.sponsorAddress).toBe(sponsorKp.publicKey());
    expect(bootJson.sponsorSignedXdr.length).toBeGreaterThan(32);

    const replayBoot = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          address: newUserKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "nonce_good_2",
          signatureBase64: await makeBootSig(newUserKp, "nonce_good_2"),
        }),
      },
      bootEnv,
    );
    expect(replayBoot.status).toBe(409);
  });

  it("proxies SEP-0002 Federation via /v1/proxy/federation and blocks SSRF domains", async () => {
    const repo = createMemoryRepo();
    const targetAddr = Keypair.random().publicKey();
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://example.org/.well-known/stellar.toml") {
          return new Response('FEDERATION_SERVER = "https://fed.example.org/federation"\n', {
            status: 200,
          });
        }
        if (url.startsWith("https://fed.example.org/federation?q=alice*example.org")) {
          return new Response(
            JSON.stringify({ account_id: targetAddr, memo_type: "text", memo: "hi" }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const badFormat = await app.request("/v1/proxy/federation?q=invalid", {}, TEST_ENV);
    expect(badFormat.status).toBe(400);

    const ssrfRes = await app.request("/v1/proxy/federation?q=alice*localhost", {}, TEST_ENV);
    expect(ssrfRes.status).toBe(400);

    const okRes = await app.request("/v1/proxy/federation?q=alice*example.org", {}, TEST_ENV);
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      accountId: targetAddr,
      memoType: "text",
      memo: "hi",
    });
  });

  it("caches /v1/proxy/market/history and /v1/proxy/market/token in KV with MISS -> KV-HIT", async () => {
    const repo = createMemoryRepo();
    const kvStore = new Map<string, string>();
    const mockCache = {
      get: async (k: string) => kvStore.get(k) ?? null,
      put: async (k: string, v: string) => {
        kvStore.set(k, v);
      },
    };
    const envWithCache = { ...TEST_ENV, CACHE: mockCache };
    const issuer = Keypair.random().publicKey();
    let horizonCalls = 0;

    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        horizonCalls += 1;
        const url = String(input);
        if (url.includes("/trade_aggregations")) {
          return new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  {
                    timestamp: "1759996400000",
                    open: "10.0",
                    high: "10.5",
                    low: "9.9",
                    close: "10.2",
                    base_volume: "50.0",
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 });
      },
    });

    const first = await app.request(
      `/v1/proxy/market/history?code=USDC&issuer=${issuer}&timeframe=1y`,
      {},
      envWithCache,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Astro-Cache")).toBe("MISS");
    const firstBody = (await first.json()) as { latestPriceXlm?: number };
    expect(firstBody.latestPriceXlm).toBe(10.2);
    expect(horizonCalls).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = horizonCalls;

    const second = await app.request(
      `/v1/proxy/market/history?code=USDC&issuer=${issuer}&timeframe=1y`,
      {},
      envWithCache,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Astro-Cache")).toBe("KV-HIT");
    expect(horizonCalls).toBe(callsAfterFirst);

    const tokenRes = await app.request("/v1/proxy/market/token?code=XLM", {}, envWithCache);
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { details?: { assetCode?: string } };
    expect(tokenBody.details?.assetCode).toBe("XLM");
  });

  it("records privacy-first telemetry events and serves open-CORS /v1/metrics/public and badge.svg", async () => {
    const repo = createMemoryRepo();
    const app = createApp({ createRepo: () => repo });

    const evRes = await app.request(
      "/v1/metrics/event",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "tx_sent",
          platform: "ios",
          txHash: "a".repeat(64),
          assetCode: "XLM",
          amountEst: "5",
        }),
      },
      TEST_ENV,
    );
    expect(evRes.status).toBe(200);

    const pubRes = await app.request(
      "/v1/metrics/public",
      { method: "GET", headers: { Origin: "https://scf.stellar.org" } },
      TEST_ENV,
    );
    expect(pubRes.status).toBe(200);
    expect(pubRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const pubJson = (await pubRes.json()) as {
      ok: boolean;
      service: string;
      privacy: { cookies: boolean; piiExposed: boolean };
      metrics: { verifiedTxCount: number; eventBreakdown: Record<string, number> };
    };
    expect(pubJson.ok).toBe(true);
    expect(pubJson.service).toBe("astrowallet");
    expect(pubJson.privacy.cookies).toBe(false);
    expect(pubJson.privacy.piiExposed).toBe(false);
    expect(pubJson.metrics.verifiedTxCount).toBe(1);
    expect(pubJson.metrics.eventBreakdown.tx_sent).toBe(1);

    const badgeRes = await app.request("/v1/metrics/badge.svg", { method: "GET" }, TEST_ENV);
    expect(badgeRes.status).toBe(200);
    expect(badgeRes.headers.get("Content-Type")).toContain("image/svg+xml");
  });

  it("auto-routes /pay for non-XLM asset into ClaimEscrow when recipient @bob lacks trustline", async () => {
    const repo = createMemoryRepo();
    const bobAddr = Keypair.random().publicKey() as ClassicAddress;
    const usdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    await repo.linkVerifiedAddresses({
      telegramUserId: "2002",
      usernameLower: "bob_user",
      accounts: [
        {
          address: bobAddr,
          accountKind: "classic",
          label: "Main",
          derivationIndex: 0,
          isDefault: true,
        },
      ],
    });

    const createdIntents: SignedIntent[] = [];
    const origCreate = repo.createSignedIntent.bind(repo);
    repo.createSignedIntent = async (intent) => {
      createdIntents.push(intent);
      return origCreate(intent);
    };

    const telegramReplies: string[] = [];
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("api.telegram.org")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          if (body.text) telegramReplies.push(body.text);
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 1001, type: "private" } } }),
            { status: 200 },
          );
        }
        if (url.includes(`/accounts/${bobAddr}`)) {
          return new Response(
            JSON.stringify({
              id: bobAddr,
              balances: [{ asset_type: "native", balance: "10.0000000" }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("sep42") || url.includes("asset-list")) {
          return new Response(
            JSON.stringify({
              assets: [{ code: "USDC", issuer: usdcIssuer }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      },
    });

    const res = await app.request(
      "/tg/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": TEST_ENV.TG_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 991001,
          message: {
            message_id: 12,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 1001, type: "private" },
            from: { id: 1001, is_bot: false, first_name: "Alice", username: "alice_user" },
            text: "/pay 5 USDC @bob_user",
            entities: [{ offset: 0, length: 4, type: "bot_command" }],
          },
        }),
      },
      {
        ...TEST_ENV,
        CLAIM_ESCROW_CONTRACT_ID: "CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ",
        SEP42_ASSET_LIST_URLS: "https://api.stellar.expert/explorer/testnet/asset-list/top50",
      },
    );

    expect(res.status).toBe(200);
    expect(createdIntents).toHaveLength(1);
    expect(createdIntents[0]?.actionType).toBe("claim");
    const payload = JSON.parse(createdIntents[0]!.payloadJson) as {
      autoEscrowReason?: string;
      assetCode?: string;
      recipientUsername?: string;
    };
    expect(payload.autoEscrowReason).toBe("missing_trustline");
    expect(payload.assetCode).toBe("USDC");
    expect(payload.recipientUsername).toBe("bob_user");
    expect(telegramReplies.some((t) => t.includes("Auto-Escrow Protection"))).toBe(true);
  });

  it("appends client_domain and cosigns valid sequence-0 manageData SEP-10 challenges, while rejecting non-manageData", async () => {
    const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = await import(
      "@stellar/stellar-sdk"
    );
    const clientSigner = Keypair.random();
    const anchorSigner = Keypair.random();
    const userKp = Keypair.random();

    const validChallenge = new TransactionBuilder(new Account(anchorSigner.publicKey(), "-1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageData({
          source: userKp.publicKey(),
          name: "extstellar.moneygram.com auth",
          value: "nonce123",
        }),
      )
      .addOperation(
        Operation.manageData({
          source: clientSigner.publicKey(),
          name: "client_domain",
          value: "astrowallet-soroban.pages.dev",
        }),
      )
      .setTimeout(300)
      .build();
    validChallenge.sign(anchorSigner);

    const maliciousChallenge = new TransactionBuilder(new Account(anchorSigner.publicKey(), "-1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: anchorSigner.publicKey(),
          asset: Asset.native(),
          amount: "10",
        }),
      )
      .setTimeout(300)
      .build();

    let mode: "valid" | "malicious" = "valid";
    let capturedAuthUrl = "";
    const app = createApp({
      fetchFn: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://extstellar.moneygram.com/.well-known/stellar.toml") {
          return new Response(
            [
              'WEB_AUTH_ENDPOINT="https://extstellar.moneygram.com/stellaradapterservice/auth"',
              'TRANSFER_SERVER_SEP0024="https://extstellar.moneygram.com/sep24"',
            ].join("\n"),
            { status: 200 },
          );
        }
        if (url.startsWith("https://extstellar.moneygram.com/stellaradapterservice/auth")) {
          capturedAuthUrl = url;
          return new Response(
            JSON.stringify({
              transaction: mode === "valid" ? validChallenge.toXDR() : maliciousChallenge.toXDR(),
              network_passphrase: Networks.TESTNET,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    const sep10Env = {
      ...TEST_ENV,
      SEP10_CLIENT_DOMAIN: "astrowallet-soroban.pages.dev",
      SEP10_CLIENT_SIGNING_SECRET: clientSigner.secret(),
    };

    const okRes = await app.request(
      `/v1/proxy/sep10/challenge?domain=extstellar.moneygram.com&account=${userKp.publicKey()}`,
      {},
      sep10Env,
    );
    expect(okRes.status).toBe(200);
    expect(capturedAuthUrl).toContain("client_domain=astrowallet-soroban.pages.dev");
    const okJson = (await okRes.json()) as {
      transaction: string;
      client_domain?: string;
      clientDomainSigned?: boolean;
    };
    expect(okJson.client_domain).toBe("astrowallet-soroban.pages.dev");
    expect(okJson.clientDomainSigned).toBe(true);
    const cosigned = TransactionBuilder.fromXDR(okJson.transaction, Networks.TESTNET);
    expect(cosigned.signatures).toHaveLength(2);

    mode = "malicious";
    const badRes = await app.request(
      `/v1/proxy/sep10/challenge?domain=extstellar.moneygram.com&account=${userKp.publicKey()}`,
      {},
      sep10Env,
    );
    expect(badRes.status).toBe(502);
  });
});
