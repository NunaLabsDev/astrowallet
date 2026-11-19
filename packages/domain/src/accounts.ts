import { z } from "zod";

export const ClassicAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar classic public key (expected G...)");

export const ContractAddressSchema = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "Invalid Soroban contract address (expected C...)");

export const MuxedAddressSchema = z
  .string()
  .regex(/^M[A-Z2-7]{68}$/, "Invalid Stellar muxed address (expected M...)");

export const StellarAddressSchema = z.union([
  ClassicAddressSchema,
  ContractAddressSchema,
  MuxedAddressSchema,
]);

export const AccountKindSchema = z.enum(["classic", "smart"]);

export const AuthMethodSchema = z.enum(["pin", "passphrase", "fingerprint"]);

export const AccountCapabilitiesSchema = z.object({
  canSignClassicSdex: z.boolean(),
  canClaimBalances: z.boolean(),
  canReceiveRawMemo: z.boolean(),
  supportsGaslessSoroban: z.boolean(),
  requiresMuxedForCex: z.boolean(),
});

export const LinkedAccountSchema = z.object({
  id: z.string().min(1),
  address: StellarAddressSchema,
  kind: AccountKindSchema,
  label: z.string().min(1).max(32),
  derivationIndex: z.number().int().nonnegative().optional(),
  guardianAddress: ClassicAddressSchema.optional(),
  capabilities: AccountCapabilitiesSchema,
});

export type ClassicAddress = z.infer<typeof ClassicAddressSchema>;
export type ContractAddress = z.infer<typeof ContractAddressSchema>;
export type MuxedAddress = z.infer<typeof MuxedAddressSchema>;
export type StellarAddress = z.infer<typeof StellarAddressSchema>;
export type AccountKind = z.infer<typeof AccountKindSchema>;
export type AuthMethod = z.infer<typeof AuthMethodSchema>;
export type AccountCapabilities = z.infer<typeof AccountCapabilitiesSchema>;
export type LinkedAccount = z.infer<typeof LinkedAccountSchema>;

/**
 * Returns truthful protocol capabilities for Classic (G...) vs Smart Account (C...).
 */
export function defaultCapabilitiesForKind(kind: AccountKind): AccountCapabilities {
  if (kind === "classic") {
    return {
      canSignClassicSdex: true,
      canClaimBalances: true,
      canReceiveRawMemo: true,
      supportsGaslessSoroban: false,
      requiresMuxedForCex: false,
    };
  }

  return {
    canSignClassicSdex: false,
    canClaimBalances: false,
    canReceiveRawMemo: false,
    supportsGaslessSoroban: true,
    requiresMuxedForCex: true,
  };
}

export interface ZeroBalanceTrustline {
  assetCode: string;
  assetIssuer: ClassicAddress;
}

export interface AccountReserveSummary {
  baseEntries: number;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  effectiveEntries: number;
  minReserveXlm: string;
  spendableXlm: string;
  reclaimableTrustlines: readonly ZeroBalanceTrustline[];
  reclaimableXlm: string;
}

export interface AccountReserveCalculationInput {
  nativeBalanceXlm: string;
  subentryCount: number;
  numSponsoring?: number | undefined;
  numSponsored?: number | undefined;
  sellingLiabilitiesXlm?: string | undefined;
  balances?: readonly {
    assetCode: string;
    assetIssuer?: string | undefined;
    balance: string;
  }[] | undefined;
}

/**
 * Computes Classic Stellar XLM reserves: (2 + subentries + sponsoring - sponsored) * 0.5 XLM,
 * spendable XLM after reserves and selling liabilities, and zero-balance trustlines eligible for reclaim.
 */
export function calculateAccountReserveSummary(
  input: AccountReserveCalculationInput,
): AccountReserveSummary {
  const baseEntries = 2;
  const subentryCount = Math.max(0, Math.trunc(input.subentryCount));
  const numSponsoring = Math.max(0, Math.trunc(input.numSponsoring ?? 0));
  const numSponsored = Math.max(0, Math.trunc(input.numSponsored ?? 0));
  const effectiveEntries = Math.max(0, baseEntries + subentryCount + numSponsoring - numSponsored);
  const minReserveNum = effectiveEntries * 0.5;

  const nativeBal = Number(input.nativeBalanceXlm);
  const sellingLiab = Number(input.sellingLiabilitiesXlm ?? "0");
  const spendableNum = Math.max(
    0,
    (Number.isFinite(nativeBal) ? nativeBal : 0) -
      minReserveNum -
      (Number.isFinite(sellingLiab) ? sellingLiab : 0),
  );

  const reclaimableTrustlines: ZeroBalanceTrustline[] = [];
  for (const item of input.balances ?? []) {
    if (
      item.assetCode !== "XLM" &&
      item.assetIssuer &&
      ClassicAddressSchema.safeParse(item.assetIssuer).success &&
      Number(item.balance) === 0
    ) {
      reclaimableTrustlines.push({
        assetCode: item.assetCode,
        assetIssuer: item.assetIssuer as ClassicAddress,
      });
    }
  }

  return {
    baseEntries,
    subentryCount,
    numSponsoring,
    numSponsored,
    effectiveEntries,
    minReserveXlm: minReserveNum.toFixed(1),
    spendableXlm: spendableNum.toFixed(7),
    reclaimableTrustlines,
    reclaimableXlm: (reclaimableTrustlines.length * 0.5).toFixed(1),
  };
}
