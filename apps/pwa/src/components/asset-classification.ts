export interface BalanceLike {
  assetCode: string;
  assetIssuer?: string | undefined;
  balance: string;
}

/**
 * Classic Stellar NFTs (Litemint / SEP-1 collectibles) are held as an exact
 * 1-stroop ("0.0000001") issued asset balance.
 */
export function isClassicStellarNftBalance(b: BalanceLike): boolean {
  return Boolean(b.assetIssuer) && b.balance.trim() === "0.0000001";
}

export function isZeroBalanceTrustline(b: BalanceLike): boolean {
  if (!b.assetIssuer) return false;
  const parsed = Number(b.balance);
  return Number.isFinite(parsed) && parsed === 0;
}

export interface PartitionedBalances<T extends BalanceLike> {
  fungible: T[];
  classicNfts: T[];
  emptyTrustlines: T[];
}

export function partitionWalletBalances<T extends BalanceLike>(
  balances: readonly T[],
): PartitionedBalances<T> {
  const fungible: T[] = [];
  const classicNfts: T[] = [];
  const emptyTrustlines: T[] = [];

  for (const item of balances) {
    if (item.assetCode === "XLM" && !item.assetIssuer) {
      fungible.unshift(item);
    } else if (isClassicStellarNftBalance(item)) {
      classicNfts.push(item);
    } else if (isZeroBalanceTrustline(item)) {
      emptyTrustlines.push(item);
    } else {
      fungible.push(item);
    }
  }

  return { fungible, classicNfts, emptyTrustlines };
}
