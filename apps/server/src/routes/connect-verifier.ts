import {
  ClassicAddressSchema,
  ContractAddressSchema,
  type ServerConfig,
} from "@astrowallet/domain";
import { deriveCounterfactualContractAddress } from "@astrowallet/security-shield";
import {
  verifyConnectSignature,
  verifySmartAccountGuardianSignature,
} from "@astrowallet/tg-protocol";
import { z } from "zod";
import type { LinkAddressInput, ServerRepository } from "../db/repository.js";

export const ClassicAccountSubmissionSchema = z.object({
  address: ClassicAddressSchema,
  kind: z.literal("classic"),
  label: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  signatureBase64: z.string().min(16),
});

export const SmartAccountSubmissionSchema = z.object({
  address: ContractAddressSchema,
  kind: z.literal("smart"),
  label: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  guardianAddress: ClassicAddressSchema,
  credentialIdB64: z.string().min(1).max(256).optional(),
  signatureBase64: z.string().min(16),
});

export const ConnectAccountSubmissionSchema = z.union([
  ClassicAccountSubmissionSchema,
  SmartAccountSubmissionSchema,
]);

export type ConnectAccountSubmission = z.infer<typeof ConnectAccountSubmissionSchema>;

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyConnectAccountSubmissions(input: {
  config: ServerConfig;
  repo: ServerRepository;
  telegramUserId: string;
  challengeMessage: string;
  accounts: readonly ConnectAccountSubmission[];
}): Promise<
  | { ok: true; verifiedInputs: LinkAddressInput[] }
  | { ok: false; status: 401 | 403; error: string }
> {
  const existingLinked = await input.repo.listLinkedAddresses(input.telegramUserId);
  const verifiedClassicSet = new Set(
    existingLinked.filter((a) => a.kind === "classic").map((a) => a.address),
  );
  const verifiedInputs: LinkAddressInput[] = [];

  for (const acc of input.accounts) {
    if (acc.kind !== "classic") continue;
    const ok = await verifyConnectSignature({
      address: acc.address,
      message: input.challengeMessage,
      signatureBase64: acc.signatureBase64,
    });
    if (!ok) {
      return {
        ok: false,
        status: 401,
        error: `Cryptographic signature failed for ${acc.address}`,
      };
    }
    verifiedClassicSet.add(acc.address);
    verifiedInputs.push({
      address: acc.address,
      kind: acc.kind,
      label: acc.label,
      isDefault: acc.isDefault,
      verifiedSigHash: await sha256Hex(acc.signatureBase64),
    });
  }

  for (const acc of input.accounts) {
    if (acc.kind !== "smart") continue;
    const ok = await verifySmartAccountGuardianSignature({
      contractAddress: acc.address,
      guardianAddress: acc.guardianAddress,
      challengeMessage: input.challengeMessage,
      signatureBase64: acc.signatureBase64,
    });
    if (!ok) {
      return {
        ok: false,
        status: 401,
        error: `Cryptographic signature failed for ${acc.address}`,
      };
    }
    if (!verifiedClassicSet.has(acc.guardianAddress)) {
      return {
        ok: false,
        status: 403,
        error: `Recovery Guardian ${acc.guardianAddress} must be linked or verified alongside ${acc.address}`,
      };
    }
    if (input.config.smartAccountWasmHash) {
      const expectedContract = await deriveCounterfactualContractAddress({
        guardianAddress: acc.guardianAddress,
        wasmHashHex: input.config.smartAccountWasmHash,
        networkPassphrase: input.config.networkPassphrase,
        credentialIdB64: acc.credentialIdB64,
      });
      if (expectedContract !== acc.address) {
        return {
          ok: false,
          status: 403,
          error: `Smart Account ${acc.address} does not match counterfactual derivation for configured WASM hash`,
        };
      }
    }
    verifiedInputs.push({
      address: acc.address,
      kind: acc.kind,
      label: acc.label,
      isDefault: acc.isDefault,
      verifiedSigHash: await sha256Hex(acc.signatureBase64),
    });
  }

  return { ok: true, verifiedInputs };
}
