import { parseSwapAssetIdentifier, type ParsedSwapAsset } from "@astrowallet/defi";
import type { AssetBalance, ClassicAddress } from "@astrowallet/domain";
import type { VerifiedAssetEntry } from "@astrowallet/security-shield";
import type { TokenCatalogItem } from "@astrowallet/stellar-core";

export type TokenCatalogFilter =
  | "all"
  | "holdings"
  | "official"
  | "oft"
  | "community"
  | "liquid";
export type TokenTrustClassification = "official" | "scam_spoof" | "unverified";

export interface TokenTrustVerdict {
  status: TokenTrustClassification;
  label: string;
  reason: string;
  matchedVerified?: VerifiedAssetEntry | undefined;
}

const PROTECTED_ASSET_SYMBOLS = new Set([
  "USDC",
  "EURC",
  "PYUSD",
  "AQUA",
  "BTC",
  "ETH",
  "USDT",
  "USDT0",
  "USDE",
  "SUSDE",
  "YUSDC",
  "YXLM",
]);

export const CANONICAL_MAINNET_OFT_ASSETS: readonly VerifiedAssetEntry[] = [
  {
    code: "USDE",
    issuer: "GDJ5BNU5NN6NQ54D7OX6NQTUYNBZ42CAT33QGM5BIQ2QIYADAC5ICH47",
    name: "Ethena USDe",
    domain: "ethena.fi",
    contract: "CCNOV6XVI2O5BSTA3232GIRUQULDEBV7IWGKM6QKI6II5OIIQTU24JJN",
    decimals: 7,
  },
  {
    code: "SUSDE",
    issuer: "GDJ5BNU5NN6NQ54D7OX6NQTUYNBZ42CAT33QGM5BIQ2QIYADAC5ICH47",
    name: "Ethena Staked USDe",
    domain: "ethena.fi",
    contract: "CACSKWC753QVGC4J6YPDBIR2BEHFVWIAE7CBSS3HOVYMN623OAIQYE2M",
    decimals: 7,
  },
  {
    code: "USDT0",
    issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    name: "Tether USDT0 (LayerZero OFT)",
    domain: "usdt0.to",
    contract: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
    decimals: 7,
  },
];

export const COMMUNITY_MAINNET_HUB_ASSETS: readonly VerifiedAssetEntry[] = [
  {
    code: "LIBRE",
    issuer: "GAYCCWKECNGDRHYU3UTREBD2XLC3CUQN6FV22TKM4WCQER3IWR7TF5CY",
    name: "LIBRE (#ACTHUB)",
    domain: "librequidity.org",
    contract: "CBEM2CAIYLM3HBOPU5HLQL7V5BUAKM3N77DYQKX4FNHTQLQUUD2ZFBOX",
    decimals: 7,
  },
  {
    code: "xLMNR",
    issuer: "GDKA6WVMFSA73BMEVKPO6WXSSWP4MPRBDJVSXLLSEVIEVH226L5RJ7NL",
    name: "Lumenaire (#ACTHUB)",
    domain: "thelumenaire.com",
    contract: "CCEIVLOFQHALNB2ZVQJW55OYKEL7GG52JIGLUGHLRTEAFMISNSMOM5XW",
    decimals: 7,
  },
  {
    code: "SVR",
    issuer: "GAGORNGHVJP5X2QO2NNIIDXKLNHVWJWXC5S73EZNCHOALGFTB2V25YGF",
    name: "SVR Token (#ACTHUB)",
    domain: "svrtoken.com",
    decimals: 7,
  },
];

/**
 * Normalizes an asset code + optional issuer into a deterministic lookup key.
 */
export function tokenAssetKey(code: string, issuer?: string): string {
  return `${code.trim().toUpperCase()}:${issuer?.trim() || "native"}`;
}

/**
 * Formats an asset into the identifier expected by SwapSheet and @astrowallet/defi.
 */
export function tokenSwapIdentifier(assetCode: string, assetIssuer?: string): string {
  return assetCode.trim().toUpperCase() === "XLM" && !assetIssuer
    ? "XLM"
    : `${assetCode.trim()}:${assetIssuer ?? ""}`;
}

export function formatCompactNumber(raw: string | number | undefined): string {
  const num = typeof raw === "number" ? raw : Number(raw ?? "0");
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function formatTokenPriceValue(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val) || val <= 0) return "—";
  if (val >= 1000) return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.001) return val.toFixed(5);
  return val.toFixed(7);
}

/**
 * Evaluates whether a Stellar token is official (SEP-42 / native XLM),
 * a scam/spoofed copycat using a protected symbol with a different issuer,
 * or an unverified custom/community token.
 */
export function classifyTokenTrust(input: {
  assetCode: string;
  assetIssuer?: string | undefined;
  verifiedAssets: readonly VerifiedAssetEntry[];
  network?: "testnet" | "mainnet" | undefined;
}): TokenTrustVerdict {
  const code = input.assetCode.trim().toUpperCase();
  const issuer = input.assetIssuer?.trim();
  const useMainnetRegistries = input.network === "mainnet";

  if (code === "XLM" && !issuer) {
    return {
      status: "official",
      label: "Official Native",
      reason: "Native Stellar protocol lumen (XLM) with zero issuer counterparty risk.",
    };
  }

  if (code === "XLM" && issuer) {
    return {
      status: "scam_spoof",
      label: "SCAM / Fake XLM",
      reason: "Native XLM never has an issuer G... address. Any issued token named XLM is an impostor.",
    };
  }

  const exactOft = useMainnetRegistries
    ? CANONICAL_MAINNET_OFT_ASSETS.find(
        (v) => v.code.toUpperCase() === code && v.issuer === issuer,
      )
    : undefined;
  if (exactOft) {
    return {
      status: "official",
      label: "Canonical LayerZero OFT",
      reason: `Verified canonical omnichain asset (${exactOft.domain ?? "LayerZero V2 EID 30600"}).`,
      matchedVerified: exactOft,
    };
  }

  const exactCommunity = useMainnetRegistries
    ? COMMUNITY_MAINNET_HUB_ASSETS.find(
        (v) => v.code.toUpperCase() === code && v.issuer === issuer,
      )
    : undefined;
  if (exactCommunity) {
    return {
      status: "official",
      label: "Community Hub Verified",
      reason: `Curated #ACTHUB ecosystem token (${exactCommunity.domain ?? "community-verified"}).`,
      matchedVerified: exactCommunity,
    };
  }

  const exact = input.verifiedAssets.find(
    (v) => v.code.toUpperCase() === code && v.issuer === issuer,
  );
  if (exact) {
    return {
      status: "official",
      label: "Official SEP-42",
      reason: exact.domain
        ? `Verified in official SEP-42 asset registry (${exact.domain}).`
        : "Verified issuer in official SEP-42 asset registry.",
      matchedVerified: exact,
    };
  }

  const officialForCode =
    input.verifiedAssets.find((v) => v.code.toUpperCase() === code) ??
    (useMainnetRegistries
      ? CANONICAL_MAINNET_OFT_ASSETS.find((v) => v.code.toUpperCase() === code)
      : undefined);
  if (
    officialForCode ||
    (input.verifiedAssets.length > 0 && PROTECTED_ASSET_SYMBOLS.has(code))
  ) {
    return {
      status: "scam_spoof",
      label: "SCAM / Spoofed Ticker",
      reason: officialForCode
        ? `Warning: issuer does not match official ${code} (${officialForCode.issuer.slice(0, 6)}…${officialForCode.issuer.slice(-4)}). Do not swap unless intended.`
        : `Warning: unverified issuer using protected ticker ${code}. Verify issuer G... carefully.`,
      matchedVerified: officialForCode,
    };
  }

  return {
    status: "unverified",
    label: "Unverified Token",
    reason:
      "Community/custom issuer not in the SEP-42 verified list. Check holder count, domain, and issuer flags.",
  };
}

/**
 * Resolves a bare asset ticker (e.g. "USDC") to its matching held, SEP-42 official,
 * or discovered liquid `CODE:G...` identifier for zero-friction swaps.
 */
export function resolveSwapAssetInput(
  raw: string,
  verifiedAssets: readonly VerifiedAssetEntry[],
  balances: readonly AssetBalance[],
  liquidAssets: readonly TokenCatalogItem[] = [],
): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.toUpperCase() === "XLM" || trimmed.toLowerCase() === "native") {
    return "XLM";
  }
  if (trimmed.includes(":")) {
    const [codePart, issuerPart] = trimmed.split(":");
    return `${(codePart ?? "").trim().toUpperCase()}:${(issuerPart ?? "").trim()}`;
  }

  const code = trimmed.toUpperCase();
  const held = balances.find(
    (b) => b.assetCode.toUpperCase() === code && Boolean(b.assetIssuer),
  );
  if (held?.assetIssuer) {
    return `${held.assetCode}:${held.assetIssuer}`;
  }

  const official = verifiedAssets.find((v) => v.code.toUpperCase() === code);
  if (official) {
    return `${official.code}:${official.issuer}`;
  }

  const liquid = liquidAssets.find(
    (l) => l.assetCode.toUpperCase() === code && Boolean(l.assetIssuer),
  );
  if (liquid?.assetIssuer) {
    return `${liquid.assetCode}:${liquid.assetIssuer}`;
  }

  return trimmed;
}

/**
 * Builds a deduplicated, filtered Stellar token directory combining native XLM,
 * held balances, official SEP-42 registry entries, and live Horizon search/liquidity hits.
 */
export function buildTokenCatalog(input: {
  balances: readonly AssetBalance[];
  verifiedAssets: readonly VerifiedAssetEntry[];
  horizonResults: readonly TokenCatalogItem[];
  filter: TokenCatalogFilter;
  query: string;
  includeCanonicalOfts?: boolean | undefined;
  includeCommunityHub?: boolean | undefined;
}): TokenCatalogItem[] {
  const verifiedMap = new Map<string, VerifiedAssetEntry>();
  for (const v of input.verifiedAssets) {
    verifiedMap.set(tokenAssetKey(v.code, v.issuer), v);
  }

  const heldMap = new Map(
    input.balances.map((b) => [tokenAssetKey(b.assetCode, b.assetIssuer), b]),
  );

  const map = new Map<string, TokenCatalogItem>();
  const xlmKey = tokenAssetKey("XLM");
  const xlmHeld = heldMap.get(xlmKey);
  map.set(xlmKey, {
    assetCode: "XLM",
    name: "Stellar Lumens (Native)",
    domain: "stellar.org",
    isVerified: true,
    userBalance: xlmHeld?.balance ?? "0.0000000",
    hasTrustline: true,
    hasLiquidityPool: true,
  });

  for (const b of input.balances) {
    const k = tokenAssetKey(b.assetCode, b.assetIssuer);
    if (k === xlmKey) continue;
    const verified = verifiedMap.get(k);
    map.set(k, {
      assetCode: b.assetCode,
      assetIssuer: b.assetIssuer as ClassicAddress | undefined,
      name: verified?.name,
      domain: verified?.domain,
      icon: verified?.icon,
      isVerified: b.isVerifiedAsset || Boolean(verified),
      userBalance: b.balance,
      hasTrustline: true,
    });
  }

  const extraVerified = [
    ...(input.includeCanonicalOfts ? CANONICAL_MAINNET_OFT_ASSETS : []),
    ...(input.includeCommunityHub ? COMMUNITY_MAINNET_HUB_ASSETS : []),
  ];
  for (const v of [...input.verifiedAssets, ...extraVerified]) {
    const k = tokenAssetKey(v.code, v.issuer);
    if (map.has(k)) continue;
    map.set(k, {
      assetCode: v.code,
      assetIssuer: v.issuer as ClassicAddress,
      name: v.name,
      domain: v.domain,
      icon: v.icon,
      isVerified: true,
      hasTrustline: false,
    });
  }

  for (const hr of input.horizonResults) {
    const k = tokenAssetKey(hr.assetCode, hr.assetIssuer);
    const existing = map.get(k);
    if (existing) {
      map.set(k, {
        ...existing,
        name: existing.name ?? hr.name,
        icon: existing.icon ?? hr.icon,
        numAccounts: hr.numAccounts ?? existing.numAccounts,
        supplyAmount: hr.supplyAmount ?? existing.supplyAmount,
        domain: existing.domain ?? hr.domain,
        ...(hr.hasLiquidityPool || existing.hasLiquidityPool
          ? { hasLiquidityPool: true }
          : {}),
        ...(hr.poolReserveAmount || existing.poolReserveAmount
          ? { poolReserveAmount: hr.poolReserveAmount ?? existing.poolReserveAmount }
          : {}),
      });
    } else {
      map.set(k, hr);
    }
  }

  const oftKeySet = new Set(
    CANONICAL_MAINNET_OFT_ASSETS.map((v) => tokenAssetKey(v.code, v.issuer)),
  );
  const communityKeySet = new Set(
    COMMUNITY_MAINNET_HUB_ASSETS.map((v) => tokenAssetKey(v.code, v.issuer)),
  );

  const q = input.query.trim().toLowerCase();
  return Array.from(map.values()).filter((item) => {
    const k = tokenAssetKey(item.assetCode, item.assetIssuer);
    if (input.filter === "holdings" && !item.hasTrustline) return false;
    if (input.filter === "official" && !item.isVerified) return false;
    if (input.filter === "oft" && !oftKeySet.has(k)) return false;
    if (input.filter === "community" && !communityKeySet.has(k)) return false;
    if (input.filter === "liquid" && !item.hasLiquidityPool) return false;
    if (!q) return true;
    return (
      item.assetCode.toLowerCase().includes(q) ||
      (item.name?.toLowerCase().includes(q) ?? false) ||
      (item.domain?.toLowerCase().includes(q) ?? false) ||
      (item.assetIssuer?.toLowerCase().includes(q) ?? false)
    );
  });
}

/**
 * Determines whether a swap destination asset requires activating a Classic trustline first.
 */
export function resolveMissingSwapTrustline(input: {
  toAsset: string;
  balances: readonly AssetBalance[];
}): { parsed: ParsedSwapAsset | null; missingTrustline: boolean } {
  const clean = input.toAsset.trim();
  if (!clean) {
    return { parsed: null, missingTrustline: false };
  }
  let parsed: ParsedSwapAsset;
  try {
    parsed = parseSwapAssetIdentifier(clean);
  } catch {
    return { parsed: null, missingTrustline: false };
  }
  if (parsed.code.toUpperCase() === "XLM" && !parsed.issuer) {
    return { parsed: null, missingTrustline: false };
  }
  if (!parsed.issuer) {
    return { parsed, missingTrustline: false };
  }
  const hasTrustline = input.balances.some(
    (b) =>
      b.assetCode.toUpperCase() === parsed.code.toUpperCase() &&
      b.assetIssuer === parsed.issuer,
  );
  return { parsed, missingTrustline: !hasTrustline };
}
