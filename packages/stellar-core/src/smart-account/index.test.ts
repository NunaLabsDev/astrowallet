import type { ClassicAddress } from "@astrowallet/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildDeploySmartAccountOperation,
  buildSacTransferOperation,
  buildUpdateContextRuleOperation,
  deriveCounterfactualSmartAccount,
  resolveSacContractId,
} from "./index.js";

const GUARDIAN_G =
  "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6" as const;
const SAMPLE_WASM_HASH = "a".repeat(64);
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

describe("Counterfactual Smart Account (C...) & 1-Tap SAC Bridge", () => {
  it("derives deterministic C... contract address bound to G... Recovery Guardian", () => {
    const sa1 = deriveCounterfactualSmartAccount({
      guardianAddress: GUARDIAN_G,
      wasmHashHex: SAMPLE_WASM_HASH,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const sa2 = deriveCounterfactualSmartAccount({
      guardianAddress: GUARDIAN_G,
      wasmHashHex: SAMPLE_WASM_HASH,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(sa1.contractAddress).toMatch(/^C[A-Z2-7]{55}$/);
    expect(sa1.contractAddress).toBe(sa2.contractAddress);
    expect(sa1.guardianAddress).toBe(GUARDIAN_G);
    expect(sa1.capabilities.supportsGaslessSoroban).toBe(true);
    expect(sa1.capabilities.canSignClassicSdex).toBe(false);

    // Verify exact Stellar CAP-46 HashIdPreimage parity
    const saltBytes = new Uint8Array(
      sa1.saltHex.match(/../g)!.map((h) => parseInt(h, 16)),
    );
    const networkId = sha256(new TextEncoder().encode(TESTNET_PASSPHRASE));
    const expectedPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: networkId,
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(GUARDIAN_G).toScAddress(),
            salt: saltBytes,
          }),
        ),
      }),
    );
    const expectedContractId = StrKey.encodeContract(
      sha256(expectedPreimage.toXDR()),
    );
    expect(sa1.contractAddress).toBe(expectedContractId);

    const deployOp = buildDeploySmartAccountOperation({
      guardianAddress: GUARDIAN_G,
      wasmHashHex: SAMPLE_WASM_HASH,
      saltHex: sa1.saltHex,
      constructorArgs: [new Address(GUARDIAN_G).toScVal()],
    });
    expect(deployOp.body.type).toBe("invokeHostFunction");

    expect(() =>
      buildDeploySmartAccountOperation({
        guardianAddress: GUARDIAN_G,
        wasmHashHex: SAMPLE_WASM_HASH,
        saltHex: sa1.saltHex,
        constructorArgs: [],
      }),
    ).toThrow(/constructorArgs must be non-empty/i);
  });

  it("resolves canonical SAC contract IDs and builds 1-tap G... <-> C... SAC transfers", () => {
    const xlmSac = resolveSacContractId({
      assetCode: "XLM",
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(xlmSac).toMatch(/^C[A-Z2-7]{55}$/);

    const sa = deriveCounterfactualSmartAccount({
      guardianAddress: GUARDIAN_G,
      wasmHashHex: SAMPLE_WASM_HASH,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    const op = buildSacTransferOperation({
      sacContractId: xlmSac,
      fromAddress: GUARDIAN_G,
      toAddress: sa.contractAddress,
      amountStroops: 100_000_000n,
    });
    expect(op).toBeDefined();
  });

  it("builds update_context_rule invocation and rejects invalid rule inputs", () => {
    const newGuardian = Keypair.random().publicKey() as ClassicAddress;
    const sa = deriveCounterfactualSmartAccount({
      guardianAddress: GUARDIAN_G,
      wasmHashHex: SAMPLE_WASM_HASH,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    const updateOp = buildUpdateContextRuleOperation({
      contractAddress: sa.contractAddress,
      contextRuleId: 0,
      name: "recovery",
      validUntil: 1_500_000,
      signers: [new Address(newGuardian).toScVal()],
      policies: [],
    });
    expect(updateOp.body.type).toBe("invokeHostFunction");

    expect(() =>
      buildUpdateContextRuleOperation({
        contractAddress: sa.contractAddress,
        contextRuleId: -1,
        name: "recovery",
        signers: [new Address(newGuardian).toScVal()],
      }),
    ).toThrow(/non-negative integer/i);

    expect(() =>
      buildUpdateContextRuleOperation({
        contractAddress: sa.contractAddress,
        contextRuleId: 0,
        name: "recovery",
        signers: [],
      }),
    ).toThrow(/At least one signer/i);
  });
});
