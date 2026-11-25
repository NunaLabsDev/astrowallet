import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildCancelClaimOperation,
  buildCancelClaimToOperation,
  buildClaimEscrowSignPayload,
  buildClaimOperation,
  buildCreateClaimOperation,
  buildExtendClaimTtlOperation,
  buildRefundExpiredOperation,
  buildRefundExpiredToOperation,
  generateEphemeralClaimKey,
  signClaimEscrowPayload,
} from "./index.js";

const ESCROW_ZERO = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4" as ContractAddress;
const RECIPIENT_ZERO = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" as ClassicAddress;
const TOKEN_SAC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM" as ContractAddress;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

describe("Claim Escrow V2 Ephemeral Ed25519 Contract Helpers", () => {
  it("matches exact Rust soroban-sdk XDR byte layout for AW_CLAIM_V2 payload", () => {
    const claimIdHex = "01".repeat(32);
    const payload = buildClaimEscrowSignPayload(ESCROW_ZERO, claimIdHex, RECIPIENT_ZERO);
    expect(payload.length).toBe(128);
    expect(new TextDecoder().decode(payload.slice(0, 12))).toBe("AW_CLAIM_V2:");
    expect(Array.from(payload.slice(12, 20))).toEqual([0, 0, 0, 18, 0, 0, 0, 1]);
    expect(Array.from(payload.slice(20, 52))).toEqual(new Array(32).fill(0));
    expect(Array.from(payload.slice(52, 84))).toEqual(new Array(32).fill(1));
    expect(Array.from(payload.slice(84, 92))).toEqual([0, 0, 0, 18, 0, 0, 0, 0]);
    expect(Array.from(payload.slice(92, 128))).toEqual(new Array(36).fill(0));
  });

  it("signs and verifies ephemeral claim authorization bound strictly to recipient", () => {
    const ephemeral = generateEphemeralClaimKey();
    const claimIdHex = "ab".repeat(32);
    const recipient = Keypair.random().publicKey() as ClassicAddress;
    const attacker = Keypair.random().publicKey() as ClassicAddress;

    const sigHex = signClaimEscrowPayload(
      ephemeral.secretSeedHex,
      ESCROW_ZERO,
      claimIdHex,
      recipient,
    );
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/);

    const verifierKp = Keypair.fromRawEd25519Seed(
      hexToBytes(ephemeral.secretSeedHex),
    );
    const expectedPayload = buildClaimEscrowSignPayload(ESCROW_ZERO, claimIdHex, recipient);
    const wrongRecipientPayload = buildClaimEscrowSignPayload(
      ESCROW_ZERO,
      claimIdHex,
      attacker,
    );

    expect(
      verifierKp.verify(
        expectedPayload,
        hexToBytes(sigHex),
      ),
    ).toBe(true);
    expect(
      verifierKp.verify(
        wrongRecipientPayload,
        hexToBytes(sigHex),
      ),
    ).toBe(false);
  });

  it("builds create_claim, claim, cancel_claim, and refund_expired Soroban operations", () => {
    const ephemeral = generateEphemeralClaimKey();
    const claimIdHex = "cd".repeat(32);
    const sigHex = signClaimEscrowPayload(
      ephemeral.secretSeedHex,
      ESCROW_ZERO,
      claimIdHex,
      RECIPIENT_ZERO,
    );

    const createOp = buildCreateClaimOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
      senderAddress: RECIPIENT_ZERO,
      tokenContractId: TOKEN_SAC,
      amountStroops: 100_000_000n,
      claimPubkeyHex: ephemeral.publicKeyHex,
      expiresAtUnix: 1_900_000_000,
      cancellable: false,
    });
    const claimOp = buildClaimOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
      recipientAddress: RECIPIENT_ZERO,
      signatureHex: sigHex,
    });
    const cancelOp = buildCancelClaimOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
    });
    const cancelToOp = buildCancelClaimToOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
      recipientAddress: RECIPIENT_ZERO,
    });
    const refundOp = buildRefundExpiredOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
    });
    const refundToOp = buildRefundExpiredToOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
      recipientAddress: RECIPIENT_ZERO,
    });
    const extendTtlOp = buildExtendClaimTtlOperation({
      escrowContractId: ESCROW_ZERO,
      claimIdHex,
    });

    expect(createOp.body.type).toBe("invokeHostFunction");
    const invokeFn = createOp.body.invokeHostFunctionOp.hostFunction;
    if (invokeFn.type === "hostFunctionTypeInvokeContract") {
      expect(invokeFn.invokeContract.args).toHaveLength(7);
      expect(invokeFn.invokeContract.args[6]?.type).toBe("scvBool");
    }
    expect(claimOp.body.type).toBe("invokeHostFunction");
    expect(cancelOp.body.type).toBe("invokeHostFunction");
    expect(cancelToOp.body.type).toBe("invokeHostFunction");
    expect(refundOp.body.type).toBe("invokeHostFunction");
    expect(refundToOp.body.type).toBe("invokeHostFunction");
    expect(extendTtlOp.body.type).toBe("invokeHostFunction");

    expect(() =>
      buildCreateClaimOperation({
        escrowContractId: ESCROW_ZERO,
        claimIdHex,
        senderAddress: RECIPIENT_ZERO,
        tokenContractId: TOKEN_SAC,
        amountStroops: 100n,
        claimPubkeyHex: "00".repeat(32),
        expiresAtUnix: 1_900_000_000,
      }),
    ).toThrow(/all-zero/);

    expect(() =>
      buildCreateClaimOperation({
        escrowContractId: ESCROW_ZERO,
        claimIdHex,
        senderAddress: RECIPIENT_ZERO,
        tokenContractId: TOKEN_SAC,
        amountStroops: 100n,
        claimPubkeyHex: ephemeral.publicKeyHex,
        expiresAtUnix: Number.NaN,
      }),
    ).toThrow(/expiresAtUnix/);

    expect(() =>
      buildCreateClaimOperation({
        escrowContractId: ESCROW_ZERO,
        claimIdHex,
        senderAddress: RECIPIENT_ZERO,
        tokenContractId: TOKEN_SAC,
        amountStroops: 100n,
        claimPubkeyHex: ephemeral.publicKeyHex,
        expiresAtUnix: 0,
      }),
    ).toThrow(/expiresAtUnix/);
  });
});
