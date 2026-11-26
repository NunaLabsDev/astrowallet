import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  rpc,
  type Horizon,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { ContractAddress } from "@astrowallet/domain";
import { createStellarClient } from "./client.js";

const ESCROW_CONTRACT = StrKey.encodeContract(new Uint8Array(32).fill(4)) as ContractAddress;

function buildSuccessSim(minResourceFee = "150000"): rpc.Api.SimulateTransactionSuccessResponse {
  const txData = new SorobanDataBuilder().build();
  return {
    id: "sim-1",
    latestLedger: 500,
    events: [],
    minResourceFee,
    transactionData: new SorobanDataBuilder(txData),
    result: {
      auth: [],
      retval: undefined as unknown as never,
    },
    _parsed: true,
  };
}

describe("StellarLedgerClient hardening (sequence mutex, restore guard, fee cap, sign-once)", () => {
  it("serializes concurrent classic submissions per source account via sequence queue mutex", async () => {
    const kp = Keypair.random();
    const order: string[] = [];
    let activeLoads = 0;
    let maxConcurrentLoads = 0;

    let releaseFirstSubmit!: () => void;
    const firstSubmitGate = new Promise<void>((resolve) => {
      releaseFirstSubmit = resolve;
    });
    let seq = 100n;
    let submitCount = 0;

    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      friendbotUrl: "https://friendbot.example",
      horizonServerFactory: () =>
        ({
          async loadAccount() {
            activeLoads += 1;
            maxConcurrentLoads = Math.max(maxConcurrentLoads, activeLoads);
            order.push(`load-${submitCount + 1}`);
            await new Promise((r) => setTimeout(r, 15));
            activeLoads -= 1;
            return new Account(kp.publicKey(), seq.toString());
          },
          async feeStats() {
            return { fee_charged: { p90: BASE_FEE } };
          },
          async submitTransaction() {
            submitCount += 1;
            const id = submitCount;
            order.push(`submit-start-${id}`);
            if (id === 1) {
              await firstSubmitGate;
            }
            seq += 1n;
            order.push(`submit-done-${id}`);
            return { hash: `${id}`.repeat(64), ledger: 100 + id };
          },
        }) as unknown as Horizon.Server,
    });

    const p1 = client.submitManageData({ sourceKeypair: kp, name: "k1", value: "v1" });
    const p2 = client.submitManageData({ sourceKeypair: kp, name: "k2", value: "v2" });

    // Give tx1 time to enter loadAccount + submitTransaction before releasing gate
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual(["load-1", "submit-start-1"]);
    releaseFirstSubmit();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.hash).toBe("1".repeat(64));
    expect(r2.hash).toBe("2".repeat(64));
    expect(maxConcurrentLoads).toBe(1);
    expect(order).toEqual([
      "load-1",
      "submit-start-1",
      "submit-done-1",
      "load-2",
      "submit-start-2",
      "submit-done-2",
    ]);
  });

  it("auto-restores archived Soroban state via restoreFootprint before submitting main operation, and enforces restore fee cap", async () => {
    const kp = Keypair.random();
    const simRestore = {
      ...buildSuccessSim("150000"),
      restorePreamble: {
        minResourceFee: "50000",
        transactionData: new SorobanDataBuilder(),
      },
    } as unknown as rpc.Api.SimulateTransactionRestoreResponse;

    let simCalls = 0;
    let sendCalls = 0;
    const sentHashes: string[] = [];

    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanPollIntervalMs: 0,
      rpcServerFactory: () =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), String(10 + sendCalls));
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "250" } };
          },
          async simulateTransaction() {
            simCalls += 1;
            return simCalls === 1 ? simRestore : buildSuccessSim("150000");
          },
          async sendTransaction() {
            sendCalls += 1;
            const hash = (sendCalls === 1 ? "r" : "m").repeat(64);
            sentHashes.push(hash);
            return { status: "PENDING", hash };
          },
          async getTransaction(hash: string) {
            return {
              status: rpc.Api.GetTransactionStatus.SUCCESS,
              ledger: hash.startsWith("r") ? 501 : 502,
            };
          },
        }) as unknown as rpc.Server,
    });

    const result = await client.fundClaimEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "aa".repeat(32),
      amount: "5",
      assetCode: "XLM",
      expiresAtUnix: 1_900_000_000,
    });
    expect(simCalls).toBe(2);
    expect(sendCalls).toBe(2);
    expect(sentHashes).toEqual(["r".repeat(64), "m".repeat(64)]);
    expect(result).toMatchObject({ hash: "m".repeat(64), ledger: 502 });

    // Restore fee exceeding cap must fail closed without sending any transaction
    let cappedSendCalled = false;
    const expensiveRestore = {
      ...buildSuccessSim("150000"),
      restorePreamble: {
        minResourceFee: "300000",
        transactionData: new SorobanDataBuilder(),
      },
    } as unknown as rpc.Api.SimulateTransactionRestoreResponse;
    const cappedClient = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanMaxResourceFeeStroops: "200000",
      sorobanPollIntervalMs: 0,
      rpcServerFactory: () =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "250" } };
          },
          async simulateTransaction() {
            return expensiveRestore;
          },
          async sendTransaction() {
            cappedSendCalled = true;
            throw new Error("should not send");
          },
        }) as unknown as rpc.Server,
    });

    await expect(
      cappedClient.fundClaimEscrow({
        sourceKeypair: kp,
        escrowContractId: ESCROW_CONTRACT,
        claimIdHex: "bb".repeat(32),
        amount: "5",
        assetCode: "XLM",
        expiresAtUnix: 1_900_000_000,
      }),
    ).rejects.toThrow(/restore fee .* exceeds limit/i);
    expect(cappedSendCalled).toBe(false);
  });

  it("rejects Soroban submissions whose minResourceFee exceeds configured cap", async () => {
    const kp = Keypair.random();
    let sendCalled = false;

    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanMaxResourceFeeStroops: "200000",
      sorobanPollIntervalMs: 0,
      rpcServerFactory: () =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "200" } };
          },
          async simulateTransaction() {
            return buildSuccessSim("250001");
          },
          async sendTransaction() {
            sendCalled = true;
            throw new Error("should not reach sendTransaction");
          },
        }) as unknown as rpc.Server,
    });

    await expect(
      client.fundClaimEscrow({
        sourceKeypair: kp,
        escrowContractId: ESCROW_CONTRACT,
        claimIdHex: "bb".repeat(32),
        amount: "5",
        assetCode: "XLM",
        expiresAtUnix: 1_900_000_000,
      }),
    ).rejects.toThrow(/exceeds limit/i);
    expect(sendCalled).toBe(false);
  });

  it("assembles and signs once before RPC failover broadcast and rejects FAILED status", async () => {
    const kp = Keypair.random();
    let simulateCalls = 0;
    const sentXdrs: string[] = [];

    const clientFailover = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example", "https://rpc-2.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanPollIntervalMs: 0,
      rpcServerFactory: (url) =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "500" } };
          },
          async simulateTransaction() {
            simulateCalls += 1;
            return buildSuccessSim("120000");
          },
          async sendTransaction(tx: { toXDR(): string }) {
            sentXdrs.push(tx.toXDR());
            if (url.includes("rpc-1")) {
              throw new Error("Transient RPC-1 failure");
            }
            return { status: "PENDING", hash: "e".repeat(64), latestLedger: 700 };
          },
          async getTransaction() {
            return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 701 };
          },
        }) as unknown as rpc.Server,
    });

    const ok = await clientFailover.fundClaimEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "cc".repeat(32),
      amount: "5",
      assetCode: "XLM",
      expiresAtUnix: 1_900_000_000,
      cancellable: false,
    });

    expect(ok.hash).toBe("e".repeat(64));
    expect(ok.ledger).toBe(701);
    expect(simulateCalls).toBe(1);
    expect(sentXdrs).toHaveLength(2);
    expect(sentXdrs[0]).toBe(sentXdrs[1]);

    const clientFailed = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanPollIntervalMs: 0,
      rpcServerFactory: () =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "500" } };
          },
          async simulateTransaction() {
            return buildSuccessSim("120000");
          },
          async sendTransaction() {
            return { status: "PENDING", hash: "f".repeat(64), latestLedger: 700 };
          },
          async getTransaction() {
            return { status: rpc.Api.GetTransactionStatus.FAILED, ledger: 702 };
          },
        }) as unknown as rpc.Server,
    });

    await expect(
      clientFailed.fundClaimEscrow({
        sourceKeypair: kp,
        escrowContractId: ESCROW_CONTRACT,
        claimIdHex: "dd".repeat(32),
        amount: "5",
        assetCode: "XLM",
        expiresAtUnix: 1_900_000_000,
      }),
    ).rejects.toThrow(/failed on ledger/i);
  });

  it("supports cancelClaimEscrow, refundExpiredClaimEscrow, extendClaimEscrowTtl, and relaySubmitter fallback", async () => {
    const kp = Keypair.random();
    const recipient = Keypair.random().publicKey() as `${"G"}${string}`;
    const relaySeen: Array<{ xdr: string; intentAuth?: { intentId: string; sig: string } }> = [];
    let rpcSendCount = 0;
    let relayShouldFail = false;

    const client = createStellarClient({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrls: ["https://horizon-1.example"],
      rpcUrls: ["https://rpc-1.example"],
      friendbotUrl: "https://friendbot.example",
      sorobanPollIntervalMs: 0,
      relaySubmitter: async ({ signedTxXdrBase64, intentAuth }) => {
        relaySeen.push({ xdr: signedTxXdrBase64, intentAuth });
        if (relayShouldFail) {
          throw new Error("Relayer 503");
        }
        return { hash: "a".repeat(64) };
      },
      rpcServerFactory: () =>
        ({
          async getAccount() {
            return new Account(kp.publicKey(), "10");
          },
          async getFeeStats() {
            return { sorobanInclusionFee: { p90: "300" } };
          },
          async simulateTransaction() {
            return buildSuccessSim("100000");
          },
          async sendTransaction() {
            rpcSendCount += 1;
            return { status: "PENDING", hash: "b".repeat(64), latestLedger: 810 };
          },
          async getTransaction(hash: string) {
            return {
              status: rpc.Api.GetTransactionStatus.SUCCESS,
              ledger: hash === "a".repeat(64) ? 801 : 811,
            };
          },
        }) as unknown as rpc.Server,
    });

    const cancelled = await client.cancelClaimEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "11".repeat(32),
    });
    expect(cancelled).toEqual({ hash: "a".repeat(64), ledger: 801 });
    expect(rpcSendCount).toBe(0);
    expect(relaySeen).toHaveLength(1);

    const claimAuth = { intentId: "intent_12345678", sig: "ab".repeat(32) };
    const claimedWithIntent = await client.claimFromEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "55".repeat(32),
      claimSecretSeedHex: "07".repeat(32),
      intentAuth: claimAuth,
    });
    expect(claimedWithIntent).toEqual({ hash: "a".repeat(64), ledger: 801 });
    expect(relaySeen[1]?.intentAuth).toEqual(claimAuth);

    const refundedDirect = await client.refundExpiredClaimEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "22".repeat(32),
    });
    expect(refundedDirect.hash).toBe("a".repeat(64));

    relayShouldFail = true;
    const refundedToFallback = await client.refundExpiredClaimEscrow({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "33".repeat(32),
      recipientAddress: recipient,
    });
    expect(refundedToFallback).toEqual({ hash: "b".repeat(64), ledger: 811 });
    expect(rpcSendCount).toBe(1);

    const extended = await client.extendClaimEscrowTtl({
      sourceKeypair: kp,
      escrowContractId: ESCROW_CONTRACT,
      claimIdHex: "44".repeat(32),
    });
    expect(extended.hash).toBe("b".repeat(64));
    expect(rpcSendCount).toBe(2);
  });
});
