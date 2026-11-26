import type {
  ClaimLink,
  ConnectRequestRecord,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import {
  deriveClaimId,
  signIntentToken,
  signMiniAppSessionToken,
} from "@astrowallet/tg-protocol";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type WorkerBindings } from "./app.js";
import type {
  ServerRepository,
  StoredEncryptedVaultBackup,
  TelegramUserRecord,
} from "./db/repository.js";
import { ChainWatcherDO } from "./durable-objects/chain-watcher.js";
import { ChannelPoolDO } from "./durable-objects/channel-pool.js";
import { verifyConnectAccountSubmissions } from "./routes/connect-verifier.js";
import { resetMemoryRateLimits, clientKeyFromHeaders } from "./rate-limit.js";
import { computeTelegramInitDataHash } from "@astrowallet/tg-protocol";
import { isSafePublicDomain } from "./routes/proxy.js";

const TEST_ENV = {
  STELLAR_NETWORK: "testnet",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URLS: "https://soroban-testnet.stellar.org",
  HORIZON_URLS: "https://horizon-testnet.stellar.org",
  PWA_ORIGIN: "https://testnet.astrowallet.example",
  ALLOWED_ORIGINS: "https://testnet.astrowallet.example",
  FRIENDBOT_URL: "https://friendbot.stellar.org",
  TG_BOT_TOKEN: "test-bot-token",
  TG_WEBHOOK_SECRET: "secret-header-token-1234",
  TG_BOT_USERNAME: "AstroWalletAppBot",
  TG_MINI_APP_SHORT_NAME: "wallet",
  INTENT_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  CLAIM_ESCROW_CONTRACT_ID: "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA",
};

function createD1FaithfulRepo() {
  const users = new Map<string, TelegramUserRecord>();
  const bindings = new Map<string, TelegramUserBinding[]>();
  const intents = new Map<string, SignedIntent>();
  const claims = new Map<string, ClaimLink>();
  const splitPayments = new Map<string, Array<{ payerAddress?: string; txHash: string }>>();
  const usedHashes = new Set<string>();
  const connectRequests = new Map<string, ConnectRequestRecord>();
  const events = new Map<string, number>();
  const verifiedTxs: string[] = [];
  const dedupKeys = new Map<string, number>();
  const relaySpent = new Map<string, bigint>();
  const relayTxCount = new Map<string, number>();

  const repo: ServerRepository = {
    async upsertTelegramUser({ telegramUserId, usernameLower, authoritativeUsername }) {
      const prev = users.get(telegramUserId);
      const nextUsername = authoritativeUsername
        ? usernameLower?.trim().replace(/^@/, "").toLowerCase() || undefined
        : (usernameLower?.trim().replace(/^@/, "").toLowerCase() || prev?.usernameLower);
      const next: TelegramUserRecord = {
        telegramUserId,
        usernameLower: nextUsername,
        alertsEnabled: prev?.alertsEnabled ?? true,
      };
      users.set(telegramUserId, next);
      return next;
    },
    async getUserById(id) {
      return users.get(id) ?? null;
    },
    async getUserByUsername() {
      return null;
    },
    async setUserAlertsEnabled() {},
    async linkVerifiedAddresses({ telegramUserId, accounts }) {
      const next: TelegramUserBinding[] = accounts.map((acc, idx) => ({
        telegramUserId,
        address: acc.address as TelegramUserBinding["address"],
        kind: acc.kind,
        label: acc.label,
        isDefault: Boolean(acc.isDefault ?? idx === 0),
        verifiedAt: Math.floor(Date.now() / 1000),
      }));
      bindings.set(telegramUserId, next);
      return next;
    },
    async listLinkedAddresses(telegramUserId) {
      return bindings.get(telegramUserId) ?? [];
    },
    async setDefaultLinkedAddress() {
      return false;
    },
    async unlinkAddress() {
      return false;
    },
    async unlinkUserAddresses() {
      return 0;
    },
    async isAddressLinked(address) {
      for (const list of bindings.values()) {
        if (list.some((item) => item.address === address)) return true;
      }
      return false;
    },
    async listWatchedAccounts() {
      return [];
    },
    async createSignedIntent(intent) {
      intents.set(intent.intentId, intent);
      return intent;
    },
    async getSignedIntent(id) {
      return intents.get(id) ?? null;
    },
    async attachIntentMessageRef() {},
    async markIntentConfirmed(id, txHash) {
      // Simulate real SQLite UPDATE ... WHERE intent_id = ? AND status IN ('pending', 'signed')
      const prev = intents.get(id);
      if (!prev) return null;
      const transitioned = prev.status === "pending" || prev.status === "signed";
      if (!transitioned) return null;
      const next: SignedIntent = {
        ...prev,
        status: "confirmed",
        txHash: txHash ? txHash.toLowerCase() : prev.txHash,
      };
      if (next.txHash) usedHashes.add(next.txHash);
      intents.set(id, next);
      return next;
    },
    async markIntentStatus(id, status: IntentStatus) {
      const prev = intents.get(id);
      if (!prev) return null;
      const next = { ...prev, status };
      intents.set(id, next);
      return next;
    },
    async createClaimLink(claim) {
      claims.set(claim.claimId, claim);
      return claim;
    },
    async getClaimLink(id) {
      return claims.get(id) ?? null;
    },
    async markClaimLinkStatus(id, status) {
      const prev = claims.get(id);
      if (!prev) return null;
      const next = { ...prev, status };
      claims.set(id, next);
      return next;
    },
    async isTxHashUsed(txHash) {
      return usedHashes.has(txHash.trim().toLowerCase());
    },
    async recordSplitPayment({ intentId, payerAddress, txHash }) {
      const norm = txHash.toLowerCase();
      if (usedHashes.has(norm)) throw new Error("UNIQUE constraint failed: intent_payments.tx_hash");
      usedHashes.add(norm);
      const list = splitPayments.get(intentId) ?? [];
      list.push({ payerAddress, txHash: norm });
      splitPayments.set(intentId, list);
      return { paidCount: list.length };
    },
    async countSplitPayments(intentId) {
      return (splitPayments.get(intentId) ?? []).length;
    },
    async listSplitPaymentTxHashes(intentId) {
      return (splitPayments.get(intentId) ?? []).map((p) => p.txHash);
    },
    async claimAlertDedupKey(key) {
      if (dedupKeys.has(key)) return false;
      dedupKeys.set(key, Math.floor(Date.now() / 1000));
      return true;
    },
    async releaseAlertDedupKey(key) {
      dedupKeys.delete(key);
    },
    async getAlertDedupCreatedAt(key) {
      return dedupKeys.get(key) ?? null;
    },
    async reclaimExpiredAlertDedupKey(key, minAgeSec, nowSec) {
      const createdAt = dedupKeys.get(key);
      if (createdAt === undefined) return false;
      const now = nowSec ?? Math.floor(Date.now() / 1000);
      if (createdAt >= now - minAgeSec) return false;
      dedupKeys.set(key, now);
      return true;
    },
    async findRecentPendingIntent() {
      return null;
    },
    async incrementRateLimit() {
      return { allowed: true, count: 1, retryAfterSeconds: 60 };
    },
    async tryConsumeRelayBudget({ dayUtc, feeStroops, dailyBudgetStroops }) {
      const prev = relaySpent.get(dayUtc) ?? 0n;
      const fee = BigInt(feeStroops);
      const cap = BigInt(dailyBudgetStroops);
      if (prev + fee > cap) {
        return { allowed: false, spentStroops: prev.toString() };
      }
      const next = prev + fee;
      relaySpent.set(dayUtc, next);
      relayTxCount.set(dayUtc, (relayTxCount.get(dayUtc) ?? 0) + 1);
      return { allowed: true, spentStroops: next.toString() };
    },
    async refundRelayBudget({ dayUtc, feeStroops }) {
      const prev = relaySpent.get(dayUtc) ?? 0n;
      const fee = BigInt(feeStroops);
      relaySpent.set(dayUtc, prev > fee ? prev - fee : 0n);
      relayTxCount.set(dayUtc, Math.max(0, (relayTxCount.get(dayUtc) ?? 0) - 1));
    },
    async claimTelegramUpdateId() {
      return true;
    },
    async purgeExpiredRecords() {},
    async upsertEncryptedVaultBackup(): Promise<StoredEncryptedVaultBackup> {
      throw new Error("unused");
    },
    async getEncryptedVaultBackup() {
      return null;
    },
    async deleteEncryptedVaultBackup() {
      return false;
    },
    async createConnectRequest(req) {
      connectRequests.set(req.requestId, req);
      return req;
    },
    async getConnectRequest(id) {
      return connectRequests.get(id) ?? null;
    },
    async completeConnectRequest({ requestId, status, resultJson, responderTelegramUserId, updatedAt }) {
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
    async recordDailyUserActivity() {},
    async incrementProductEvent({ eventType, delta }) {
      events.set(eventType, (events.get(eventType) ?? 0) + (delta ?? 1));
    },
    async recordVerifiedTx({ txHash }) {
      verifiedTxs.push(txHash);
    },
    async getPublicMetricsSnapshot(network) {
      return {
        network,
        totalRegisteredUsers: 0,
        totalLinkedWallets: 0,
        classicWallets: 0,
        smartWallets: 0,
        encryptedVaultBackups: 0,
        confirmedIntents: 0,
        approvedConnectRequests: 0,
        relayTxCount: 0,
        verifiedTxCount: 0,
        dau: 0,
        wau: 0,
        mau: 0,
        dailySeries: [],
        platforms: {},
        eventBreakdown: {},
        recentVerifiedTxs: [],
      };
    },
  };

  return { repo, events, verifiedTxs, relaySpent, relayTxCount };
}

describe("Backend Security, D1 Atomicity, DO Recovery & CSP Proxy Regression (Front 4 & Closure)", () => {
  beforeEach(() => {
    resetMemoryRateLimits();
  });

  it("rejects forged SorobanAuthorizationEntry credentials and non-Classic C... addresses cleanly in /v1/connect/requests/:id/complete", async () => {
    const { repo } = createD1FaithfulRepo();
    const app = createApp({ createRepo: () => repo });
    const contractId = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
    const signer = Keypair.random();

    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signer.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString("42"),
          signatureExpirationLedger: 123456,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contractId).toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const authEntryXdr = authEntry.toXDR("base64");
    const entrySha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authEntryXdr)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");

    const createRes = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_auth_entry",
          app: { name: "Perps", botUsername: "PerpsBot" },
          payload: {
            authEntryXdr,
            entrySha256,
            humanSummary: "Authorize transfer",
          },
        }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { requestId: string; sig: string };

    // 1. Passing C... address must return 400 (never 500 unhandled exception)
    const cAddrRes = await app.request(
      `/v1/connect/requests/${created.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          status: "approved",
          address: contractId,
          signedAuthEntry: authEntryXdr,
        }),
      },
      TEST_ENV,
    );
    expect(cAddrRes.status).toBe(400);

    // 2. Passing unsigned / forged SorobanAuthorizationEntry with empty signature MUST be rejected (400)
    const forgedRes = await app.request(
      `/v1/connect/requests/${created.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          status: "approved",
          address: signer.publicKey(),
          signedAuthEntry: authEntryXdr,
        }),
      },
      TEST_ENV,
    );
    expect(forgedRes.status).toBe(400);
  });

  it("prevents double-confirmation telemetry/tx mismatch on concurrent /v1/intents/:id/confirm", async () => {
    const { repo, events, verifiedTxs } = createD1FaithfulRepo();
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => {
        // Yield a microtask so both requests interleave before DB update
        await new Promise((r) => setTimeout(r, 10));
        return { confirmed: true, ledger: 100 };
      },
    });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = "it_race_confirm";
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

    const creatorToken = await signMiniAppSessionToken(
      {
        telegramUserId: "7001",
        network: "testnet",
        issuedAt: now,
        expiresAt: now + 900,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    const [resA, resB] = await Promise.all([
      app.request(
        `/v1/intents/${intentId}/confirm`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ sig, txHash: "a".repeat(64) }),
        },
        TEST_ENV,
      ),
      app.request(
        `/v1/intents/${intentId}/confirm`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ sig, txHash: "b".repeat(64) }),
        },
        TEST_ENV,
      ),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(events.get("intent_confirmed")).toBe(1);
    expect(verifiedTxs).toHaveLength(1);
  });

  it("reschedules ChainWatcherDO alarm on D1 error and polls all 30 accounts without pagination starvation", async () => {
    const store = new Map<string, unknown>();
    let alarmCount = 0;
    const doState = {
      storage: {
        get: vi.fn(async <T>(k: string) => store.get(k) as T | undefined),
        put: vi.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          store.delete(k);
        }),
        setAlarm: vi.fn(async () => {
          alarmCount += 1;
        }),
      },
    } as unknown as DurableObjectState;

    // 1. Transient D1 error on startup must NOT kill alarm rescheduling
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1_TEMP_UNAVAILABLE");
          },
        }),
        all: async () => {
          throw new Error("D1_TEMP_UNAVAILABLE");
        },
      }),
    };
    const failingEnv = {
      ...TEST_ENV,
      DB: failingDb,
    } as unknown as WorkerBindings;

    const watcherErr = new ChainWatcherDO(doState, failingEnv);
    await watcherErr.alarm().catch(() => {});
    expect(alarmCount).toBe(1);

    // 2. 30 accounts (2 full pages of 15): wrap-around must set nextOffset = 15, NOT 45
    const accounts30 = Array.from({ length: 30 }, (_, i) => ({
      telegram_user_id: String(1000 + i),
      address: Keypair.random().publicKey(),
      label: `acc-${i}`,
    }));
    const polledAddresses = new Set<string>();

    const pagingDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => {
            if (sql.includes("LIMIT ? OFFSET ?")) {
              const limit = Number(args[0]);
              const offset = Number(args[1]);
              return { results: accounts30.slice(offset, offset + limit) };
            }
            return { results: [] };
          },
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const match = /\/accounts\/(G[A-Z2-7]{55})\/payments/.exec(url);
      if (match?.[1]) {
        polledAddresses.add(match[1]);
      }
      return new Response(
        JSON.stringify({ _embedded: { records: [{ paging_token: "100-1" }] } }),
        { status: 200 },
      );
    });

    try {
      store.clear();
      const watcher = new ChainWatcherDO(doState, {
        ...TEST_ENV,
        DB: pagingDb,
      } as unknown as WorkerBindings);
      // Run 4 alarm cycles: 0..14, 15..29, wrap->0..14, 15..29
      await watcher.alarm();
      await watcher.alarm();
      await watcher.alarm();
      expect(store.get("batch_offset")).toBe(15);
      expect(polledAddresses.size).toBe(30);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("enforces case-insensitive isSafePublicDomain, proxies TON manifests safely, and validates SEP-24 amount > 0", async () => {
    expect(isSafePublicDomain("evil.INTERNAL")).toBe(false);

    const { repo } = createD1FaithfulRepo();
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://dapp.example.org/tonconnect-manifest.json") {
          return new Response(
            JSON.stringify({ name: "My TON dApp", url: "https://dapp.example.org" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://huge.example.org/tonconnect-manifest.json") {
          return new Response("x".repeat(70_000), { status: 200 });
        }
        if (url === "https://cdn.example.org/custom.toml") {
          return new Response('code="USDC"\n', { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const okManifest = await app.request(
      `/v1/proxy/ton-manifest?url=${encodeURIComponent("https://dapp.example.org/tonconnect-manifest.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(okManifest.status).toBe(200);
    expect(await okManifest.json()).toMatchObject({
      name: "My TON dApp",
      url: "https://dapp.example.org",
    });

    const ssrfManifest = await app.request(
      `/v1/proxy/ton-manifest?url=${encodeURIComponent("https://127.0.0.1:8080/manifest.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(ssrfManifest.status).toBe(400);

    const hugeManifest = await app.request(
      `/v1/proxy/ton-manifest?url=${encodeURIComponent("https://huge.example.org/tonconnect-manifest.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(hugeManifest.status).toBe(413);

    const linkedToml = await app.request(
      `/v1/proxy/stellar-toml?url=${encodeURIComponent("https://cdn.example.org/custom.toml")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(linkedToml.status).toBe(200);
    expect(await linkedToml.text()).toContain('code="USDC"');

    const sepAuthToken = await signMiniAppSessionToken(
      {
        telegramUserId: "888222",
        network: "testnet",
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    const unauthSep24 = await app.request(
      "/v1/proxy/sep24/interactive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "extstellar.moneygram.com",
          direction: "deposit",
          token: "a".repeat(20),
          assetCode: "USDC",
          amount: "10",
        }),
      },
      TEST_ENV,
    );
    expect(unauthSep24.status).toBe(401);

    const zeroSep24 = await app.request(
      "/v1/proxy/sep24/interactive",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sepAuthToken}`,
        },
        body: JSON.stringify({
          domain: "extstellar.moneygram.com",
          direction: "deposit",
          token: "a".repeat(20),
          assetCode: "USDC",
          amount: "0",
        }),
      },
      TEST_ENV,
    );
    expect(zeroSep24.status).toBe(400);
  });

  it("keeps expired funded claim links readable (200) while returning 410 for expired pending intents", async () => {
    const { repo } = createD1FaithfulRepo();
    const now = Math.floor(Date.now() / 1000);
    const expiredAt = now - 600;
    const fundedSig = await signIntentToken(
      {
        intentId: "int_claim_funded",
        network: "testnet",
        telegramUserId: "111",
        expiresAt: expiredAt,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    const pendingSig = await signIntentToken(
      {
        intentId: "int_claim_pending",
        network: "testnet",
        telegramUserId: "111",
        expiresAt: expiredAt,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    await repo.createSignedIntent({
      intentId: "int_claim_funded",
      network: "testnet",
      actionType: "claim",
      creatorTelegramUserId: "111",
      creatorUsername: "alice",
      payloadJson: JSON.stringify({ amount: "10", assetCode: "XLM", to: "anyone" }),
      signatureHex: fundedSig,
      status: "signed",
      expiresAt: expiredAt,
      createdAt: expiredAt - 3600,
    });
    await repo.createSignedIntent({
      intentId: "int_claim_pending",
      network: "testnet",
      actionType: "claim",
      creatorTelegramUserId: "111",
      creatorUsername: "alice",
      payloadJson: JSON.stringify({ amount: "10", assetCode: "XLM", to: "anyone" }),
      signatureHex: pendingSig,
      status: "pending",
      expiresAt: expiredAt,
      createdAt: expiredAt - 3600,
    });

    const app = createApp({ createRepo: () => repo });

    const fundedRes = await app.request(
      `/v1/intents/int_claim_funded?sig=${fundedSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(fundedRes.status).toBe(200);
    const fundedJson = (await fundedRes.json()) as { status: string; intentId: string };
    expect(fundedJson.intentId).toBe("int_claim_funded");
    expect(fundedJson.status).toBe("signed");

    const pendingRes = await app.request(
      `/v1/intents/int_claim_pending?sig=${pendingSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(pendingRes.status).toBe(410);
  });

  it("blocks SSRF on POST /v1/proxy/x402-probe and forwards only x402 payment headers", async () => {
    const { repo } = createD1FaithfulRepo();
    let seenHeaders: Headers | null = null;
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: "alpha" }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": "x402-terms",
            "PAYMENT-RESPONSE": "receipt-ok",
          },
        });
      },
    });

    const probeToken = await signMiniAppSessionToken(
      {
        telegramUserId: "888333",
        network: "testnet",
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    const unauthProbe = await app.request(
      "/v1/proxy/x402-probe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://astrodex-testnet.pages.dev/v1/agent/forensic-alpha/XLM" }),
      },
      TEST_ENV,
    );
    expect(unauthProbe.status).toBe(401);

    for (const badUrl of [
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "http://api.example.org/x402",
      "https://user:pass@api.example.org/x402",
    ]) {
      const badRes = await app.request(
        "/v1/proxy/x402-probe",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${probeToken}`,
          },
          body: JSON.stringify({ url: badUrl }),
        },
        TEST_ENV,
      );
      expect(badRes.status).toBe(400);
    }

    const okRes = await app.request(
      "/v1/proxy/x402-probe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${probeToken}`,
        },
        body: JSON.stringify({
          url: "https://astrodex-testnet.pages.dev/v1/agent/forensic-alpha/XLM",
          headers: {
            "PAYMENT-SIGNATURE": "sig-v2",
            "X-PAYMENT": "sig-v1",
            Authorization: "Bearer evil-leak",
            Cookie: "session=evil",
          },
        }),
      },
      TEST_ENV,
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as {
      status: number;
      hostname: string;
      paymentRequired: string | null;
      paymentResponse: string | null;
      bodyPreview: string;
    };
    expect(body.status).toBe(402);
    expect(body.hostname).toBe("astrodex-testnet.pages.dev");
    expect(body.paymentRequired).toBe("x402-terms");
    expect(body.paymentResponse).toBe("receipt-ok");
    expect(body.bodyPreview).toContain("alpha");
    expect(seenHeaders).not.toBeNull();
    expect(seenHeaders!.get("PAYMENT-SIGNATURE")).toBe("sig-v2");
    expect(seenHeaders!.get("X-PAYMENT")).toBe("sig-v1");
    expect(seenHeaders!.get("Authorization")).toBeNull();
    expect(seenHeaders!.get("Cookie")).toBeNull();
  });

  it("omits client_domain from SEP-10 challenge when SEP10_CLIENT_SIGNING_SECRET is missing", async () => {
    const { repo } = createD1FaithfulRepo();
    let requestedChallengeUrl = "";
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/.well-known/stellar.toml")) {
          return new Response(
            'WEB_AUTH_ENDPOINT="https://anchor.example.org/auth"\nTRANSFER_SERVER_SEP0024="https://anchor.example.org/sep24"\n',
            { status: 200 },
          );
        }
        if (url.startsWith("https://anchor.example.org/auth")) {
          requestedChallengeUrl = url;
          return new Response(
            JSON.stringify({
              transaction: "AAAAAg==",
              network_passphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    const sep10Token = await signMiniAppSessionToken(
      {
        telegramUserId: "888444",
        network: "testnet",
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    const kp = Keypair.random();
    const unauthChallenge = await app.request(
      `/v1/proxy/sep10/challenge?domain=anchor.example.org&account=${kp.publicKey()}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(unauthChallenge.status).toBe(401);

    const res = await app.request(
      `/v1/proxy/sep10/challenge?domain=anchor.example.org&account=${kp.publicKey()}`,
      { method: "GET", headers: { Authorization: `Bearer ${sep10Token}` } },
      {
        ...TEST_ENV,
        SEP10_CLIENT_DOMAIN: "astro-wallet.pages.dev",
      },
    );
    expect(res.status).toBe(200);
    expect(requestedChallengeUrl).toContain(`account=${kp.publicKey()}`);
    expect(requestedChallengeUrl).not.toContain("client_domain=");
  });

  it("enforces Red Team relay feebump guards (no nested FeeBump, only refund_expired on expired signed claim) and normalizes SEP-40 lowercase assets", async () => {
    const { repo } = createD1FaithfulRepo();
    const now = Math.floor(Date.now() / 1000);
    const expiredAt = now - 300;
    const escrowId = TEST_ENV.CLAIM_ESCROW_CONTRACT_ID;
    const relayEnv = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.example.org/testnet",
      RELAY_ALLOWED_CONTRACTS: escrowId,
      REDSTONE_ORACLE_CONTRACT_ID: escrowId,
    };

    const expiredSig = await signIntentToken(
      {
        intentId: "int_relay_expired_claim",
        network: "testnet",
        telegramUserId: "222",
        expiresAt: expiredAt,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "int_relay_expired_claim",
      network: "testnet",
      actionType: "claim",
      creatorTelegramUserId: "222",
      creatorUsername: "bob",
      payloadJson: JSON.stringify({ amount: "5", assetCode: "XLM", to: "anyone" }),
      signatureHex: expiredSig,
      status: "signed",
      expiresAt: expiredAt,
      createdAt: expiredAt - 3600,
    });

    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "100");
    const escrowContract = new Contract(escrowId);
    const claimIdHex = await deriveClaimId("int_relay_expired_claim");
    const claimIdBytes = Buffer.from(claimIdHex, "hex");
    const sigBytes = new Uint8Array(64).fill(2);

    const claimTx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        escrowContract.call(
          "claim",
          nativeToScVal(claimIdBytes, { type: "bytes" }),
          new Address(kp.publicKey()).toScVal(),
          nativeToScVal(sigBytes, { type: "bytes" }),
        ),
      )
      .setTimeout(60)
      .build();
    claimTx.sign(kp);

    const nestedFeeBump = TransactionBuilder.buildFeeBumpTransaction(
      kp.publicKey(),
      "200",
      claimTx,
      TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    );
    nestedFeeBump.sign(kp);

    const refundTx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        escrowContract.call(
          "refund_expired",
          nativeToScVal(claimIdBytes, { type: "bytes" }),
        ),
      )
      .setTimeout(60)
      .build();
    refundTx.sign(kp);

    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url === relayEnv.OZ_CHANNELS_API_URL) {
          return new Response(
            JSON.stringify({ hash: "a".repeat(64), status: "submitted" }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    // 1. Nested FeeBump rejected with 400
    const nestedRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: nestedFeeBump.toXDR(),
          intentAuth: { intentId: "int_relay_expired_claim", sig: expiredSig },
        }),
      },
      relayEnv,
    );
    expect(nestedRes.status).toBe(400);

    // 2. Expired signed claim intent rejects `claim` with 403
    const claimAfterExpiryRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: claimTx.toXDR(),
          intentAuth: { intentId: "int_relay_expired_claim", sig: expiredSig },
        }),
      },
      relayEnv,
    );
    expect(claimAfterExpiryRes.status).toBe(403);

    // 3. Expired signed claim intent allows `refund_expired` (200)
    const refundAfterExpiryRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: refundTx.toXDR(),
          intentAuth: { intentId: "int_relay_expired_claim", sig: expiredSig },
        }),
      },
      relayEnv,
    );
    expect(refundAfterExpiryRes.status).toBe(200);

    // 4. Lowercase ?assets=btc normalizes to Asset::Other("BTC") in SEP-40 oracle lookup
    const seenOracleSymbols: string[] = [];
    const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpcReq = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
        params?: { transaction?: string };
      };
      if (rpcReq.method === "simulateTransaction" && rpcReq.params?.transaction) {
        const tx = TransactionBuilder.fromXDR(
          rpcReq.params.transaction,
          TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
        );
        const op = tx.operations[0] as unknown as {
          func?: xdr.HostFunction;
        };
        const invoke = op?.func?.invokeContract;
        const fnName = invoke?.functionName?.toString();
        if (fnName === "decimals") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcReq.id,
              result: {
                latestLedger: 123,
                results: [{ xdr: nativeToScVal(8, { type: "u32" }).toXDR("base64") }],
              },
            }),
            { status: 200 },
          );
        }
        if (fnName === "lastprice" && invoke?.args[0]) {
          const nativeArg = scValToNative(invoke.args[0]) as unknown;
          if (
            Array.isArray(nativeArg) &&
            nativeArg[0] === "Other" &&
            typeof nativeArg[1] === "string"
          ) {
            seenOracleSymbols.push(nativeArg[1]);
          }
          const priceMap = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("price"),
              val: nativeToScVal(9_500_000_000_000n, { type: "i128" }),
            }),
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("timestamp"),
              val: nativeToScVal(BigInt(now - 60), { type: "u64" }),
            }),
          ]);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcReq.id,
              result: {
                latestLedger: 124,
                results: [{ xdr: priceMap.toXDR("base64") }],
              },
            }),
            { status: 200 },
          );
        }
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const oracleRes = await app.request(
        "/v1/proxy/oracle/prices?assets=btc",
        { method: "GET" },
        relayEnv,
      );
      expect(oracleRes.status).toBe(200);
      const oracleJson = (await oracleRes.json()) as {
        prices: Record<string, { stale?: boolean; priceUsd?: number }>;
      };
      expect(seenOracleSymbols).toContain("BTC");
      expect(oracleJson.prices.BTC?.priceUsd).toBeGreaterThan(0);
      expect(oracleJson.prices.BTC?.stale).toBe(false);
    } finally {
      rpcSpy.mockRestore();
    }
  });

  it("proxies SEP-50 off-chain metadata safely, blocks SSRF URLs, and emits security/no-store headers", async () => {
    const { repo } = createD1FaithfulRepo();
    const fetchedUrls: string[] = [];
    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url === "https://cdn.example.org/token/42.json") {
          return new Response(
            JSON.stringify({
              name: "Sorobit #42",
              description: "Verified navigator",
              image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/42.svg",
              attributes: [{ trait_type: "Tier", value: "Gold" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/9.json") {
          return new Response(
            JSON.stringify({
              name: "IPFS Collectible #9",
              image: "https://cdn.example.org/art/9.png",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const healthRes = await app.request("/health", { method: "GET" }, TEST_ENV);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(healthRes.headers.get("Referrer-Policy")).toBe("no-referrer");

    const tgMeRes = await app.request("/v1/tg/me", { method: "GET" }, TEST_ENV);
    expect(tgMeRes.status).toBe(401);
    expect(tgMeRes.headers.get("Cache-Control")).toBe("no-store");

    for (const badUrl of [
      "http://127.0.0.1/meta.json",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/secret.json",
      "https://localhost/meta.json",
    ]) {
      const badRes = await app.request(
        `/v1/proxy/sep50-meta?url=${encodeURIComponent(badUrl)}`,
        { method: "GET" },
        TEST_ENV,
      );
      expect(badRes.status).toBe(400);
    }
    expect(fetchedUrls).toHaveLength(0);

    const okHttps = await app.request(
      `/v1/proxy/sep50-meta?url=${encodeURIComponent("https://cdn.example.org/token/42.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(okHttps.status).toBe(200);
    const httpsJson = (await okHttps.json()) as {
      name?: string;
      description?: string;
      image?: string;
      attributes?: Array<{ trait_type: string; value: string }>;
    };
    expect(httpsJson.name).toBe("Sorobit #42");
    expect(httpsJson.image).toBe(
      "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/42.svg",
    );
    expect(httpsJson.attributes).toEqual([{ trait_type: "Tier", value: "Gold" }]);

    const okIpfs = await app.request(
      `/v1/proxy/sep50-meta?url=${encodeURIComponent("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/9.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(okIpfs.status).toBe(200);
    const ipfsJson = (await okIpfs.json()) as { name?: string; image?: string };
    expect(ipfsJson.name).toBe("IPFS Collectible #9");
    expect(ipfsJson.image).toBe("https://cdn.example.org/art/9.png");
  });

  it("enforces Red Team Audit #2 defenses: relay budget refund, Soroban upgrade block, bootstrap dedup-before-budget, non-Soroban HashIdPreimage block, SVG XSS filter, and trusted CF-Connecting-IP", async () => {
    // 1. clientKeyFromHeaders ignores spoofed X-Forwarded-For
    expect(
      clientKeyFromHeaders(new Headers({ "X-Forwarded-For": "1.2.3.4" })),
    ).toBe("anonymous");
    expect(
      clientKeyFromHeaders(
        new Headers({ "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "1.2.3.4" }),
      ),
    ).toBe("203.0.113.5");

    const { repo, relaySpent, relayTxCount } = createD1FaithfulRepo();
    const now = Math.floor(Date.now() / 1000);
    const escrowId = TEST_ENV.CLAIM_ESCROW_CONTRACT_ID;
    const relayEnv = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.example.org/testnet",
      RELAY_ALLOWED_CONTRACTS: escrowId,
      RELAY_DAILY_BUDGET_STROOPS: "2000000",
      RELAY_MAX_FEE_STROOPS: "1000000",
    };

    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "100");
    const escrowContract = new Contract(escrowId);
    const claimIdBytes = Buffer.from(await deriveClaimId("it_audit2_relay"), "hex");
    const sigBytes = new Uint8Array(64).fill(6);

    const claimTx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        escrowContract.call(
          "claim",
          nativeToScVal(claimIdBytes, { type: "bytes" }),
          new Address(kp.publicKey()).toScVal(),
          nativeToScVal(sigBytes, { type: "bytes" }),
        ),
      )
      .setTimeout(60)
      .build();
    claimTx.sign(kp);

    const dangerousHostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(escrowId).toScAddress(),
        functionName: "upgrade",
        args: [],
      }),
    );

    const intentId = "it_audit2_relay";
    const intentSig = await signIntentToken(
      { intentId, network: "testnet", telegramUserId: "999111", expiresAt: now + 300 },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId,
      network: "testnet",
      creatorTelegramUserId: "999111",
      actionType: "claim",
      payloadJson: JSON.stringify({ amount: "10", assetCode: "XLM" }),
      hmacSig: intentSig,
      status: "signed",
      expiresAt: now + 300,
      createdAt: now,
    });

    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url === relayEnv.OZ_CHANNELS_API_URL) {
          return new Response("upstream error", { status: 500 });
        }
        if (url === "https://evil-svg.example.org/meta.json") {
          const xssSvg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script/xlink:href="https://evil.com/x.js"/></svg>',
            "utf8",
          ).toString("base64");
          return new Response(
            JSON.stringify({
              name: "Evil Art",
              image: `data:image/svg+xml;base64,${xssSvg}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes(`/accounts/${kp.publicKey()}`)) {
          return new Response(JSON.stringify({ sequence: "1" }), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // 2. Upstream 500 from OZ Channels refunds relay_daily_usage
    const failedRelay = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: claimTx.toXDR(),
          intentAuth: { intentId, sig: intentSig },
        }),
      },
      relayEnv,
    );
    expect(failedRelay.status).toBe(502);
    const dayUtc = new Date(now * 1000).toISOString().slice(0, 10);
    expect(relaySpent.get(dayUtc) ?? 0n).toBe(0n);
    expect(relayTxCount.get(dayUtc) ?? 0).toBe(0);

    // 3. mode="soroban" blocks dangerous functions like upgrade()
    const dangerousSorobanRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: dangerousHostFn.toXDR("base64"),
          intentAuth: { intentId, sig: intentSig },
        }),
      },
      relayEnv,
    );
    expect(dangerousSorobanRes.status).toBe(403);

    // 4. Repeated 409 /v1/relay/bootstrap requests do NOT consume daily bootstrap budget
    const sponsorKp = Keypair.random();
    const bootEnv = { ...TEST_ENV, RELAY_SPONSOR_SECRET: sponsorKp.secret() };
    const initPairs: Array<[string, string]> = [
      ["auth_date", String(now - 2)],
      ["user", JSON.stringify({ id: 999222, username: "boot_tester" })],
    ];
    initPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const initHash = await computeTelegramInitDataHash(
      initPairs.map(([k, v]) => `${k}=${v}`).join("\n"),
      TEST_ENV.TG_BOT_TOKEN,
    );
    const initParams = new URLSearchParams(Object.fromEntries(initPairs));
    initParams.set("hash", initHash);
    const tgAuthRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initParams.toString() }),
      },
      TEST_ENV,
    );
    const { sessionToken } = (await tgAuthRes.json()) as { sessionToken: string };
    const newBootKp = Keypair.random();
    const makeBootSig = async (targetKp: Keypair, nonce: string) => {
      const msg = `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${targetKp.publicKey()}:${now}:${nonce}`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${msg}`),
      );
      return Buffer.from(targetKp.sign(Buffer.from(digest))).toString("base64");
    };

    // Unfunded user fails at sponsor sequence lookup (Horizon returns 404 for sponsor) -> 502 + refund
    const failBoot = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          address: newBootKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "boot_nonce_01",
          signatureBase64: await makeBootSig(newBootKp, "boot_nonce_01"),
        }),
      },
      bootEnv,
    );
    expect(failBoot.status).toBe(502);
    expect(relaySpent.get(`bootstrap:${dayUtc}`) ?? 0n).toBe(0n);

    // 5. /v1/connect/requests/:id/complete rejects non-Soroban HashIdPreimage (envelopeTypeOpId)
    const opIdPreimage = xdr.HashIdPreimage.envelopeTypeOpId(
      new xdr.HashIdPreimageOperationId({
        sourceAccount: xdr.AccountId.publicKeyTypeEd25519(kp.rawPublicKey()),
        seqNum: 1n,
        opNum: 0,
      }),
    );
    const opIdXdr = opIdPreimage.toXDR("base64");
    const opIdHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opIdXdr))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const createAuthEntry = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_auth_entry",
          app: { name: "Evil", botUsername: "EvilTestBot" },
          payload: { authEntryXdr: opIdXdr, entrySha256: opIdHash },
        }),
      },
      TEST_ENV,
    );
    const createdReq = (await createAuthEntry.json()) as { requestId: string; sig: string };
    const opDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(opIdPreimage.toXDR())),
    );
    const opSig = Buffer.from(kp.sign(Buffer.from(opDigest))).toString("base64");
    const rejectNonSorobanPreimage = await app.request(
      `/v1/connect/requests/${createdReq.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: createdReq.sig,
          status: "approved",
          address: kp.publicKey(),
          signedAuthEntry: opSig,
        }),
      },
      TEST_ENV,
    );
    expect(rejectNonSorobanPreimage.status).toBe(400);

    // 6. /v1/proxy/sep50-meta strips malicious SVG image from JSON metadata
    const svgMetaRes = await app.request(
      `/v1/proxy/sep50-meta?url=${encodeURIComponent("https://evil-svg.example.org/meta.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(svgMetaRes.status).toBe(200);
    const svgMetaJson = (await svgMetaRes.json()) as { name?: string; image?: string };
    expect(svgMetaJson.name).toBe("Evil Art");
    expect(svgMetaJson.image).toBeUndefined();
  });

  it("enforces Carbon Block 1 defenses across bootstrap, relay auth/allowlist/fees, ChannelPoolDO persistence, and Smart Account linking", async () => {
    const { repo, relaySpent, relayTxCount } = createD1FaithfulRepo();
    const now = Math.floor(Date.now() / 1000);
    const escrowId = TEST_ENV.CLAIM_ESCROW_CONTRACT_ID;
    const otherContractId = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const sponsorKp = Keypair.random();
    const linkedKp = Keypair.random();
    const unlinkedKp = Keypair.random();
    const bootTargetKp = Keypair.random();
    const otherBootKp = Keypair.random();

    await repo.linkVerifiedAddresses({
      telegramUserId: "777001",
      accounts: [
        {
          address: linkedKp.publicKey(),
          kind: "classic",
          label: "Linked",
          isDefault: true,
          verifiedSigHash: "sig_linked",
        },
      ],
    });

    const signSep53 = async (kp: Keypair, msg: string) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${msg}`),
      );
      return Buffer.from(kp.sign(Buffer.from(digest))).toString("base64");
    };

    const sha256HexLocal = async (input: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");

    const signWalletAuth = async (
      kp: Keypair,
      mode: "soroban" | "feebump",
      payload: string,
      nonce: string,
    ) => {
      const payloadHash = await sha256HexLocal(payload);
      const msg = `astrowallet-relay:v1:testnet:${mode}:${payloadHash}:${now}:${nonce}`;
      return {
        address: kp.publicKey(),
        timestamp: now,
        nonce,
        payloadHash,
        signatureBase64: await signSep53(kp, msg),
      };
    };

    // Mock Durable Object storage for ChannelPoolDO restart persistence test
    const doStorageMap = new Map<string, unknown>();
    const mockDoState = {
      storage: {
        get: async <T>(key: string) => doStorageMap.get(key) as T | undefined,
        put: async <T>(key: string, val: T) => {
          doStorageMap.set(key, val);
        },
      },
    } as unknown as DurableObjectState;
    const poolA = new ChannelPoolDO(mockDoState, {});
    const channel1 = Keypair.random().publicKey();
    const channel2 = Keypair.random().publicKey();

    let upstreamBehavior: "ok" | "bad_seq" | "timeout" = "ok";
    let upstreamCalls = 0;

    const app = createApp({
      createRepo: () => repo,
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://channels.example.org/testnet") {
          upstreamCalls += 1;
          if (upstreamBehavior === "bad_seq") {
            return new Response(JSON.stringify({ error: "tx_bad_seq" }), { status: 400 });
          }
          if (upstreamBehavior === "timeout") {
            throw new Error("The operation timed out");
          }
          return new Response(
            JSON.stringify({ hash: "f".repeat(64), status: "submitted" }),
            { status: 200 },
          );
        }
        if (url.includes(`/accounts/${sponsorKp.publicKey()}`)) {
          return new Response(JSON.stringify({ sequence: "500" }), { status: 200 });
        }
        if (
          url.includes(`/accounts/${bootTargetKp.publicKey()}`) ||
          url.includes(`/accounts/${otherBootKp.publicKey()}`)
        ) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const relayEnv = {
      ...TEST_ENV,
      OZ_CHANNELS_API_URL: "https://channels.example.org/testnet",
      RELAY_ALLOWED_CONTRACTS: escrowId,
      RELAY_SPONSOR_SECRET: sponsorKp.secret(),
      RELAY_CHANNEL_ACCOUNTS: `${channel1},${channel2}`,
      CHANNEL_POOL: {
        idFromName: (name: string) => name as never,
        get: () => poolA as never,
      },
    };

    // --- HALLAZGO-01: bootstrap mode binding, direct flag block, and >180s retry recovery ---
    const initPairs: Array<[string, string]> = [
      ["auth_date", String(now - 2)],
      ["user", JSON.stringify({ id: 777001, username: "carbon_user" })],
    ];
    initPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const initHash = await computeTelegramInitDataHash(
      initPairs.map(([k, v]) => `${k}=${v}`).join("\n"),
      TEST_ENV.TG_BOT_TOKEN,
    );
    const initParams = new URLSearchParams(Object.fromEntries(initPairs));
    initParams.set("hash", initHash);
    const tgAuthRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initParams.toString() }),
      },
      TEST_ENV,
    );
    const { sessionToken } = (await tgAuthRes.json()) as { sessionToken: string };

    // 1a. direct mode blocked when RELAY_ALLOW_DIRECT_BOOTSTRAP is false/unset
    const directBlocked = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          address: bootTargetKp.publicKey(),
          mode: "direct",
          timestamp: now,
          nonce: "boot_direct_1",
          signatureBase64: await signSep53(
            bootTargetKp,
            `astrowallet-bootstrap:v1:testnet:direct:${bootTargetKp.publicKey()}:${now}:boot_direct_1`,
          ),
        }),
      },
      relayEnv,
    );
    expect(directBlocked.status).toBe(403);

    // 1b. mode downgrade even when RELAY_ALLOW_DIRECT_BOOTSTRAP=true fails signature check -> 403
    const downgradeBlocked = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          address: bootTargetKp.publicKey(),
          mode: "direct",
          timestamp: now,
          nonce: "boot_downgrade_1",
          signatureBase64: await signSep53(
            bootTargetKp,
            `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${bootTargetKp.publicKey()}:${now}:boot_downgrade_1`,
          ),
        }),
      },
      { ...relayEnv, RELAY_ALLOW_DIRECT_BOOTSTRAP: "true" } as never,
    );
    expect(downgradeBlocked.status).toBe(403);

    // 1c. Valid sponsored_reserve succeeds, immediate retry -> 409, retry >180s for same (tg, addr) -> 200 without extra budget
    const bootOk = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          address: bootTargetKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "boot_ok_01",
          signatureBase64: await signSep53(
            bootTargetKp,
            `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${bootTargetKp.publicKey()}:${now}:boot_ok_01`,
          ),
        }),
      },
      relayEnv,
    );
    expect(bootOk.status).toBe(200);
    const dayUtc = new Date(now * 1000).toISOString().slice(0, 10);
    expect(relaySpent.get(`bootstrap:${dayUtc}`)).toBe(100_000n);

    // Different address for same Telegram user must stay 409 even after >180s
    const diffAddrBoot = await app.request(
      "/v1/relay/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          address: otherBootKp.publicKey(),
          mode: "sponsored_reserve",
          timestamp: now,
          nonce: "boot_diff_01",
          signatureBase64: await signSep53(
            otherBootKp,
            `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${otherBootKp.publicKey()}:${now}:boot_diff_01`,
          ),
        }),
      },
      relayEnv,
    );
    expect(diffAddrBoot.status).toBe(409);

    // Simulate >180s expiry by aging pairDedupKey via reclaim test: fast-forward createdAt by mutating date via spy
    const pairKey = `bootstrap:pair:testnet:777001:${bootTargetKp.publicKey()}`;
    expect(await repo.getAlertDedupCreatedAt?.(pairKey)).not.toBeNull();
    // Force pair key timestamp older than 180s by calling release+claim with older time via spy on Date.now
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue((now + 200) * 1000);
    try {
      // Wait for 10s sponsor lease from bootOk to expire at now+200
      const retryTs = now + 200;
      const retryBoot = await app.request(
        "/v1/relay/bootstrap",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({
            address: bootTargetKp.publicKey(),
            mode: "sponsored_reserve",
            timestamp: retryTs,
            nonce: "boot_retry_180",
            signatureBase64: await signSep53(
              bootTargetKp,
              `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${bootTargetKp.publicKey()}:${retryTs}:boot_retry_180`,
            ),
          }),
        },
        relayEnv,
      );
      expect(retryBoot.status).toBe(200);
      // Budget was NOT consumed twice
      expect(relaySpent.get(`bootstrap:${dayUtc}`)).toBe(100_000n);
    } finally {
      dateNowSpy.mockRestore();
    }

    // --- HALLAZGO-02: sourceAccount match, no Classic ops in feebump, authEntriesXdrBase64 binding & allowlist ---
    const unlinkedTx = new TransactionBuilder(new Account(unlinkedKp.publicKey(), "100"), {
      fee: BASE_FEE,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(escrowId).call(
          "get_escrowed_balance",
          new Address(unlinkedKp.publicKey()).toScVal(),
        ),
      )
      .setTimeout(60)
      .build()
      .toXDR();
    const mismatchSourceRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: unlinkedTx,
          walletAuth: await signWalletAuth(linkedKp, "feebump", unlinkedTx, "nonce_src_1"),
        }),
      },
      relayEnv,
    );
    expect(mismatchSourceRes.status).toBe(403);

    const { Operation } = await import("@stellar/stellar-sdk");
    const classicOpTx = new TransactionBuilder(new Account(linkedKp.publicKey(), "100"), {
      fee: BASE_FEE,
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.manageData({ name: "spam", value: "1" }))
      .setTimeout(60)
      .build()
      .toXDR();
    const classicBlockedRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: classicOpTx,
          walletAuth: await signWalletAuth(linkedKp, "feebump", classicOpTx, "nonce_cls_1"),
        }),
      },
      relayEnv,
    );
    expect(classicBlockedRes.status).toBe(403);

    // Soroban mode: mutating authEntriesXdrBase64 invalidates walletAuth; HashIdPreimage rejected (400); unlisted sub-contract rejected (403)
    const validFuncXdr = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(escrowId).toScAddress(),
        functionName: "get_escrowed_balance",
        args: [new Address(linkedKp.publicKey()).toScVal()],
      }),
    ).toXDR("base64");
    const makeAuthEntryXdr = (targetContract: string) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(targetContract).toScAddress(),
              functionName: "get_escrowed_balance",
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      }).toXDR("base64");

    const allowedAuthEntry = makeAuthEntryXdr(escrowId);
    const unlistedAuthEntry = makeAuthEntryXdr(otherContractId);
    const mutatedAuthRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: validFuncXdr,
          authEntriesXdrBase64: [allowedAuthEntry],
          // Signed WITHOUT authEntriesXdrBase64 -> must fail 403
          walletAuth: await signWalletAuth(linkedKp, "soroban", validFuncXdr, "nonce_auth_mut"),
        }),
      },
      relayEnv,
    );
    expect(mutatedAuthRes.status).toBe(403);

    const unlistedAuthPayload = [validFuncXdr, unlistedAuthEntry].join(":");
    const unlistedAuthRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: validFuncXdr,
          authEntriesXdrBase64: [unlistedAuthEntry],
          walletAuth: await signWalletAuth(
            linkedKp,
            "soroban",
            unlistedAuthPayload,
            "nonce_auth_unlisted",
          ),
        }),
      },
      relayEnv,
    );
    expect(unlistedAuthRes.status).toBe(403);

    // --- HALLAZGO-03: walletAuth fallback when intentAuth stage is already consumed & claim_id binding ---
    const claimIntentId = "it_carbon_claim_01";
    const claimSig = await signIntentToken(
      { intentId: claimIntentId, network: "testnet", telegramUserId: "777001", expiresAt: now + 300 },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: claimIntentId,
      network: "testnet",
      creatorTelegramUserId: "777001",
      actionType: "claim",
      payloadJson: JSON.stringify({ amount: "10", assetCode: "XLM" }),
      hmacSig: claimSig,
      status: "signed",
      expiresAt: now + 300,
      createdAt: now,
    });
    const expectedClaimIdBytes = Buffer.from(await deriveClaimId(claimIntentId), "hex");
    const wrongClaimIdBytes = Buffer.alloc(32, 0x99);
    const buildClaimCallTx = (fn: string, cid: Buffer) =>
      new TransactionBuilder(new Account(linkedKp.publicKey(), "100"), {
        fee: BASE_FEE,
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
      })
        .addOperation(
          new Contract(escrowId).call(
            fn,
            nativeToScVal(cid, { type: "bytes" }),
            ...(fn === "claim"
              ? [
                  new Address(linkedKp.publicKey()).toScVal(),
                  nativeToScVal(new Uint8Array(64).fill(1), { type: "bytes" }),
                ]
              : []),
          ),
        )
        .setTimeout(60)
        .build()
        .toXDR();

    // Wrong claimId with intentAuth alone -> 403
    const wrongClaimRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: buildClaimCallTx("claim", wrongClaimIdBytes),
          intentAuth: { intentId: claimIntentId, sig: claimSig },
        }),
      },
      relayEnv,
    );
    expect(wrongClaimRes.status).toBe(403);

    // Consume intentAuth stage key, then submit again with BOTH consumed intentAuth AND valid walletAuth -> 200
    const goodClaimTx = buildClaimCallTx("claim", expectedClaimIdBytes);
    const firstIntentClaim = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: goodClaimTx,
          intentAuth: { intentId: claimIntentId, sig: claimSig },
        }),
      },
      relayEnv,
    );
    expect(firstIntentClaim.status).toBe(200);

    const fallbackWalletClaim = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: goodClaimTx,
          intentAuth: { intentId: claimIntentId, sig: claimSig },
          walletAuth: await signWalletAuth(linkedKp, "feebump", goodClaimTx, "nonce_fallback_1"),
        }),
      },
      relayEnv,
    );
    expect(fallbackWalletClaim.status).toBe(200);

    // --- HALLAZGO-04: resourceFee ceiling & accounting even when v1.tx.fee is 100 ---
    const highResourceBuilt = new TransactionBuilder(new Account(linkedKp.publicKey(), "100"), {
      fee: "100",
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(escrowId).call("claim", nativeToScVal(expectedClaimIdBytes, { type: "bytes" })),
      )
      .setSorobanData(new SorobanDataBuilder().setResourceFee("5000000").build())
      .setTimeout(60)
      .build();
    const highResEnvXdr = highResourceBuilt.toEnvelope();
    highResEnvXdr.v1.tx.fee = 100;
    const highResXdr = highResEnvXdr.toXDR("base64");
    const overResourceRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: highResXdr,
          walletAuth: await signWalletAuth(linkedKp, "feebump", highResXdr, "nonce_resfee_1"),
        }),
      },
      relayEnv,
    );
    expect(overResourceRes.status).toBe(403);

    const normalResourceBuilt = new TransactionBuilder(new Account(linkedKp.publicKey(), "100"), {
      fee: "100",
      networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(escrowId).call("claim", nativeToScVal(expectedClaimIdBytes, { type: "bytes" })),
      )
      .setSorobanData(new SorobanDataBuilder().setResourceFee("400000").build())
      .setTimeout(60)
      .build();
    const normalEnvXdr = normalResourceBuilt.toEnvelope();
    normalEnvXdr.v1.tx.fee = 100;
    const normalResXdr = normalEnvXdr.toXDR("base64");
    const spentBefore = relaySpent.get(dayUtc) ?? 0n;
    const normalRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: normalResXdr,
          walletAuth: await signWalletAuth(linkedKp, "feebump", normalResXdr, "nonce_resfee_2"),
        }),
      },
      relayEnv,
    );
    expect(normalRes.status).toBe(200);
    expect((relaySpent.get(dayUtc) ?? 0n) - spentBefore).toBeGreaterThanOrEqual(420_000n);

    // --- HALLAZGO-05: no tx_bad_seq retry in feebump, timeout retains lease, DO storage persistence ---
    upstreamBehavior = "bad_seq";
    upstreamCalls = 0;
    const badSeqFeebump = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: goodClaimTx,
          walletAuth: await signWalletAuth(linkedKp, "feebump", goodClaimTx, "nonce_badseq_fb"),
        }),
      },
      relayEnv,
    );
    expect(badSeqFeebump.status).toBe(502);
    expect(upstreamCalls).toBe(1);

    // Timeout holds lease across DO restart (hydrated from mockDoState.storage)
    upstreamBehavior = "timeout";
    const timeoutPayload = [validFuncXdr, allowedAuthEntry].join(":");
    const timeoutRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "soroban",
          funcXdrBase64: validFuncXdr,
          authEntriesXdrBase64: [allowedAuthEntry],
          walletAuth: await signWalletAuth(linkedKp, "soroban", timeoutPayload, "nonce_to_1"),
        }),
      },
      relayEnv,
    );
    expect(timeoutRes.status).toBe(502);

    const poolRestarted = new ChannelPoolDO(mockDoState, {});
    const statusRes = await poolRestarted.fetch(new Request("https://channel-pool.internal/status"));
    const statusJson = (await statusRes.json()) as { activeLeases: number };
    expect(statusJson.activeLeases).toBeGreaterThanOrEqual(1);
    void relayTxCount;

    // --- HALLAZGO-07: Fail-closed smart account linking when SMART_ACCOUNT_WASM_HASH is unset ---
    const challengeMessage = `astrowallet-connect:v1:testnet:777001:ch_carbon:${now}:${now + 600}`;
    const verifyRes = await verifyConnectAccountSubmissions({
      config: {
        network: "testnet",
        networkPassphrase: TEST_ENV.STELLAR_NETWORK_PASSPHRASE,
        rpcUrls: [TEST_ENV.STELLAR_RPC_URLS],
        horizonUrls: [TEST_ENV.HORIZON_URLS],
        pwaOrigin: TEST_ENV.PWA_ORIGIN,
        allowedOrigins: [TEST_ENV.ALLOWED_ORIGINS],
        sep42AssetListUrls: [],
        relayAllowedContracts: [],
        relayRateLimitPerMin: 10,
        proxyRateLimitPerMin: 60,
        relayMaxOperations: 5,
        relayMaxFeeStroops: "2000000",
        relayDailyBudgetStroops: "500000000",
        tgBotToken: TEST_ENV.TG_BOT_TOKEN,
        tgWebhookSecret: TEST_ENV.TG_WEBHOOK_SECRET,
        intentHmacSecret: TEST_ENV.INTENT_HMAC_SECRET,
        connectVerifiedBots: [],
        relayChannelAccounts: [],
        relayBootstrapStartingBalanceXlm: "1.5",
        relayBootstrapDailyLimit: 25,
        relayAllowDirectBootstrap: false,
        smartAccountWasmHash: undefined,
      },
      repo,
      telegramUserId: "777001",
      challengeMessage,
      accounts: [
        {
          address: linkedKp.publicKey() as never,
          kind: "classic",
          label: "Guardian",
          signatureBase64: await signSep53(linkedKp, challengeMessage),
        },
        {
          address: escrowId as never,
          kind: "smart",
          label: "Arbitrary Contract",
          guardianAddress: linkedKp.publicKey() as never,
          signatureBase64: await signSep53(
            linkedKp,
            `${challengeMessage}:smart:${escrowId}`,
          ),
        },
      ],
    });
    expect(verifyRes.ok).toBe(false);
    if (!verifyRes.ok) {
      expect(verifyRes.status).toBe(403);
    }
  });

  it("enforces Carbon Block 2 defenses: TON manifest origin match, SEP-10 allowlist & oracle auth, Connect ownership & FeeBump sigs, group intent binding, metrics integrity, and authoritative username sync", async () => {
    const { repo, verifiedTxs } = createD1FaithfulRepo();
    const now = Math.floor(Date.now() / 1000);
    const signer = Keypair.random();
    const forgedKp = Keypair.random();
    const anchorSigner = Keypair.random();
    const clientSigner = Keypair.random();
    const signLocalSep53 = async (kp: Keypair, msg: string) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${msg}`),
      );
      return Buffer.from(kp.sign(Buffer.from(digest))).toString("base64");
    };

    const maliciousClientSourceChallenge = new TransactionBuilder(
      new Account(anchorSigner.publicKey(), "-1"),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.manageData({
          source: signer.publicKey(),
          name: "extstellar.moneygram.com auth",
          value: "n1",
        }),
      )
      .addOperation(
        Operation.manageData({
          source: clientSigner.publicKey(),
          name: "client_domain",
          value: "astro-wallet.pages.dev",
        }),
      )
      .addOperation(
        Operation.manageData({
          source: clientSigner.publicKey(),
          name: "sneaky_extra_op",
          value: "evil",
        }),
      )
      .setTimeout(300)
      .build();
    maliciousClientSourceChallenge.sign(anchorSigner);

    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async () => ({ confirmed: true, ledger: 500 }),
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://spoof.example/manifest.json") {
          return new Response(
            JSON.stringify({ name: "Fragment", url: "https://fragment.com" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://extstellar.moneygram.com/.well-known/stellar.toml") {
          return new Response(
            [
              `SIGNING_KEY="${anchorSigner.publicKey()}"`,
              'WEB_AUTH_ENDPOINT="https://extstellar.moneygram.com/auth"',
              'TRANSFER_SERVER_SEP0024="https://extstellar.moneygram.com/sep24"',
            ].join("\n"),
            { status: 200 },
          );
        }
        if (url === "https://unlisted.example.org/.well-known/stellar.toml") {
          return new Response(
            [
              `SIGNING_KEY="${anchorSigner.publicKey()}"`,
              'WEB_AUTH_ENDPOINT="https://unlisted.example.org/auth"',
              'TRANSFER_SERVER_SEP0024="https://unlisted.example.org/sep24"',
            ].join("\n"),
            { status: 200 },
          );
        }
        if (url.startsWith("https://extstellar.moneygram.com/auth")) {
          return new Response(
            JSON.stringify({
              transaction: maliciousClientSourceChallenge.toXDR(),
              network_passphrase: Networks.TESTNET,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("https://unlisted.example.org/auth")) {
          return new Response(
            JSON.stringify({
              transaction: "AAAAAg==",
              network_passphrase: Networks.TESTNET,
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const userToken = await signMiniAppSessionToken(
      { telegramUserId: "9001", network: "testnet", issuedAt: now, expiresAt: now + 900 },
      TEST_ENV.INTENT_HMAC_SECRET,
    );

    // 1. HALLAZGO-08: Reject cross-origin TON manifest url spoofing
    const spoofManifest = await app.request(
      `/v1/proxy/ton-manifest?url=${encodeURIComponent("https://spoof.example/manifest.json")}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(spoofManifest.status).toBe(400);

    // 2. HALLAZGO-13: Unlisted anchor refuses client co-signing & sneaky clientKp op rejected
    const sepEnv = {
      ...TEST_ENV,
      SEP10_CLIENT_DOMAIN: "astro-wallet.pages.dev",
      SEP10_ALLOWED_ANCHOR_DOMAINS: "extstellar.moneygram.com",
      SEP10_CLIENT_SIGNING_SECRET: clientSigner.secret(),
    };
    const unlistedChallenge = await app.request(
      `/v1/proxy/sep10/challenge?domain=unlisted.example.org&account=${signer.publicKey()}`,
      { headers: { Authorization: `Bearer ${userToken}` } },
      sepEnv,
    );
    expect(unlistedChallenge.status).toBe(200);
    const unlistedJson = (await unlistedChallenge.json()) as { clientDomainSigned?: boolean };
    expect(unlistedJson.clientDomainSigned).toBeUndefined();

    const sneakyChallenge = await app.request(
      `/v1/proxy/sep10/challenge?domain=extstellar.moneygram.com&account=${signer.publicKey()}`,
      { headers: { Authorization: `Bearer ${userToken}` } },
      sepEnv,
    );
    expect(sneakyChallenge.status).toBe(502);

    // 3. HALLAZGO-12: AstroConnect auth strips unowned extra accounts; sign_xdr submit=false requires address & valid sig
    const authCreate = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "auth",
          app: { name: "Demo", botUsername: "AstroDexBot" },
          payload: { includeAccounts: true, nonce: "carbon2nonce" },
        }),
      },
      TEST_ENV,
    );
    const authCreated = (await authCreate.json()) as {
      requestId: string;
      sig: string;
      resultToken: string;
      challengeMessage: string;
    };
    const authSigBytes = await signLocalSep53(signer, authCreated.challengeMessage);
    const completeAuth = await app.request(
      `/v1/connect/requests/${authCreated.requestId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          sig: authCreated.sig,
          status: "approved",
          address: signer.publicKey(),
          signatureBase64: authSigBytes,
          accounts: [
            { address: signer.publicKey(), kind: "classic", label: "Real", isDefault: true },
            { address: forgedKp.publicKey(), kind: "classic", label: "VictimHijack", isDefault: false },
          ],
        }),
      },
      TEST_ENV,
    );
    expect(completeAuth.status).toBe(200);
    const polledAuth = (await (
      await app.request(
        `/v1/connect/requests/${authCreated.requestId}`,
        { headers: { "X-Connect-Token": authCreated.resultToken } },
        TEST_ENV,
      )
    ).json()) as { result: { accounts: Array<{ address: string }> } };
    expect(polledAuth.result.accounts).toHaveLength(1);
    expect(polledAuth.result.accounts[0]?.address).toBe(signer.publicKey());

    const unsignedTx = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: forgedKp.publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(60)
      .build();
    const unsignedXdr = unsignedTx.toXDR();
    const xdrHashHex = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unsignedXdr)),
    ).toString("hex");
    const xdrReq = (await (
      await app.request(
        "/v1/connect/requests",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sign_xdr",
            app: { name: "Demo", botUsername: "AstroDexBot" },
            payload: { unsignedXdr, xdrSha256: xdrHashHex, submit: false },
          }),
        },
        TEST_ENV,
      )
    ).json()) as { requestId: string; sig: string };

    // Missing address on submit=false rejected with 400
    const missingAddrXdr = await app.request(
      `/v1/connect/requests/${xdrReq.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: xdrReq.sig,
          status: "approved",
          signedXdr: unsignedXdr,
        }),
      },
      TEST_ENV,
    );
    expect(missingAddrXdr.status).toBe(400);

    // 4. HALLAZGO-14: Stranger cannot confirm creator-only pay intent without session or bound creator address
    const paySig = await signIntentToken(
      { intentId: "it_pay_hijack", network: "testnet", telegramUserId: "9001", expiresAt: now + 300 },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "it_pay_hijack",
      network: "testnet",
      creatorTelegramUserId: "9001",
      actionType: "pay",
      payloadJson: JSON.stringify({ amount: "10", assetCode: "XLM" }),
      hmacSig: paySig,
      status: "pending",
      expiresAt: now + 300,
      createdAt: now,
    });
    const unauthConfirm = await app.request(
      "/v1/intents/it_pay_hijack/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sig: paySig, txHash: "f".repeat(64), payerAddress: forgedKp.publicKey() }),
      },
      TEST_ENV,
    );
    expect(unauthConfirm.status).toBe(401);

    // 5. HALLAZGO-15 & HALLAZGO-16: Metrics require auth, never write verified_tx_log; authoritativeUsername clears stale username
    const unauthMetric = await app.request(
      "/v1/metrics/event",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "tx_sent", txHash: "e".repeat(64) }),
      },
      TEST_ENV,
    );
    expect(unauthMetric.status).toBe(401);

    const authMetric = await app.request(
      "/v1/metrics/event",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ eventType: "tx_sent", txHash: "e".repeat(64) }),
      },
      TEST_ENV,
    );
    expect(authMetric.status).toBe(200);
    expect(verifiedTxs).not.toContain("e".repeat(64));

    await repo.upsertTelegramUser({ telegramUserId: "9002", usernameLower: "old_handle" });
    const cleared = await repo.upsertTelegramUser({
      telegramUserId: "9002",
      usernameLower: null,
      authoritativeUsername: true,
    });
    expect(cleared.usernameLower).toBeUndefined();
  });
});
