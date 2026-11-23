import type {
  ClassicAddress,
  ClaimLink,
  ConnectRequestRecord,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import { computeTelegramInitDataHash } from "@astrowallet/tg-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type {
  ServerRepository,
  StoredEncryptedVaultBackup,
  TelegramUserRecord,
} from "./db/repository.js";
import { resetMemoryRateLimits } from "./rate-limit.js";

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
  ECOSYSTEM_SHARED_INTENT_SECRET: "ecosystem-shared-secret-32-chars-min",
  CONNECT_VERIFIED_BOTS: "@VerifiedSorobanBot,AnotherBot",
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
    async signSep53(message: string): Promise<string> {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Stellar Signed Message:\n${message}`),
      );
      const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, digest));
      return btoa(String.fromCharCode(...sig));
    },
  };
}

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function createConnectMemoryRepo(): ServerRepository {
  const users = new Map<string, TelegramUserRecord>();
  const bindings = new Map<string, TelegramUserBinding[]>();
  const intents = new Map<string, SignedIntent>();
  const claims = new Map<string, ClaimLink>();
  const dedupKeys = new Set<string>();
  const rateLimits = new Map<string, number>();
  const relayBudget = new Map<string, bigint>();
  const tgUpdates = new Set<number>();
  const encryptedBackups = new Map<string, StoredEncryptedVaultBackup>();
  const connectRequests = new Map<string, ConnectRequestRecord>();

  return {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      const next: TelegramUserRecord = { telegramUserId, usernameLower, alertsEnabled: true };
      users.set(telegramUserId, next);
      return next;
    },
    async getUserById(id) {
      return users.get(id) ?? null;
    },
    async getUserByUsername(u) {
      for (const user of users.values()) {
        if (user.usernameLower === u.toLowerCase()) return user;
      }
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
    async markIntentConfirmed(id) {
      return intents.get(id) ?? null;
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
    async markClaimLinkStatus() {
      return null;
    },
    async isTxHashUsed() {
      return false;
    },
    async recordSplitPayment() {
      return { paidCount: 0 };
    },
    async countSplitPayments() {
      return 0;
    },
    async listSplitPaymentTxHashes() {
      return [];
    },
    async claimAlertDedupKey(key) {
      if (dedupKeys.has(key)) return false;
      dedupKeys.add(key);
      return true;
    },
    async findRecentPendingIntent() {
      return null;
    },
    async incrementRateLimit({ key, windowSec, limit, nowSec }) {
      const now = nowSec ?? Math.floor(Date.now() / 1000);
      const bucket = `${key}:${Math.floor(now / windowSec)}`;
      const count = (rateLimits.get(bucket) ?? 0) + 1;
      rateLimits.set(bucket, count);
      return { allowed: count <= limit, count, retryAfterSeconds: windowSec };
    },
    async tryConsumeRelayBudget({ dayUtc, feeStroops }) {
      const prev = relayBudget.get(dayUtc) ?? 0n;
      const next = prev + BigInt(feeStroops);
      relayBudget.set(dayUtc, next);
      return { allowed: true, spentStroops: next.toString() };
    },
    async claimTelegramUpdateId(id) {
      if (tgUpdates.has(id)) return false;
      tgUpdates.add(id);
      return true;
    },
    async purgeExpiredRecords() {},
    async upsertEncryptedVaultBackup() {
      throw new Error("unused");
    },
    async getEncryptedVaultBackup(tgId, net) {
      return encryptedBackups.get(`${tgId}:${net}`) ?? null;
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
    async incrementProductEvent() {},
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
}

describe("AstroConnect v1 Open Standard API (/v1/connect/* & discovery)", () => {
  beforeEach(() => {
    resetMemoryRateLimits();
  });

  it("enforces scoped CORS: open for /v1/connect/*, /v1/identity/resolve, /openapi.json, /llms.txt; strict for /v1/tg/*", async () => {
    const repo = createConnectMemoryRepo();
    const app = createApp({ createRepo: () => repo });

    const openConnect = await app.request(
      "/v1/connect/requests",
      { method: "OPTIONS", headers: { Origin: "https://thirdparty-dapp.example" } },
      TEST_ENV,
    );
    expect(openConnect.status).toBe(204);
    expect(openConnect.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const openIdentity = await app.request(
      "/v1/identity/resolve?q=@unknown",
      { method: "GET", headers: { Origin: "https://thirdparty-dapp.example" } },
      TEST_ENV,
    );
    expect(openIdentity.status).toBe(200);
    expect(openIdentity.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const blockedPrivate = await app.request(
      "/v1/tg/me",
      { method: "OPTIONS", headers: { Origin: "https://thirdparty-dapp.example" } },
      TEST_ENV,
    );
    expect(blockedPrivate.status).toBe(403);

    const openApiRes = await app.request(
      "/openapi.json",
      { method: "GET", headers: { Origin: "https://thirdparty-dapp.example" } },
      TEST_ENV,
    );
    expect(openApiRes.status).toBe(200);
    const openApi = (await openApiRes.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.paths["/v1/connect/requests"]).toBeDefined();

    const llmsRes = await app.request("/llms.txt", { method: "GET" }, TEST_ENV);
    expect(llmsRes.status).toBe(200);
    expect(await llmsRes.text()).toContain("AstroConnect v1");
  });

  it("executes permissionless SEP-53 auth flow with trust tiers, Telegram session binding, and Boomerang return", async () => {
    const repo = createConnectMemoryRepo();
    const app = createApp({ createRepo: () => repo });
    const signer = await generateTestSigner();

    // 1. Third-party app creates permissionless auth request
    const createRes = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "auth",
          app: {
            name: "Soroban Perps",
            botUsername: "SorobanPerpsBot",
            miniAppShortName: "perps",
            returnStartAppParam: "auth_ok",
          },
          payload: {
            nonce: "nonce_abcdef12",
            statement: "Authenticate to Soroban Perps",
            domain: "perps.example",
          },
        }),
      },
      TEST_ENV,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      requestId: string;
      sig: string;
      resultToken: string;
      trustTier: string;
      deepLink: string;
      challengeMessage: string;
    };
    expect(created.trustTier).toBe("external");
    expect(created.deepLink).toBe(
      `https://t.me/AstroWalletAppBot/wallet?startapp=${encodeURIComponent(`c-${created.requestId}-${created.sig}`)}`,
    );

    // 2. Verified & official trust tiers resolve properly
    const verifiedRes = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_message",
          app: { name: "Verified App", botUsername: "VerifiedSorobanBot" },
          payload: { message: "hello" },
        }),
      },
      TEST_ENV,
    );
    expect(((await verifiedRes.json()) as { trustTier: string }).trustTier).toBe("verified");

    const officialRes = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ecosystem-Secret": TEST_ENV.ECOSYSTEM_SHARED_INTENT_SECRET,
        },
        body: JSON.stringify({
          action: "sign_message",
          app: { name: "AstroDex", botUsername: "AstroDexBot" },
          payload: { message: "hello" },
        }),
      },
      TEST_ENV,
    );
    expect(((await officialRes.json()) as { trustTier: string }).trustTier).toBe("official");

    // 3. Rejects polling with invalid X-Connect-Token
    const badPoll = await app.request(
      `/v1/connect/requests/${created.requestId}`,
      { headers: { "X-Connect-Token": "wrong_token" } },
      TEST_ENV,
    );
    expect(badPoll.status).toBe(401);

    // 4. Rejects forged SEP-53 signature on /complete
    const forgedComplete = await app.request(
      `/v1/connect/requests/${created.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          status: "approved",
          address: signer.address,
          signatureBase64: btoa("A".repeat(64)),
        }),
      },
      TEST_ENV,
    );
    expect(forgedComplete.status).toBe(400);

    // 5. Mint Telegram Mini App session and complete with valid SEP-53 Ed25519 signature
    const authDate = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 778899, username: "StellarBuilder" }),
    });
    const pairs = Array.from(params.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const tgHash = await computeTelegramInitDataHash(pairs, TEST_ENV.TG_BOT_TOKEN);
    params.set("hash", tgHash);
    const tgAuthRes = await app.request(
      "/v1/tg/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: params.toString() }),
      },
      TEST_ENV,
    );
    const { sessionToken } = (await tgAuthRes.json()) as { sessionToken: string };

    const validSig = await signer.signSep53(created.challengeMessage);
    const completeRes = await app.request(
      `/v1/connect/requests/${created.requestId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          sig: created.sig,
          status: "approved",
          address: signer.address,
          accounts: [
            { address: signer.address, kind: "classic", label: "Primary", isDefault: true },
          ],
          signatureBase64: validSig,
        }),
      },
      TEST_ENV,
    );
    expect(completeRes.status).toBe(200);
    const completed = (await completeRes.json()) as { returnUrl: string; status: string };
    expect(completed.status).toBe("approved");
    expect(completed.returnUrl).toBe("https://t.me/SorobanPerpsBot/perps?startapp=auth_ok");

    // 6. Calling /complete twice fails with 409
    const doubleComplete = await app.request(
      `/v1/connect/requests/${created.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: created.sig,
          status: "rejected",
        }),
      },
      TEST_ENV,
    );
    expect(doubleComplete.status).toBe(409);

    // 7. Polling with X-Connect-Token returns approved proof
    const pollRes = await app.request(
      `/v1/connect/requests/${created.requestId}`,
      { headers: { "X-Connect-Token": created.resultToken } },
      TEST_ENV,
    );
    expect(pollRes.status).toBe(200);
    const polled = (await pollRes.json()) as {
      status: string;
      result: {
        address: string;
        telegramUserId: string;
        username: string;
        signatureBase64: string;
      };
    };
    expect(polled.status).toBe("approved");
    expect(polled.result.address).toBe(signer.address);
    expect(polled.result.telegramUserId).toBe("778899");
    expect(polled.result.username).toBe("stellarbuilder");
    expect(polled.result.signatureBase64).toBe(validSig);
  });

  it("enforces xdrSha256 binding, sign-only return, and on-chain verification for sign_xdr", async () => {
    const repo = createConnectMemoryRepo();
    const txHash = "a".repeat(64);
    const app = createApp({
      createRepo: () => repo,
      verifyTxFn: async (_cfg, hash) =>
        hash === txHash
          ? { confirmed: true, ledger: 9001 }
          : { confirmed: false, reason: "tx not found" },
    });

    const unsignedXdr = "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQ=";
    const badCreate = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_xdr",
          app: { name: "Soroban DEX", botUsername: "SorobanDexBot" },
          payload: {
            unsignedXdr,
            xdrSha256: "0".repeat(64),
            humanSummary: "Invoke swap",
          },
        }),
      },
      TEST_ENV,
    );
    expect(badCreate.status).toBe(400);

    const xdrSha256 = await sha256Hex(unsignedXdr);
    const signOnlyCreate = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_xdr",
          app: { name: "Soroban DEX", botUsername: "SorobanDexBot" },
          payload: {
            unsignedXdr,
            xdrSha256,
            submit: false,
            humanSummary: "Sign Soroban auth XDR",
          },
        }),
      },
      TEST_ENV,
    );
    expect(signOnlyCreate.status).toBe(201);
    const signOnly = (await signOnlyCreate.json()) as {
      requestId: string;
      sig: string;
      resultToken: string;
    };

    const signOnlyComplete = await app.request(
      `/v1/connect/requests/${signOnly.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: signOnly.sig,
          status: "approved",
          signedXdr: `${unsignedXdr}SIGNED`,
        }),
      },
      TEST_ENV,
    );
    expect(signOnlyComplete.status).toBe(200);

    const signOnlyPoll = await app.request(
      `/v1/connect/requests/${signOnly.requestId}`,
      { headers: { "X-Connect-Token": signOnly.resultToken } },
      TEST_ENV,
    );
    expect(
      ((await signOnlyPoll.json()) as { result: { signedXdr: string } }).result.signedXdr,
    ).toBe(`${unsignedXdr}SIGNED`);

    // submit=true verifies txHash on-chain
    const submitCreate = await app.request(
      "/v1/connect/requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_xdr",
          app: { name: "Soroban DEX", botUsername: "SorobanDexBot" },
          payload: {
            unsignedXdr,
            xdrSha256,
            submit: true,
            humanSummary: "Execute Soroban mint",
          },
        }),
      },
      TEST_ENV,
    );
    const submitReq = (await submitCreate.json()) as {
      requestId: string;
      sig: string;
      resultToken: string;
    };

    const unconfirmed = await app.request(
      `/v1/connect/requests/${submitReq.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: submitReq.sig,
          status: "approved",
          txHash: "b".repeat(64),
        }),
      },
      TEST_ENV,
    );
    expect(unconfirmed.status).toBe(409);

    const confirmed = await app.request(
      `/v1/connect/requests/${submitReq.requestId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: submitReq.sig,
          status: "approved",
          txHash,
        }),
      },
      TEST_ENV,
    );
    expect(confirmed.status).toBe(200);
  });
});
