import {
  formatStroops7Trimmed,
  normalizeDecimalAmountInput,
  parsePositiveDecimalToStroops7,
} from "@astrowallet/domain";

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
  maxSpendable: number | string,
  opts: { assetCode?: string | undefined; funded?: boolean | undefined } = {},
): string | null {
  const normalized = normalizeDecimalAmountInput(amountRaw, 7);
  const amountStroops = normalized ? parsePositiveDecimalToStroops7(normalized) : null;
  if (!normalized || amountStroops === null) {
    return "Enter a valid positive amount (up to 7 decimals).";
  }
  if (opts.funded === false) {
    return "This account is not activated on the ledger yet. Fund it first before sending.";
  }
  let maxStroops: bigint | null = null;
  if (typeof maxSpendable === "string") {
    const cleanMax = maxSpendable.trim();
    if (/^\d+(?:\.\d+)?$/.test(cleanMax)) {
      const [w = "0", f = ""] = cleanMax.split(".");
      maxStroops = BigInt(w) * 10_000_000n + BigInt(f.slice(0, 7).padEnd(7, "0"));
    }
  } else if (Number.isFinite(maxSpendable)) {
    const fixed = Math.max(0, maxSpendable).toFixed(7);
    const [w = "0", f = ""] = fixed.split(".");
    maxStroops = BigInt(w) * 10_000_000n + BigInt(f.slice(0, 7).padEnd(7, "0"));
  }
  if (maxStroops !== null && amountStroops > maxStroops) {
    const label = opts.assetCode ?? "balance";
    const formattedAvail = formatStroops7Trimmed(maxStroops > 0n ? maxStroops : 0n);
    return `Insufficient spendable ${label} (${formattedAvail} available).`;
  }
  return null;
}

/**
 * Computes the next sequential SEP-0005 derivation index across derived accounts,
 * ignoring imported external accounts (>= 1000) and reserving index 99 for the x402 agent.
 */
export function computeNextDerivationIndex(
  accounts: ReadonlyArray<{ derivationIndex?: number | undefined }>,
): number {
  const next =
    accounts
      .map((acc) => acc.derivationIndex ?? 0)
      .filter((idx) => idx >= 0 && idx < 1000 && idx !== 99)
      .reduce((max, idx) => Math.max(max, idx), -1) + 1;
  return next === 99 ? 100 : next;
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
  spendableBalance?: number | string | undefined;
  thresholdXlm?: number | undefined;
  network: "testnet" | "mainnet";
  hasWarningVerdict?: boolean | undefined;
}): { required: boolean; reason?: string } {
  const thresholdXlm = params.thresholdXlm && params.thresholdXlm > 0 ? params.thresholdXlm : 250;
  const code = (params.assetCode ?? "XLM").toUpperCase();
  const normalizedAmount = params.amount ? normalizeDecimalAmountInput(params.amount, 7) : null;
  const numericAmount = normalizedAmount ? Number(normalizedAmount) : 0;
  const amountStroops = normalizedAmount ? parsePositiveDecimalToStroops7(normalizedAmount) : null;

  if (params.network === "mainnet" && params.hasWarningVerdict) {
    return {
      required: true,
      reason: "Mainnet transaction has a Scan & Shield warning.",
    };
  }

  if (amountStroops !== null && amountStroops > 0n) {
    if (code === "XLM" && amountStroops >= BigInt(Math.round(thresholdXlm)) * 10_000_000n) {
      return {
        required: true,
        reason: `High-value transfer (>= ${thresholdXlm} XLM threshold).`,
      };
    }
    if (STABLECOIN_CODES.has(code) && amountStroops >= 100n * 10_000_000n) {
      return {
        required: true,
        reason: `High-value ${code} transfer (>= 100 ${code} threshold).`,
      };
    }
    const spendableNum =
      typeof params.spendableBalance === "string"
        ? Number(params.spendableBalance)
        : params.spendableBalance;
    if (
      typeof spendableNum === "number" &&
      Number.isFinite(spendableNum) &&
      spendableNum >= 50 &&
      Number.isFinite(numericAmount) &&
      numericAmount >= spendableNum * 0.5
    ) {
      return {
        required: true,
        reason: "Transfer moves 50% or more of your spendable balance.",
      };
    }
  }

  return { required: false };
}
