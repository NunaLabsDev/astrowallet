import type {
  ClaimLink,
  ConnectRequestRecord,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import { signIntentToken } from "@astrowallet/tg-protocol";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
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
import { resetMemoryRateLimits } from "./rate-limit.js";
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

  const repo: ServerRepository = {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      const next: TelegramUserRecord = { telegramUserId, usernameLower, alertsEnabled: true };
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
    async linkVerifiedAddresses({ telegramUserId }) {
      return bindings.get(telegramUserId) ?? [];
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
    async isAddressLinked() {
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
    async claimAlertDedupKey() {
      return true;
    },
    async findRecentPendingIntent() {
      return null;
    },
    async incrementRateLimit() {
      return { allowed: true, count: 1, retryAfterSeconds: 60 };
    },
    async tryConsumeRelayBudget() {
      return { allowed: true, spentStroops: "100" };
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

  return { repo, events, verifiedTxs };
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

    const [resA, resB] = await Promise.all([
      app.request(
        `/v1/intents/${intentId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sig, txHash: "a".repeat(64) }),
        },
        TEST_ENV,
      ),
      app.request(
        `/v1/intents/${intentId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

    const zeroSep24 = await app.request(
      "/v1/proxy/sep24/interactive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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

    const kp = Keypair.random();
    const res = await app.request(
      `/v1/proxy/sep10/challenge?domain=anchor.example.org&account=${kp.publicKey()}`,
      { method: "GET" },
      {
        ...TEST_ENV,
        SEP10_CLIENT_DOMAIN: "astrowallet-soroban.pages.dev",
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
    const claimIdBytes = new Uint8Array(32).fill(1);
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
});
