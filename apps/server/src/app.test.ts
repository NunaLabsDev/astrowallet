import type {
  ClassicAddress,
  ClaimLink,
  IntentStatus,
  SignedIntent,
  TelegramUserBinding,
} from "@astrowallet/domain";
import {
  formatConnectChallengeMessage,
  signIntentToken,
  type ConnectChallengePayload,
} from "@astrowallet/tg-protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ServerRepository, TelegramUserRecord } from "./db/repository.js";
import { fetchLiveAccountReserveInfo } from "./stellar-verifier.js";

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

function createMemoryRepo(): ServerRepository {
  const users = new Map<string, TelegramUserRecord>();
  const bindings = new Map<string, TelegramUserBinding[]>();
  const intents = new Map<string, SignedIntent>();
  const claims = new Map<string, ClaimLink>();

  return {
    async upsertTelegramUser({ telegramUserId, usernameLower }) {
      const prev = users.get(telegramUserId);
      const next: TelegramUserRecord = {
        telegramUserId,
        usernameLower: usernameLower ?? prev?.usernameLower,
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
  };
}

describe("apps/server Phase 0 + Phase 1 endpoints", () => {
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
      payloadJson: JSON.stringify({ challenge, message }),
      hmacSig,
      chatId: "5551234",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    // Tampered signature must fail with 401
    const badRes = await app.request(
      `/v1/intents/${intentId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: hmacSig,
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
    const app = createApp({
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

    // Phase 2 OpenZeppelin Channels relay proxy
    const relayRes = await app.request(
      "/v1/relay/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "feebump",
          signedTxXdrBase64: "AAAAAgAAAABex3TestXdrPayloadBase64String==",
        }),
      },
      {
        ...TEST_ENV,
        OZ_CHANNELS_API_URL: "https://channels.openzeppelin.com/testnet",
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

    // Valid shared secret header -> 200
    const secretRes = await app.request(
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
    expect(secretRes.status).toBe(200);
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
});
