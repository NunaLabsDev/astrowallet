import type {
  ClaimLink,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import { createHorizonPathSwapAdapter } from "@astrowallet/defi";
import { parsePwaConfig, parseServerConfig } from "@astrowallet/domain";
import {
  evaluateDecodedTransaction,
  simulateSorobanTransaction,
  type DecodedTransactionSummary,
} from "@astrowallet/security-shield";
import { signIntentToken } from "@astrowallet/tg-protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ServerRepository, StoredEncryptedVaultBackup, TelegramUserRecord } from "./db/repository.js";
import { fetchLiveAccountBalances } from "./stellar-verifier.js";

const SAMPLE_SRC_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SAMPLE_DEST_G = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const SAMPLE_FAKE_ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR2V";
const SAMPLE_CONTRACT_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SAMPLE_MUXED_M = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

const TEST_PASSPHRASE = ["Test SDF Network", "September 2015"].join(" ; ");
const MAINNET_PASSPHRASE = ["Public Global Stellar Network", "September 2015"].join(" ; ");

const TEST_ENV = {
  STELLAR_NETWORK: "testnet",
  STELLAR_NETWORK_PASSPHRASE: TEST_PASSPHRASE,
  STELLAR_RPC_URLS: "https://rpc-primary.example.org,https://rpc-secondary.example.org",
  HORIZON_URLS: "https://horizon-primary.example.org,https://horizon-secondary.example.org",
  PWA_ORIGIN: "https://testnet.astrowallet.example",
  ALLOWED_ORIGINS: "https://testnet.astrowallet.example",
  TG_BOT_TOKEN: "test-bot-token",
  TG_WEBHOOK_SECRET: "secret-header-token-1234",
  INTENT_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
};

function createPhase4MemoryRepo(): ServerRepository {
  const users = new Map<string, TelegramUserRecord>();
  const bindings = new Map<string, TelegramUserBinding[]>();
  const intents = new Map<string, SignedIntent>();
  const claims = new Map<string, ClaimLink>();
  const splitPayments = new Map<string, Array<{ txHash: string; amount: string }>>();
  const dedupKeys = new Set<string>();
  const rateLimits = new Map<string, number>();
  const relayBudget = new Map<string, bigint>();
  const tgUpdates = new Set<number>();

  return {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      if (usernameLower) {
        for (const [id, existing] of users.entries()) {
          if (id !== telegramUserId && existing.usernameLower === usernameLower) {
            users.set(id, { ...existing, usernameLower: undefined });
          }
        }
      }
      const next: TelegramUserRecord = {
        telegramUserId,
        usernameLower,
        alertsEnabled: true,
      };
      users.set(telegramUserId, next);
      return next;
    },
    async getUserById(id) {
      return users.get(id) ?? null;
    },
    async getUserByUsername(usernameLower) {
      for (const u of users.values()) {
        if (u.usernameLower === usernameLower) return u;
      }
      return null;
    },
    async setUserAlertsEnabled(id, enabled) {
      const u = users.get(id);
      if (u) users.set(id, { ...u, alertsEnabled: enabled });
    },
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
    async unlinkUserAddresses(telegramUserId) {
      const prev = bindings.get(telegramUserId)?.length ?? 0;
      bindings.delete(telegramUserId);
      return prev;
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
    async getSignedIntent(intentId) {
      return intents.get(intentId) ?? null;
    },
    async attachIntentMessageRef() {},
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
    async recordSplitPayment({ intentId, txHash, amount }) {
      const list = splitPayments.get(intentId) ?? [];
      list.push({ txHash: txHash.toLowerCase(), amount });
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
    async upsertEncryptedVaultBackup(): Promise<StoredEncryptedVaultBackup> {
      throw new Error("Not used in phase4 harness");
    },
    async getEncryptedVaultBackup() {
      return null;
    },
    async deleteEncryptedVaultBackup() {
      return false;
    },
  };
}

describe("Phase 4 Adversarial, Failover & Mainnet Parity Verification Suite", () => {
  it("blocks adversarial XDR drainers: setOptions hijack, masterWeight=0 lockout, accountMerge, and nested Soroban approve", () => {
    const baseSummary: Omit<DecodedTransactionSummary, "operations"> = {
      sourceAccount: SAMPLE_SRC_G,
      feeStroops: "100",
      memo: { type: "none" },
    };

    const setOptionsHijack = evaluateDecodedTransaction(
      {
        ...baseSummary,
        operations: [
          {
            type: "setOptions",
            signerKey: SAMPLE_DEST_G,
            signerWeight: 10,
            masterWeight: 0,
          },
        ],
      },
      { networkPassphrase: TEST_PASSPHRASE },
    );
    expect(setOptionsHijack.verdict).toBe("malicious");
    expect(
      setOptionsHijack.findings.some((f) => f.code === "MALICIOUS_SET_OPTIONS_SIGNER"),
    ).toBe(true);
    expect(
      setOptionsHijack.findings.some((f) => f.code === "MALICIOUS_SET_OPTIONS_MASTER_LOCKOUT"),
    ).toBe(true);

    const mergeDrain = evaluateDecodedTransaction(
      {
        ...baseSummary,
        operations: [{ type: "accountMerge", destination: SAMPLE_DEST_G }],
      },
      { networkPassphrase: TEST_PASSPHRASE },
    );
    expect(mergeDrain.verdict).toBe("malicious");
    expect(mergeDrain.findings.some((f) => f.code === "DANGEROUS_ACCOUNT_MERGE")).toBe(true);

    const nestedSoroban = evaluateDecodedTransaction(
      {
        ...baseSummary,
        operations: [
          {
            type: "invokeHostFunction",
            soroban: {
              contractId: SAMPLE_CONTRACT_C,
              functionName: "swap",
              args: [],
              subInvocations: [
                {
                  contractId: SAMPLE_CONTRACT_C,
                  functionName: "approve",
                  args: [],
                  subInvocations: [],
                },
              ],
            },
          },
        ],
      },
      { networkPassphrase: TEST_PASSPHRASE },
    );
    expect(nestedSoroban.verdict).toBe("malicious");
    expect(
      nestedSoroban.findings.some((f) => f.code === "SOROBAN_NESTED_TOKEN_APPROVAL"),
    ).toBe(true);
  });

  it("blocks fake USDC issuer and enforces SEP-29 exchange memo vs M... muxed destinations", () => {
    const verifiedAssets = [{ code: "USDC", issuer: SAMPLE_DEST_G }];

    const spoofedReport = evaluateDecodedTransaction(
      {
        sourceAccount: SAMPLE_SRC_G,
        feeStroops: "100",
        memo: { type: "none" },
        operations: [
          {
            type: "payment",
            destination: SAMPLE_DEST_G,
            amount: "100",
            asset: { code: "USDC", issuer: SAMPLE_FAKE_ISSUER },
          },
        ],
      },
      { networkPassphrase: TEST_PASSPHRASE, verifiedAssets },
    );
    expect(spoofedReport.verdict).toBe("malicious");
    expect(spoofedReport.findings.some((f) => f.code === "SPOOFED_PROTECTED_ASSET")).toBe(true);

    const missingMemoReport = evaluateDecodedTransaction(
      {
        sourceAccount: SAMPLE_SRC_G,
        feeStroops: "100",
        memo: { type: "none" },
        operations: [
          {
            type: "payment",
            destination: SAMPLE_DEST_G,
            amount: "50",
            asset: { code: "USDC", issuer: SAMPLE_DEST_G },
          },
        ],
      },
      {
        networkPassphrase: TEST_PASSPHRASE,
        verifiedAssets,
        memoRequiredDestinations: new Set([SAMPLE_DEST_G]),
      },
    );
    expect(missingMemoReport.verdict).toBe("malicious");
    expect(missingMemoReport.requiresMemoCheck).toBe(true);
    expect(
      missingMemoReport.findings.some((f) => f.code === "MISSING_SEP29_EXCHANGE_MEMO"),
    ).toBe(true);

    const muxedReport = evaluateDecodedTransaction(
      {
        sourceAccount: SAMPLE_SRC_G,
        feeStroops: "100",
        memo: { type: "none" },
        operations: [
          {
            type: "payment",
            destination: SAMPLE_MUXED_M,
            amount: "50",
            asset: { code: "USDC", issuer: SAMPLE_DEST_G },
          },
        ],
      },
      {
        networkPassphrase: TEST_PASSPHRASE,
        verifiedAssets,
        memoRequiredDestinations: new Set([SAMPLE_MUXED_M]),
      },
    );
    expect(muxedReport.verdict).toBe("benign");
  });

  it("rejects expired (410), tampered (401), and cross-network (409) Telegram signed intents", async () => {
    const repo = createPhase4MemoryRepo();
    const app = createApp({ createRepo: () => repo });
    const now = Math.floor(Date.now() / 1000);

    // 1. Expired intent -> 410
    const expiredSig = await signIntentToken(
      {
        intentId: "it_expired_01",
        network: "testnet",
        telegramUserId: "10001",
        expiresAt: now - 60,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "it_expired_01",
      network: "testnet",
      creatorTelegramUserId: "10001",
      actionType: "pay",
      payloadJson: '{"amount":"5","assetCode":"XLM"}',
      hmacSig: expiredSig,
      status: "pending",
      expiresAt: now - 60,
      createdAt: now - 360,
    });
    const expiredRes = await app.request(
      `/v1/intents/it_expired_01?sig=${expiredSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(expiredRes.status).toBe(410);

    // 2. Tampered signature -> 401
    const validSig = await signIntentToken(
      {
        intentId: "it_valid_01",
        network: "testnet",
        telegramUserId: "10001",
        expiresAt: now + 300,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "it_valid_01",
      network: "testnet",
      creatorTelegramUserId: "10001",
      actionType: "pay",
      payloadJson: '{"amount":"5","assetCode":"XLM"}',
      hmacSig: validSig,
      status: "pending",
      expiresAt: now + 300,
      createdAt: now,
    });
    const tamperedSig = `${validSig.slice(0, -4)}0000`;
    const tamperedRes = await app.request(
      `/v1/intents/it_valid_01?sig=${tamperedSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(tamperedRes.status).toBe(401);

    // 3. Cross-network intent -> 409
    const mainnetSig = await signIntentToken(
      {
        intentId: "it_mainnet_01",
        network: "mainnet",
        telegramUserId: "10001",
        expiresAt: now + 300,
      },
      TEST_ENV.INTENT_HMAC_SECRET,
    );
    await repo.createSignedIntent({
      intentId: "it_mainnet_01",
      network: "mainnet",
      creatorTelegramUserId: "10001",
      actionType: "pay",
      payloadJson: '{"amount":"5","assetCode":"XLM"}',
      hmacSig: mainnetSig,
      status: "pending",
      expiresAt: now + 300,
      createdAt: now,
    });
    const crossNetRes = await app.request(
      `/v1/intents/it_mainnet_01?sig=${mainnetSig}`,
      { method: "GET" },
      TEST_ENV,
    );
    expect(crossNetRes.status).toBe(409);
  });

  it("fails over cleanly from failing primary to secondary Horizon and Soroban RPC endpoints", async () => {
    const horizonCalls: string[] = [];
    const bal = await fetchLiveAccountBalances(
      {
        horizonUrls: [
          "https://horizon-primary.example.org",
          "https://horizon-secondary.example.org",
        ],
      },
      SAMPLE_SRC_G,
      async (url) => {
        const u = String(url);
        horizonCalls.push(u);
        if (u.includes("horizon-primary")) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(
          JSON.stringify({ balances: [{ asset_type: "native", balance: "123.4500000" }] }),
          { status: 200 },
        );
      },
    );
    expect(horizonCalls).toHaveLength(2);
    expect(bal.funded).toBe(true);
    expect(bal.balances[0]?.balance).toBe("123.4500000");

    const swapQuote = await createHorizonPathSwapAdapter({
      horizonUrls: [
        "https://horizon-primary.example.org",
        "https://horizon-secondary.example.org",
      ],
      fetchFn: async (url) => {
        if (String(url).includes("horizon-primary")) {
          throw new Error("ECONNRESET");
        }
        return new Response(
          JSON.stringify({ _embedded: { records: [{ destination_amount: "88.10" }] } }),
          { status: 200 },
        );
      },
    }).getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_DEST_G}`,
      amount: "100",
      slippageBps: 50,
    });
    expect(swapQuote.expectedOutputAmount).toBe("88.10");

    const rpcCalls: string[] = [];
    const sim = await simulateSorobanTransaction(
      ["https://rpc-primary.example.org", "https://rpc-secondary.example.org"],
      "AAAAAg==",
      async (url) => {
        rpcCalls.push(String(url));
        if (String(url).includes("rpc-primary")) {
          return new Response("Bad Gateway", { status: 502 });
        }
        return new Response(
          JSON.stringify({
            result: {
              minResourceFee: "42000",
              events: [{}],
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(rpcCalls).toHaveLength(2);
    expect(sim.ok).toBe(true);
    expect(sim.minResourceFeeStroops).toBe("42000");
  });

  it("boots PWA and Server under mainnet Zod parity profile and enforces Friendbot hard-block", async () => {
    const mainnetPwaEnv = {
      VITE_STELLAR_NETWORK: "mainnet",
      VITE_STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      VITE_STELLAR_RPC_URLS: "https://rpc-mainnet.example.org",
      VITE_HORIZON_URLS: "https://horizon-mainnet.example.org",
      VITE_API_BASE_URL: "https://api.astrowallet.example",
      VITE_PWA_ORIGIN: "https://app.astrowallet.example",
      VITE_TG_BOT_USERNAME: "AstroWalletBot",
      VITE_SEP42_ASSET_LIST_URLS: "https://assets.example.org/list.json",
    };

    const pwaConfig = parsePwaConfig(mainnetPwaEnv);
    expect(pwaConfig.network).toBe("mainnet");
    expect(pwaConfig.friendbotUrl).toBeUndefined();

    expect(() =>
      parsePwaConfig({
        ...mainnetPwaEnv,
        VITE_FRIENDBOT_URL: "https://friendbot.example.org",
      }),
    ).toThrow(/forbidden/i);

    const mainnetServerEnv = {
      STELLAR_NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      STELLAR_RPC_URLS: "https://rpc-mainnet.example.org",
      HORIZON_URLS: "https://horizon-mainnet.example.org",
      PWA_ORIGIN: "https://app.astrowallet.example",
      ALLOWED_ORIGINS: "https://app.astrowallet.example",
      TG_BOT_TOKEN: "mainnet-bot-token",
      TG_WEBHOOK_SECRET: "mainnet-webhook-secret-1234",
      INTENT_HMAC_SECRET: "fedcba9876543210fedcba9876543210",
    };

    const serverConfig = parseServerConfig(mainnetServerEnv);
    expect(serverConfig.network).toBe("mainnet");

    const app = createApp();
    const healthRes = await app.request("/health", { method: "GET" }, mainnetServerEnv);
    expect(healthRes.status).toBe(200);
    expect(((await healthRes.json()) as { network: string }).network).toBe("mainnet");

    const blockedMainnet = await app.request(
      "/health",
      { method: "GET" },
      { ...mainnetServerEnv, FRIENDBOT_URL: "https://friendbot.example.org" },
    );
    expect(blockedMainnet.status).toBe(500);
  });
});
