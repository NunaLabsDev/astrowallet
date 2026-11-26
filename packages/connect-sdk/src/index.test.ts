import { describe, expect, it, vi } from "vitest";
import {
  AstroConnectError,
  buildAstroWalletIntentDeepLink,
  buildAstroWalletOnboardingDeepLink,
  buildCanonicalIntentMessage,
  buildCrossAppIntentEnvelope,
  createAstroConnectClient,
  createAstroWalletKitModule,
  decodeStellarClassicPublicKey,
  signIntentToken,
  verifyAstroLoginProof,
  verifyIntentToken,
  verifySep53Signature,
} from "./index.js";

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

function encodeClassicStrKey(pubKey: Uint8Array): string {
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
  return out;
}

async function generateSigner() {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  };
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

describe("@astrowallet/connect SDK", () => {
  it("decodes StrKey and verifies SEP-53 login proofs offline", async () => {
    const signer = await generateSigner();
    expect(decodeStellarClassicPublicKey(signer.address).length).toBe(32);

    const now = Math.floor(Date.now() / 1000);
    const challengeMessage = [
      "AstroConnect Sign-In v1",
      "App: StellarPerps (@StellarPerpsBot)",
      "Network: testnet",
      "Request ID: ac_112233445566",
      "Nonce: nonce_12345678",
      `Issued At: ${now}`,
      `Expires At: ${now + 300}`,
      "Domain: perps.example",
    ].join("\n");

    const signatureBase64 = await signer.signSep53(challengeMessage);
    expect(
      await verifySep53Signature({
        address: signer.address,
        message: challengeMessage,
        signatureBase64,
      }),
    ).toBe(true);

    const validProof = await verifyAstroLoginProof(
      {
        address: signer.address,
        network: "testnet",
        challengeMessage,
        signatureBase64,
      },
      {
        network: "testnet",
        botUsername: "@StellarPerpsBot",
        nonce: "nonce_12345678",
        domain: "perps.example",
        nowUnixSeconds: now + 10,
      },
    );
    expect(validProof).toEqual({ valid: true });

    const expiredProof = await verifyAstroLoginProof(
      {
        address: signer.address,
        network: "testnet",
        challengeMessage,
        signatureBase64,
      },
      { nowUnixSeconds: now + 400 },
    );
    expect(expiredProof.valid).toBe(false);

    // Rejects spoofed (@BotName) embedded in app name when trailing bot suffix differs
    const spoofedChallenge = [
      "AstroConnect Sign-In v1",
      "App: Fake (@AstroDexBot) (@AttackerBot)",
      "Network: testnet",
      "Request ID: ac_spoof_01",
      "Nonce: nonce_12345678",
      `Issued At: ${now}`,
      `Expires At: ${now + 300}`,
    ].join("\n");
    const spoofedSig = await signer.signSep53(spoofedChallenge);
    const spoofResult = await verifyAstroLoginProof(
      {
        address: signer.address,
        network: "testnet",
        challengeMessage: spoofedChallenge,
        signatureBase64: spoofedSig,
      },
      { network: "testnet", botUsername: "AstroDexBot", nowUnixSeconds: now + 5 },
    );
    expect(spoofResult.valid).toBe(false);
  });

  it("handles login, signTransaction, rejection, and StellarWalletsKit adapter", async () => {
    const signer = await generateSigner();
    const openedLinks: string[] = [];
    let pollCount = 0;

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/connect/requests") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; payload: { nonce?: string } };
        if (body.action === "auth") {
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "ac_auth00112233",
              network: "testnet",
              action: "auth",
              trustTier: "external",
              sig: "a".repeat(32),
              resultToken: "rt_secret",
              expiresAt: Math.floor(Date.now() / 1000) + 300,
              deepLink: "https://t.me/AstroWalletAppBot/wallet?startapp=c-ac_auth00112233-aaaa",
              challengeMessage: `AstroConnect Sign-In v1\nApp: Demo (@DemoBot)\nNetwork: testnet\nRequest ID: ac_auth00112233\nNonce: ${body.payload.nonce}\nIssued At: 1700000000\nExpires At: 1999999999`,
            }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "ac_xdr00112233",
            network: "testnet",
            action: "sign_xdr",
            trustTier: "external",
            sig: "b".repeat(32),
            resultToken: "rt_secret_xdr",
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            deepLink: "https://t.me/AstroWalletAppBot/wallet?startapp=c-ac_xdr00112233-bbbb",
          }),
          { status: 201 },
        );
      }

      if (url.includes("/v1/connect/requests/ac_auth00112233")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "ac_auth00112233",
              network: "testnet",
              action: "auth",
              status: "pending",
              trustTier: "external",
              expiresAt: 1999999999,
            }),
            { status: 200 },
          );
        }
        const challenge = "AstroConnect Sign-In v1\nApp: Demo (@DemoBot)\nNetwork: testnet\nRequest ID: ac_auth00112233\nNonce: fixednonce1\nIssued At: 1700000000\nExpires At: 1999999999";
        const signatureBase64 = await signer.signSep53(challenge);
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "ac_auth00112233",
            network: "testnet",
            action: "auth",
            status: "approved",
            trustTier: "external",
            expiresAt: 1999999999,
            result: {
              status: "approved",
              address: signer.address,
              accounts: [{ address: signer.address, kind: "classic", label: "Primary", isDefault: true }],
              signedMessage: challenge,
              signatureBase64,
              completedAt: 1700000005,
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/v1/connect/requests/ac_xdr00112233")) {
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "ac_xdr00112233",
            network: "testnet",
            action: "sign_xdr",
            status: "rejected",
            trustTier: "external",
            expiresAt: 1999999999,
            result: {
              status: "rejected",
              reason: "User rejected in AstroWallet",
              completedAt: 1700000010,
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/v1/identity/resolve")) {
        return new Response(
          JSON.stringify({
            ok: true,
            found: true,
            telegramUserId: "42",
            username: "alice",
            primaryAddress: signer.address,
            accounts: [{ address: signer.address, kind: "classic", label: "Primary", isDefault: true }],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    const client = createAstroConnectClient({
      apiBaseUrl: "https://wallet.example",
      app: { name: "Demo", botUsername: "DemoBot", miniAppShortName: "app" },
      fetchFn: mockFetch,
      openLinkFn: (link) => openedLinks.push(link),
    });

    const login = await client.login({ nonce: "fixednonce1", pollIntervalMs: 1 });
    expect(login.address).toBe(signer.address);
    expect(openedLinks[0]).toContain("startapp=c-ac_auth00112233-");

    const identity = await client.resolveIdentity("@alice");
    expect(identity.found).toBe(true);
    expect(identity.primaryAddress).toBe(signer.address);

    await expect(
      client.signTransaction("AAAAAg==", {
        humanSummary: "Swap 10 XLM",
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(AstroConnectError);

    const kitModule = createAstroWalletKitModule({
      apiBaseUrl: "https://wallet.example",
      app: { name: "Demo", botUsername: "DemoBot" },
      defaultIdentityQuery: "@alice",
      fetchFn: mockFetch,
      openLinkFn: (link) => openedLinks.push(link),
    });
    expect(await kitModule.isAvailable()).toBe(true);
    expect(await kitModule.getAddress()).toEqual({ address: signer.address });
  });

  it("supports v0.2.0 intent tokens, envelope hashing, resolveTelegramIdentity, scanTarget, and proxy prefix", async () => {
    const secret = "s".repeat(32);
    const now = 1_700_000_000;
    const claims = {
      intentId: "int_12345678",
      network: "testnet" as const,
      telegramUserId: "998877",
      expiresAt: now + 300,
    };
    expect(buildCanonicalIntentMessage(claims)).toBe("testnet:int_12345678:998877:1700000300");
    const sig = await signIntentToken(claims, secret);
    expect(await verifyIntentToken(claims, sig, secret, now + 10)).toEqual({ valid: true });
    expect(await verifyIntentToken(claims, sig, secret, now + 400)).toEqual({
      valid: false,
      reason: "expired",
    });

    const envelope = await buildCrossAppIntentEnvelope({
      originApp: "external_dapp",
      subAction: "custom_call",
      humanSummary: "Execute contract call",
      unsignedXdr: "AAAAAg==",
    });
    expect(envelope.xdrSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      buildAstroWalletIntentDeepLink({
        astroWalletBotUsername: "@AstroWalletAppBot",
        astroWalletMiniAppShortName: "wallet",
        intentId: "int_12345678",
        sig,
      }),
    ).toBe(`https://t.me/AstroWalletAppBot/wallet?startapp=i-int_12345678-${sig}`);
    expect(
      buildAstroWalletOnboardingDeepLink({
        astroWalletBotUsername: "AstroWalletAppBot",
        astroWalletMiniAppShortName: "wallet",
      }),
    ).toBe("https://t.me/AstroWalletAppBot/wallet?startapp=t-vault");

    const signer = await generateSigner();
    const calls: string[] = [];
    const proxyClient = createAstroConnectClient({
      apiBaseUrl: "",
      requestsPathPrefix: "/api/v1/wallet/connect/requests",
      app: { name: "ProxyApp", botUsername: "ProxyAppBot" },
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("/v1/identity/resolve?q=998877")) {
          return new Response(JSON.stringify({ ok: true, found: false, accounts: [] }), {
            status: 200,
          });
        }
        if (url.startsWith("/v1/identity/resolve?q=alice")) {
          return new Response(
            JSON.stringify({
              ok: true,
              found: true,
              primaryAddress: signer.address,
              accounts: [{ address: signer.address, kind: "classic", label: "Primary", isDefault: true }],
            }),
            { status: 200 },
          );
        }
        if (url === "/v1/connect/scan") {
          return new Response(
            JSON.stringify({ report: { verdict: "safe", findings: [] } }),
            { status: 200 },
          );
        }
        if (url === "/api/v1/wallet/connect/requests" && init?.method === "POST") {
          const parsed = JSON.parse(String(init.body)) as { payload: { sourceAddress?: string } };
          expect(parsed.payload.sourceAddress).toBe(signer.address);
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "ac_proxy1",
              network: "testnet",
              action: "sign_xdr",
              trustTier: "external",
              sig: "c".repeat(32),
              resultToken: "rt_proxy",
              expiresAt: now + 300,
              deepLink: "https://t.me/AstroWalletAppBot/wallet?startapp=c-ac_proxy1-cccc",
            }),
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
      openLinkFn: () => undefined,
    });

    const resolved = await proxyClient.resolveTelegramIdentity({ id: 998877, username: "@alice" });
    expect(resolved?.primaryAddress).toBe(signer.address);
    const scan = await proxyClient.scanTarget(signer.address);
    expect(scan.verdict).toBe("safe");
    const handle = await proxyClient.createSignTransactionRequest("AAAAAg==", {
      humanSummary: "Test proxy",
      sourceAddress: signer.address,
    });
    expect(handle.requestId).toBe("ac_proxy1");
    expect(calls).toContain("/api/v1/wallet/connect/requests");
  });

  it("propagates X-Astro-Network across all HTTP calls and supports benign scan verdict", async () => {
    const seenHeaders: Array<{ url: string; network: string | null }> = [];
    const client = createAstroConnectClient({
      apiBaseUrl: "https://wallet.example.org",
      network: "testnet",
      app: { name: "DexApp", botUsername: "DexAppBot" },
      fetchFn: async (input, init) => {
        const url = String(input);
        const h = new Headers(init?.headers);
        seenHeaders.push({ url, network: h.get("X-Astro-Network") });
        if (url.endsWith("/v1/connect/requests") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "ac_net1",
              network: "testnet",
              action: "auth",
              trustTier: "verified",
              sig: "d".repeat(32),
              resultToken: "rt_net1",
              expiresAt: Math.floor(Date.now() / 1000) + 300,
              deepLink: "https://t.me/AstroWalletAppBot/wallet?startapp=c-ac_net1-dddd",
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/v1/connect/requests/ac_net1")) {
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "ac_net1",
              network: "testnet",
              action: "auth",
              status: "pending",
              trustTier: "verified",
              expiresAt: Math.floor(Date.now() / 1000) + 300,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/v1/identity/resolve")) {
          return new Response(JSON.stringify({ found: false, accounts: [] }), { status: 200 });
        }
        if (url.endsWith("/v1/connect/scan")) {
          return new Response(
            JSON.stringify({
              report: {
                verdict: "benign",
                findings: [
                  {
                    code: "OK",
                    severity: "benign",
                    title: "Clean",
                    description: "No risks detected",
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
      openLinkFn: () => undefined,
    });

    await client.createLoginRequest();
    await client.getRequestStatus("ac_net1", "rt_net1");
    await client.resolveIdentity("alice");
    const report = await client.scanTarget("G" + "A".repeat(55));
    expect(report.verdict).toBe("benign");
    expect(report.findings[0]?.severity).toBe("benign");
    expect(seenHeaders).toHaveLength(4);
    expect(seenHeaders.every((entry) => entry.network === "testnet")).toBe(true);
  });
});
