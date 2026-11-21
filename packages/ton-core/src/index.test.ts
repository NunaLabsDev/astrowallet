import { Address } from "@ton/core";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  TonConnectCryptoSession,
  buildSignedTonTransfer,
  buildTonConnectErrorEvent,
  buildTonConnectEventsUrl,
  buildTonConnectSuccessEvent,
  buildTonProofSignatureMessage,
  createTonClient,
  deriveTonAccount,
  formatNanoTon,
  isValidTonAddress,
  parseTonConnectUri,
  parseTonToNano,
  signTonProof,
  validateTonConnectSendTxRequest,
} from "./index.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("@astrowallet/ton-core", () => {
  it("deterministically derives V4R2 and V5R1 accounts along m/44'/607'/index' and converts nanoTON", () => {
    const v4 = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v4r2");
    expect(v4.derivationPath).toBe("m/44'/607'/0'");
    expect(isValidTonAddress(v4.friendlyAddress)).toBe(true);
    expect(isValidTonAddress(v4.bounceableAddress)).toBe(true);
    expect(v4.rawAddress).toMatch(/^0:[a-f0-9]{64}$/);
    expect(v4.walletStateInitBase64.length).toBeGreaterThan(20);

    const v5 = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v5r1");
    expect(v5.publicKeyHex).toBe(v4.publicKeyHex);
    expect(v5.rawAddress).not.toBe(v4.rawAddress);

    expect(parseTonToNano("1.25")).toBe(1_250_000_000n);
    expect(formatNanoTon(1_250_000_000n)).toBe("1.25");
    expect(() => parseTonToNano("-1")).toThrow();
    expect(() => parseTonToNano("0")).toThrow();

    v4.zeroize();
    v5.zeroize();
  });

  it("builds valid signed external BOC transfers for V4R2 and V5R1", () => {
    const v4 = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v4r2");
    const dest = deriveTonAccount(TEST_MNEMONIC, 1, "testnet", "v4r2");

    const bocV4 = buildSignedTonTransfer({
      account: v4,
      seqno: 0,
      validUntil: 1_900_000_200,
      messages: [
        {
          destination: dest.friendlyAddress,
          amountNano: parseTonToNano("0.5"),
          comment: "AstroWallet TON Test",
        },
      ],
    });
    expect(bocV4.length).toBeGreaterThan(40);

    const v5 = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v5r1");
    const bocV5 = buildSignedTonTransfer({
      account: v5,
      seqno: 1,
      validUntil: 1_900_000_200,
      messages: [
        {
          destination: dest.bounceableAddress,
          amountNano: parseTonToNano("0.1"),
        },
      ],
    });
    expect(bocV5.length).toBeGreaterThan(40);

    v4.zeroize();
    v5.zeroize();
    dest.zeroize();
  });

  it("parses TON Connect URIs, encrypts/decrypts NaCl boxes, and verifies ton_proof signatures", () => {
    const dappId = "ab".repeat(32);
    const tcUri = `tc://?v=2&id=${dappId}&r=${encodeURIComponent(
      JSON.stringify({
        manifestUrl: "https://example.org/tonconnect-manifest.json",
        items: [{ name: "ton_addr" }, { name: "ton_proof", payload: "nonce-42" }],
      }),
    )}`;

    const parsed = parseTonConnectUri(tcUri);
    expect(parsed.version).toBe("2");
    expect(parsed.clientId).toBe(dappId);
    expect(parsed.items).toHaveLength(2);

    const walletSess = new TonConnectCryptoSession();
    const dappKeys = nacl.box.keyPair();
    const dappPubHex = Buffer.from(dappKeys.publicKey).toString("hex");
    const dappSess = new TonConnectCryptoSession(Buffer.from(dappKeys.secretKey).toString("hex"));

    const sealed = walletSess.encrypt('{"ok":true}', dappPubHex);
    expect(dappSess.decrypt(sealed, walletSess.clientId)).toBe('{"ok":true}');
    expect(() => dappSess.decrypt("AA==", walletSess.clientId)).toThrow();

    const account = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v4r2");
    const sigB64 = signTonProof({
      rawAddress: account.rawAddress,
      domain: "example.org",
      timestamp: 1_900_000_000,
      payload: "nonce-42",
      secretKey: account.secretKey,
    });
    const digest = buildTonProofSignatureMessage({
      rawAddress: account.rawAddress,
      domain: "example.org",
      timestamp: 1_900_000_000,
      payload: "nonce-42",
    });
    const verified = nacl.sign.detached.verify(
      digest,
      Buffer.from(sigB64, "base64"),
      Buffer.from(account.publicKeyHex, "hex"),
    );
    expect(verified).toBe(true);

    const connectJson = JSON.parse(
      buildTonConnectSuccessEvent({
        rawAddress: account.rawAddress,
        network: "testnet",
        walletStateInitBase64: account.walletStateInitBase64,
        publicKeyHex: account.publicKeyHex,
        tonProof: {
          timestamp: 1_900_000_000,
          domain: "example.org",
          payload: "nonce-42",
          signatureBase64: sigB64,
        },
      }),
    ) as { event: string; payload: { items: Array<{ name: string }> } };
    expect(connectJson.event).toBe("connect");
    expect(connectJson.payload.items).toHaveLength(2);
    expect(buildTonConnectErrorEvent(300, "User rejected")).toContain("connect_error");
    expect(buildTonConnectEventsUrl("https://bridge.example.org", [walletSess.clientId])).toContain(
      `client_id=${walletSess.clientId}`,
    );

    account.zeroize();
  });

  it("validates TON Connect sendTransaction constraints and supports RPC failover", async () => {
    const dest = deriveTonAccount(TEST_MNEMONIC, 1, "testnet", "v4r2");
    const now = 1_900_000_000;

    expect(
      validateTonConnectSendTxRequest(
        {
          id: "1",
          validUntil: now + 60,
          network: "-3",
          messages: [{ address: dest.friendlyAddress, amount: "100000000" }],
        },
        "testnet",
        now,
      ).ok,
    ).toBe(true);

    expect(
      validateTonConnectSendTxRequest(
        {
          id: "2",
          validUntil: now - 1,
          network: "-3",
          messages: [{ address: dest.friendlyAddress, amount: "100000000" }],
        },
        "testnet",
        now,
      ),
    ).toMatchObject({ ok: false, code: 1 });

    expect(
      validateTonConnectSendTxRequest(
        {
          id: "3",
          validUntil: now + 60,
          network: "-239",
          messages: [{ address: dest.friendlyAddress, amount: "100000000" }],
        },
        "testnet",
        now,
      ),
    ).toMatchObject({ ok: false, code: 1 });

    let primaryCalls = 0;
    const client = createTonClient({
      network: "testnet",
      rpcUrls: ["https://primary.rpc.example/jsonRPC", "https://backup.rpc.example/jsonRPC"],
      fetchFn: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (String(url).includes("primary.rpc.example")) {
          primaryCalls += 1;
          return new Response("down", { status: 503 });
        }
        if (body.method === "getAddressInformation") {
          return new Response(
            JSON.stringify({ ok: true, result: { balance: "2500000000", state: "active" } }),
          );
        }
        if (body.method === "runGetMethod") {
          return new Response(
            JSON.stringify({ ok: true, result: { exit_code: 0, stack: [["num", "0x3"]] } }),
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { hash: "tonhash123" } }));
      },
    });

    const state = await client.getAccountState(dest.friendlyAddress);
    expect(primaryCalls).toBe(2);
    expect(state.balanceTon).toBe("2.5");
    expect(state.seqno).toBe(3);

    const src = deriveTonAccount(TEST_MNEMONIC, 0, "testnet", "v4r2");
    expect(Address.parse(src.friendlyAddress).toRawString()).toBe(src.rawAddress);
    const sent = await client.sendTonTransfer({
      account: src,
      destination: dest.friendlyAddress,
      amountTon: "0.25",
    });
    expect(sent.hash).toBe("tonhash123");

    src.zeroize();
    dest.zeroize();
  });
});
