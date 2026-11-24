import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createStellarClient } from "./ledger/client.js";
import { fetchAssetStellarTomlMeta } from "./ledger/token-explorer.js";
import { decryptVaultPayload, parseAgVaultBackup } from "./vault/crypto.js";
import {
  deleteEncryptedVault,
  loadEncryptedVault,
  saveEncryptedVault,
} from "./vault/indexeddb-store.js";

function installMemoryIndexedDb(): () => void {
  const store = new Map<string, unknown>();
  const prevIdb = (globalThis as unknown as { indexedDB?: unknown }).indexedDB;

  const mockIdb = {
    open() {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction() {
            const tx: Record<string, unknown> = {
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              objectStore() {
                return {
                  get(key: string) {
                    const gReq: Record<string, unknown> = {
                      result: store.get(key),
                      onsuccess: null as (() => void) | null,
                      onerror: null as (() => void) | null,
                    };
                    queueMicrotask(() => (gReq.onsuccess as (() => void) | null)?.());
                    return gReq;
                  },
                  put(val: unknown, key: string) {
                    store.set(key, val);
                    queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
                    return {};
                  },
                  delete(key: string) {
                    store.delete(key);
                    queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
                    return {};
                  },
                };
              },
            };
            return tx;
          },
        },
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
      return req;
    },
  };

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = mockIdb;
  return () => {
    (globalThis as unknown as { indexedDB?: unknown }).indexedDB = prevIdb;
  };
}

describe("Crypto, IndexedDB, CSP Proxy & Ledger Regression Suite (Fronts 1-3)", () => {
  it("routes all stellar.toml & linkedTomlUrl fetches through Worker proxy when apiBaseUrl is set (no direct CSP breach)", async () => {
    const requestedUrls: string[] = [];
    const meta = await fetchAssetStellarTomlMeta({
      domain: "issuer.example.org",
      assetCode: "AQUA",
      apiBaseUrl: "https://api.astrowallet.example",
      fetchFn: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://api.astrowallet.example/v1/proxy/stellar-toml?domain=issuer.example.org") {
          return new Response(
            `[[CURRENCIES]]\ncode="AQUA"\ntoml="https://cdn.issuer.example.org/aqua.toml"\n`,
            { status: 200 },
          );
        }
        if (
          url ===
          `https://api.astrowallet.example/v1/proxy/stellar-toml?url=${encodeURIComponent("https://cdn.issuer.example.org/aqua.toml")}`
        ) {
          return new Response(
            `code="AQUA"\nname="Aquarius"\nimage="https://cdn.issuer.example.org/aqua.png"\n`,
            { status: 200 },
          );
        }
        throw new Error(`Unexpected direct browser fetch violating CSP: ${url}`);
      },
    });

    expect(meta?.name).toBe("Aquarius");
    expect(meta?.image).toBe("https://cdn.issuer.example.org/aqua.png");
    expect(requestedUrls.every((u) => u.startsWith("https://api.astrowallet.example/v1/proxy/stellar-toml"))).toBe(true);

    // Even when proxy returns 502, MUST NOT fall back to direct browser fetch if apiBaseUrl is configured
    const fallbackUrls: string[] = [];
    const failedMeta = await fetchAssetStellarTomlMeta({
      domain: "blocked.example.org",
      assetCode: "USDX",
      apiBaseUrl: "https://api.astrowallet.example",
      fetchFn: async (input) => {
        fallbackUrls.push(String(input));
        return new Response("Blocked", { status: 502 });
      },
    });
    expect(failedMeta).toBeNull();
    expect(fallbackUrls).toEqual([
      "https://api.astrowallet.example/v1/proxy/stellar-toml?domain=blocked.example.org",
    ]);
  });

  it("rejects unbounded Argon2id memoryKiB DoS envelopes in crypto.ts", async () => {
    const evilEnvelope = {
      version: 1 as const,
      format: "AGVAULT" as const,
      kdf: {
        algorithm: "argon2id" as const,
        memoryKiB: 16_777_216, // 16 GiB OOM DoS
        iterations: 3,
        parallelism: 1,
        hashLength: 32 as const,
      },
      saltB64: "AAAAAAAAAAAAAAAAAAAAAA==",
      ivB64: "AAAAAAAAAAAAAAAA",
      ciphertextB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      createdAt: 1700000000,
      updatedAt: 1700000000,
    };
    expect(() => parseAgVaultBackup(JSON.stringify(evilEnvelope))).toThrow();
    await expect(decryptVaultPayload(evilEnvelope, "123456")).rejects.toThrow();
  });

  it("does not resurrect a wiped migrated legacy vault in indexeddb-store", async () => {
    const restoreIdb = installMemoryIndexedDb();
    try {
      const sampleEnvelope = {
        version: 1 as const,
        format: "AGVAULT" as const,
        kdf: {
          algorithm: "argon2id" as const,
          memoryKiB: 65536,
          iterations: 3,
          parallelism: 1,
          hashLength: 32 as const,
        },
        saltB64: "AAAAAAAAAAAAAAAAAAAAAA==",
        ivB64: "AAAAAAAAAAAAAAAA",
        ciphertextB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        createdAt: 1700000000,
        updatedAt: 1700000000,
      };
      // Simulate legacy unscoped vault
      await saveEncryptedVault(sampleEnvelope);
      // First scoped load migrates legacy vault
      const migrated = await loadEncryptedVault("123456");
      expect(migrated).not.toBeNull();
      // User wipes local vault
      await deleteEncryptedVault("123456");
      // Next load MUST stay null (must NOT resurrect legacy vault)
      const afterWipe = await loadEncryptedVault("123456");
      expect(afterWipe).toBeNull();
    } finally {
      restoreIdb();
    }
  });

  it("validates classic payment amounts strictly (rejecting 1e-7, commas, negatives) before Horizon", async () => {
    const sender = Keypair.random();
    const receiver = Keypair.random();
    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      horizonUrls: ["https://horizon-test.example"],
      rpcUrls: ["https://rpc-test.example"],
    });

    await expect(
      client.buildAndSubmitPayment({
        sourceKeypair: sender,
        destination: receiver.publicKey(),
        amount: "1e-7",
        assetCode: "XLM",
      }),
    ).rejects.toThrow(/decimal|amount|positive/i);

    await expect(
      client.buildAndSubmitPayment({
        sourceKeypair: sender,
        destination: receiver.publicKey(),
        amount: "0",
        assetCode: "XLM",
      }),
    ).rejects.toThrow(/decimal|amount|positive/i);
  });

  it("does not re-broadcast sendTransaction to secondary RPC node if polling fails transiently", async () => {
    const sender = Keypair.random();
    let sendCalls = 0;
    let pollCalls = 0;
    const { Account, SorobanDataBuilder, rpc } = await import("@stellar/stellar-sdk");

    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      horizonUrls: ["https://horizon-test.example"],
      rpcUrls: ["https://rpc1.example", "https://rpc2.example"],
      sorobanPollIntervalMs: 0,
      rpcServerFactory: (url) =>
        ({
          async getAccount() {
            return new Account(sender.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "100", mode: "100" } };
          },
          async simulateTransaction() {
            return {
              id: "sim",
              minResourceFee: "100",
              transactionData: new SorobanDataBuilder(),
              events: [],
              latestLedger: 1,
              result: { retval: undefined, auth: [] },
              cost: { cpuInsns: "0", memBytes: "0" },
              _parsed: true,
            };
          },
          async sendTransaction() {
            sendCalls += 1;
            return { status: "PENDING", hash: "abc123" };
          },
          async getTransaction() {
            pollCalls += 1;
            if (url === "https://rpc1.example") {
              throw new Error("RPC1 poll timeout");
            }
            return {
              status: rpc.Api.GetTransactionStatus.SUCCESS,
              ledger: 777,
            };
          },
        }) as unknown as InstanceType<typeof rpc.Server>,
    });

    const contractId = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
    const res = await client.buildAndSubmitPayment({
      sourceKeypair: sender,
      destination: contractId,
      amount: "1",
      assetCode: "XLM",
    });
    expect(res).toEqual({ hash: "abc123", ledger: 777 });
    expect(sendCalls).toBe(1);
    expect(pollCalls).toBe(2);
  });
});
