export type StellarMemoKind = "text" | "id" | "hash" | "return" | "none";

const MAX_UINT64 = 18_446_744_073_709_551_615n;

/**
 * Validates Stellar transaction memo payloads against protocol limits before signing.
 */
export function validateStellarMemoInput(
  kind: StellarMemoKind,
  rawValue: string,
): string | null {
  const clean = rawValue.trim();
  if (kind === "none" || clean.length === 0) {
    return null;
  }
  if (kind === "text") {
    const byteLen = new TextEncoder().encode(clean).byteLength;
    if (byteLen > 28) {
      return `Text memo is ${byteLen} UTF-8 bytes (Stellar max is 28 bytes).`;
    }
    return null;
  }
  if (kind === "id") {
    if (!/^\d+$/.test(clean)) {
      return "ID memo must contain digits only (unsigned 64-bit integer).";
    }
    try {
      const parsed = BigInt(clean);
      if (parsed < 0n || parsed > MAX_UINT64) {
        return "ID memo exceeds unsigned 64-bit integer maximum.";
      }
      return null;
    } catch {
      return "Invalid unsigned 64-bit integer memo.";
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    return `${kind.toUpperCase()} memo must be an exact 64-character hex digest.`;
  }
  return null;
}

/**
 * Validates a Stellar transfer amount against 7-decimal precision, ledger activation, and spendable balance.
 */
export function validateTransferAmount(
  amountRaw: string,
  maxSpendable: number,
  opts: { assetCode?: string | undefined; funded?: boolean | undefined } = {},
): string | null {
  const clean = amountRaw.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(clean) || Number(clean) <= 0) {
    return "Enter a valid positive amount (up to 7 decimals).";
  }
  if (opts.funded === false) {
    return "This account is not activated on the ledger yet. Fund it first before sending.";
  }
  const numeric = Number(clean);
  if (Number.isFinite(maxSpendable) && numeric > maxSpendable + 1e-8) {
    const label = opts.assetCode ?? "balance";
    const formattedAvail =
      Math.max(0, Math.floor(maxSpendable * 10_000_000) / 10_000_000)
        .toFixed(7)
        .replace(/\.?0+$/, "") || "0";
    return `Insufficient spendable ${label} (${formattedAvail} available).`;
  }
  return null;
}

/**
 * Computes the next sequential SEP-0005 derivation index across contiguous or sparse accounts.
 */
export function computeNextDerivationIndex(
  accounts: ReadonlyArray<{ derivationIndex?: number | undefined }>,
): number {
  return accounts.reduce((max, acc) => Math.max(max, acc.derivationIndex ?? 0), -1) + 1;
}

const STABLECOIN_CODES = new Set([
  "USDC",
  "USDT",
  "USDT0",
  "USDE",
  "SUSDE",
  "EURC",
  "PYUSD",
]);

/**
 * Determines whether a transaction requires fresh PIN or biometric re-authentication
 * before signing (high-value XLM/stablecoin threshold, >50% balance drain, or mainnet warning).
 */
export function requiresHighValueReauth(params: {
  amount?: string | undefined;
  assetCode?: string | undefined;
  spendableBalance?: number | undefined;
  thresholdXlm?: number | undefined;
  network: "testnet" | "mainnet";
  hasWarningVerdict?: boolean | undefined;
}): { required: boolean; reason?: string } {
  const thresholdXlm = params.thresholdXlm && params.thresholdXlm > 0 ? params.thresholdXlm : 250;
  const code = (params.assetCode ?? "XLM").toUpperCase();
  const numericAmount = params.amount ? Number(params.amount) : 0;

  if (params.network === "mainnet" && params.hasWarningVerdict) {
    return {
      required: true,
      reason: "Mainnet transaction has a Scan & Shield warning.",
    };
  }

  if (Number.isFinite(numericAmount) && numericAmount > 0) {
    if (code === "XLM" && numericAmount >= thresholdXlm) {
      return {
        required: true,
        reason: `High-value transfer (>= ${thresholdXlm} XLM threshold).`,
      };
    }
    if (STABLECOIN_CODES.has(code) && numericAmount >= 100) {
      return {
        required: true,
        reason: `High-value ${code} transfer (>= 100 ${code} threshold).`,
      };
    }
    if (
      typeof params.spendableBalance === "number" &&
      Number.isFinite(params.spendableBalance) &&
      params.spendableBalance >= 50 &&
      numericAmount >= params.spendableBalance * 0.5
    ) {
      return {
        required: true,
        reason: "Transfer moves 50% or more of your spendable balance.",
      };
    }
  }

  return { required: false };
}
