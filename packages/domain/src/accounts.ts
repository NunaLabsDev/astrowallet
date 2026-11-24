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
    buyingLiabilities?: string | undefined;
    sellingLiabilities?: string | undefined;
  }[] | undefined;
}

const STROOPS_PER_XLM = 10_000_000n;
const RESERVE_PER_ENTRY_STROOPS = 5_000_000n;

/**
 * Normalizes mobile decimal keyboard inputs (e.g., European/Latin `10,50`, leading zeros `000.5`)
 * into canonical ASCII decimal strings while rejecting scientific notation, signs, and excess precision.
 */
export function normalizeDecimalAmountInput(raw: string, maxDecimals = 7): string | null {
  let cleaned = raw.trim();
  if (!cleaned) return null;
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    const commaCount = cleaned.split(",").length - 1;
    if (commaCount !== 1) return null;
    cleaned = cleaned.replace(",", ".");
  }
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const [rawWhole = "0", rawFrac = ""] = cleaned.split(".");
  if (rawFrac.length > maxDecimals) {
    return null;
  }
  const normalizedWhole = rawWhole.replace(/^0+(?=\d)/, "");
  return rawFrac.length > 0 ? `${normalizedWhole}.${rawFrac}` : normalizedWhole;
}

/**
 * Parses a decimal string (up to 7 fractional digits) into exact stroops BigInt, returning `null` if invalid or `<= 0`.
 */
export function parsePositiveDecimalToStroops7(raw: string): bigint | null {
  const normalized = normalizeDecimalAmountInput(raw, 7);
  if (!normalized) return null;
  const [wholePart = "0", fracPart = ""] = normalized.split(".");
  const stroops = BigInt(wholePart) * STROOPS_PER_XLM + BigInt(fracPart.padEnd(7, "0"));
  return stroops > 0n ? stroops : null;
}

/**
 * Formats a signed 7-decimal stroops BigInt into a trimmed decimal string (never loses precision >900M).
 */
export function formatStroops7Trimmed(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole.toString()}.${frac}` : `${sign}${whole.toString()}`;
}

/**
 * Computes spendable balance stroops after subtracting selling liabilities and optional reserve/fee buffer.
 */
export function computeMaxSpendableStroops7(
  balanceRaw: string,
  sellingLiabilitiesRaw = "0",
  extraReserveRaw = "0",
): bigint {
  const bal = parseDecimalToStroops(balanceRaw) ?? 0n;
  const liab = parseDecimalToStroops(sellingLiabilitiesRaw) ?? 0n;
  const extra = parseDecimalToStroops(extraReserveRaw) ?? 0n;
  const net = bal - liab - extra;
  return net > 0n ? net : 0n;
}

function parseDecimalToStroops(raw: string): bigint | null {
  const normalized = normalizeDecimalAmountInput(raw, 7);
  if (!normalized) {
    // Allow >7 digit Horizon strings to truncate safely when reading ledger balances
    const cleaned = raw.trim();
    if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
      return null;
    }
    const [wholePart = "0", fracPart = ""] = cleaned.split(".");
    const frac7 = fracPart.slice(0, 7).padEnd(7, "0");
    return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(frac7);
  }
  const [wholePart = "0", fracPart = ""] = normalized.split(".");
  return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(fracPart.padEnd(7, "0"));
}

function formatStroops7(stroops: bigint): string {
  const nonNeg = stroops > 0n ? stroops : 0n;
  const whole = nonNeg / STROOPS_PER_XLM;
  const frac = (nonNeg % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole.toString()}.${frac}`;
}

function formatStroopsTenths(stroops: bigint): string {
  const nonNeg = stroops > 0n ? stroops : 0n;
  const tenths = nonNeg / 1_000_000n;
  const whole = tenths / 10n;
  const dec = tenths % 10n;
  return `${whole.toString()}.${dec.toString()}`;
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

  const minReserveStroops = BigInt(effectiveEntries) * RESERVE_PER_ENTRY_STROOPS;
  const nativeStroops = parseDecimalToStroops(input.nativeBalanceXlm) ?? 0n;
  const sellingLiabStroops = parseDecimalToStroops(input.sellingLiabilitiesXlm ?? "0") ?? 0n;
  const rawSpendable = nativeStroops - minReserveStroops - sellingLiabStroops;
  const spendableStroops = rawSpendable > 0n ? rawSpendable : 0n;

  const reclaimableTrustlines: ZeroBalanceTrustline[] = [];
  for (const item of input.balances ?? []) {
    const parsedBal = parseDecimalToStroops(item.balance);
    const parsedBuyingLiab = parseDecimalToStroops(item.buyingLiabilities ?? "0") ?? 0n;
    const parsedSellingLiab = parseDecimalToStroops(item.sellingLiabilities ?? "0") ?? 0n;
    if (
      item.assetCode !== "XLM" &&
      item.assetIssuer &&
      ClassicAddressSchema.safeParse(item.assetIssuer).success &&
      parsedBal !== null &&
      parsedBal === 0n &&
      parsedBuyingLiab === 0n &&
      parsedSellingLiab === 0n
    ) {
      reclaimableTrustlines.push({
        assetCode: item.assetCode,
        assetIssuer: item.assetIssuer as ClassicAddress,
      });
    }
  }

  const reclaimableStroops = BigInt(reclaimableTrustlines.length) * RESERVE_PER_ENTRY_STROOPS;

  return {
    baseEntries,
    subentryCount,
    numSponsoring,
    numSponsored,
    effectiveEntries,
    minReserveXlm: formatStroopsTenths(minReserveStroops),
    spendableXlm: formatStroops7(spendableStroops),
    reclaimableTrustlines,
    reclaimableXlm: formatStroopsTenths(reclaimableStroops),
  };
}

export const TonNetworkSchema = z.enum(["testnet", "mainnet"]);
export type TonNetwork = z.infer<typeof TonNetworkSchema>;

export const TonAddressSchema = z
  .string()
  .trim()
  .refine(
    (v) => /^-?\d+:[0-9a-fA-F]{64}$/.test(v) || /^[A-Za-z0-9+/_-]{48}$/.test(v),
    "Invalid TON address (expected raw workchain:hex or 48-char friendly address)",
  );
export type TonAddress = z.infer<typeof TonAddressSchema>;

export interface TonAccountSummary {
  derivationPath: string;
  friendlyAddress: TonAddress;
  bounceableAddress: TonAddress;
  rawAddress: TonAddress;
  publicKeyHex: string;
  walletStateInitBase64: string;
  network: TonNetwork;
  version: "v4r2" | "v5r1";
}
