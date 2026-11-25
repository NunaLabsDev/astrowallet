import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ClassicAddress } from "@astrowallet/domain";
import type { VerifiedAssetEntry } from "@astrowallet/security-shield";
import {
  searchHorizonAssets,
  type StellarTokenDetails,
  type TokenCatalogItem,
  type TokenOrderbookSnapshot,
  type TokenPriceHistoryResult,
  type TokenPriceTimeframe,
  type TokenRecentTradeRecord,
} from "@astrowallet/stellar-core";
import {
  fetchCachedLiquidAssets,
  fetchCachedMarketHistory,
  fetchCachedTokenBundle,
  readCachedEntry,
  type TokenBundleResult,
  type TokenHolderEntry,
  type TokenLiquidityPoolEntry,
} from "../state/market-cache.js";
import { fetchCachedOraclePrices, type OraclePriceQuoteEntry } from "../state/oracle-prices.js";
import { useWallet } from "../state/wallet-context.js";
import {
  copyTextToClipboard,
  openExternalUrl,
  openTelegramMiniAppLink,
  triggerTelegramHaptic,
} from "../telegram/webapp.js";
import {
  IconChart,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconExternalLink,
  IconRefresh,
  IconSearch,
  IconSend,
  IconShield,
  IconSwap,
} from "./Icons.js";
import { LightweightPriceChart } from "./LightweightPriceChart.js";
import { TokenBadge } from "./TokenBadge.js";
import {
  buildTokenCatalog,
  classifyTokenTrust,
  formatCompactNumber,
  formatTokenPriceValue,
  tokenAssetKey,
  tokenSwapIdentifier,
  type TokenCatalogFilter,
} from "./token-catalog.js";

export interface SelectedTokenTarget {
  assetCode: string;
  assetIssuer?: string | undefined;
  name?: string | undefined;
  domain?: string | undefined;
  icon?: string | undefined;
}

export interface TokenExplorerSheetProps {
  initialToken?: SelectedTokenTarget | null | undefined;
  onOpenSend: (prefill: { assetCode: string; assetIssuer?: string | undefined }) => void;
  onOpenSwap: (prefill: { assetId: string; mode: "from" | "to" }) => void;
  onInspectAddress?: (address: string) => void;
}

type InspectorTab = "overview" | "holders" | "orderbook" | "security";

function computeOnChainAssetScore(input: {
  isNativeXlm: boolean;
  isOfficial: boolean;
  isSpoof: boolean;
  hasDomain: boolean;
  details: StellarTokenDetails | null;
  poolCount: number;
}): number {
  if (input.isSpoof) return 1.0;
  if (input.isNativeXlm) return 10.0;
  let score = 4.0;
  if (input.isOfficial) score += 2.5;
  if (input.hasDomain) score += 1.0;
  if (input.details?.flags.authImmutable) score += 1.0;
  if (!input.details?.flags.authClawbackEnabled) score += 0.5;
  if (!input.details?.flags.authRevocable) score += 0.5;
  if ((input.details?.numAccounts ?? 0) >= 100 || input.poolCount > 0) score += 0.5;
  return Math.min(10.0, Math.round(score * 10) / 10);
}

export function TokenExplorerSheet({
  initialToken,
  onOpenSend,
  onOpenSwap,
  onInspectAddress,
}: TokenExplorerSheetProps) {
  const {
    config,
    activeAccount,
    accountState,
    verifiedAssets,
    tokenMetaMap,
    addOrRemoveTrustline,
    reclaimZeroBalanceReserves,
    showToast,
  } = useWallet();

  const [selectedToken, setSelectedToken] = useState<SelectedTokenTarget | null>(
    () => initialToken ?? null,
  );
  const [catalogFilter, setCatalogFilter] = useState<TokenCatalogFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchingHorizon, setSearchingHorizon] = useState(false);
  const [horizonResults, setHorizonResults] = useState<TokenCatalogItem[]>([]);
  const [liquidDiscovery, setLiquidDiscovery] = useState<TokenCatalogItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [timeframe, setTimeframe] = useState<TokenPriceTimeframe>("24h");
  const [chartMode, setChartMode] = useState<"area" | "candles">("candles");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingChart, setLoadingChart] = useState(false);
  const [details, setDetails] = useState<StellarTokenDetails | null>(null);
  const [priceHistory, setPriceHistory] = useState<TokenPriceHistoryResult | null>(null);
  const [orderbook, setOrderbook] = useState<TokenOrderbookSnapshot | null>(null);
  const [recentTrades, setRecentTrades] = useState<TokenRecentTradeRecord[]>([]);
  const [holders, setHolders] = useState<TokenHolderEntry[]>([]);
  const [liquidityPools, setLiquidityPools] = useState<TokenLiquidityPoolEntry[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [oraclePrices, setOraclePrices] = useState<Record<string, OraclePriceQuoteEntry>>({});

  useEffect(() => {
    setSelectedToken(initialToken ?? null);
    setInspectorTab("overview");
  }, [initialToken]);

  // Pre-load RedStone SEP-40 USD oracle prices when available for active network
  useEffect(() => {
    let cancelled = false;
    void fetchCachedOraclePrices({
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
    }).then((snap) => {
      if (!cancelled && snap?.configured) {
        setOraclePrices(snap.prices);
      } else if (!cancelled) {
        setOraclePrices({});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl, config.network]);

  // Pre-load live liquid tokens via 3-tier SWR cache (DeviceStorage + Edge Cache + Horizon)
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `liquid:${config.network}:15`;
    void readCachedEntry<TokenCatalogItem[]>(cacheKey, 24 * 60 * 60 * 1000).then((hit) => {
      if (!cancelled && hit) setLiquidDiscovery(hit.data);
    });
    void fetchCachedLiquidAssets({
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
      horizonUrls: config.horizonUrls,
      limit: 15,
    })
      .then((items) => {
        if (!cancelled) setLiquidDiscovery(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config.horizonUrls, config.apiBaseUrl, config.network]);

  const verifiedMap = useMemo(() => {
    const map = new Map<string, VerifiedAssetEntry>();
    for (const v of verifiedAssets) {
      map.set(tokenAssetKey(v.code, v.issuer), v);
    }
    return map;
  }, [verifiedAssets]);

  const verifiedUsdcCounter = useMemo(() => {
    const match = verifiedAssets.find((v) => v.code.toUpperCase() === "USDC");
    return match ? { code: match.code, issuer: match.issuer as ClassicAddress } : undefined;
  }, [verifiedAssets]);

  const mergedHorizonHits = useMemo(
    () => [...liquidDiscovery, ...horizonResults],
    [liquidDiscovery, horizonResults],
  );

  const catalogItems = useMemo(
    () =>
      buildTokenCatalog({
        balances: accountState?.balances ?? [],
        verifiedAssets,
        horizonResults: mergedHorizonHits,
        filter: catalogFilter,
        query: searchQuery,
        includeCanonicalOfts: config.network === "mainnet",
        includeCommunityHub: config.network === "mainnet",
      }),
    [
      accountState?.balances,
      verifiedAssets,
      mergedHorizonHits,
      catalogFilter,
      searchQuery,
      config.network,
    ],
  );

  useEffect(() => {
    if (!selectedToken) {
      setDetails(null);
      setOrderbook(null);
      setRecentTrades([]);
      setHolders([]);
      setLiquidityPools([]);
      setDetailError(null);
      return undefined;
    }

    let cancelled = false;
    setDetailError(null);
    setDetails(null);
    setOrderbook(null);
    setRecentTrades([]);
    setHolders([]);
    setLiquidityPools([]);

    const isNativeXlm =
      selectedToken.assetCode.trim().toUpperCase() === "XLM" && !selectedToken.assetIssuer;
    const counterAsset = isNativeXlm ? verifiedUsdcCounter : undefined;
    const cacheKey = `token:${config.network}:${selectedToken.assetCode}:${selectedToken.assetIssuer ?? "native"}:${counterAsset?.code ?? "XLM"}`;

    let hasWarmCache = false;
    let liveSettled = false;
    void readCachedEntry<TokenBundleResult>(cacheKey, 24 * 60 * 60 * 1000).then((hit) => {
      if (cancelled || liveSettled) return;
      if (hit) {
        hasWarmCache = true;
        setDetails(hit.data.details);
        setOrderbook(hit.data.orderbook);
        setRecentTrades(hit.data.recentTrades);
        setHolders(hit.data.holders ?? []);
        setLiquidityPools(hit.data.liquidityPools ?? []);
        setLoadingDetails(false);
      } else {
        setLoadingDetails(true);
      }
    });

    void fetchCachedTokenBundle({
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
      horizonUrls: config.horizonUrls,
      networkPassphrase: config.networkPassphrase,
      assetCode: selectedToken.assetCode,
      assetIssuer: selectedToken.assetIssuer as ClassicAddress | undefined,
      counterAsset,
    })
      .then((bundle) => {
        if (cancelled) return;
        liveSettled = true;
        setDetails(bundle.details);
        setOrderbook(bundle.orderbook);
        setRecentTrades(bundle.recentTrades);
        setHolders(bundle.holders ?? []);
        setLiquidityPools(bundle.liquidityPools ?? []);
      })
      .catch((err) => {
        if (cancelled || hasWarmCache) return;
        setDetailError(err instanceof Error ? err.message : "Failed to load on-chain token details");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedToken,
    config.horizonUrls,
    config.networkPassphrase,
    config.apiBaseUrl,
    config.network,
    verifiedUsdcCounter,
  ]);

  useEffect(() => {
    if (!selectedToken) {
      setPriceHistory(null);
      return undefined;
    }

    let cancelled = false;
    const isNativeXlm =
      selectedToken.assetCode.trim().toUpperCase() === "XLM" && !selectedToken.assetIssuer;
    const counterAsset = isNativeXlm ? verifiedUsdcCounter : undefined;
    const cacheKey = `hist:${config.network}:${selectedToken.assetCode}:${selectedToken.assetIssuer ?? "native"}:${timeframe}:${counterAsset?.code ?? "XLM"}`;

    let hasWarmCache = false;
    void readCachedEntry<TokenPriceHistoryResult>(cacheKey, 24 * 60 * 60 * 1000).then((hit) => {
      if (cancelled) return;
      if (hit) {
        hasWarmCache = true;
        setPriceHistory(hit.data);
        setLoadingChart(false);
      } else {
        setLoadingChart(true);
      }
    });

    void fetchCachedMarketHistory({
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
      horizonUrls: config.horizonUrls,
      assetCode: selectedToken.assetCode,
      assetIssuer: selectedToken.assetIssuer as ClassicAddress | undefined,
      timeframe,
      counterAsset,
    })
      .then((hist) => {
        if (!cancelled) {
          setPriceHistory(hist);
          // Warm 7d & 30d in background when viewing 24h so timeframe switches feel instant
          if (timeframe === "24h") {
            for (const nextTf of ["7d", "30d"] as const) {
              void fetchCachedMarketHistory({
                apiBaseUrl: config.apiBaseUrl,
                network: config.network,
                horizonUrls: config.horizonUrls,
                assetCode: selectedToken.assetCode,
                assetIssuer: selectedToken.assetIssuer as ClassicAddress | undefined,
                timeframe: nextTf,
                counterAsset,
              }).catch(() => undefined);
            }
          }
        }
      })
      .catch(() => {
        if (!cancelled && !hasWarmCache) setPriceHistory(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingChart(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedToken,
    timeframe,
    config.horizonUrls,
    config.apiBaseUrl,
    config.network,
    verifiedUsdcCounter,
  ]);

  const handleHorizonSearch = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = searchQuery.trim();
    setSearchingHorizon(true);
    setSearchError(null);
    try {
      const results = await searchHorizonAssets({
        horizonUrls: config.horizonUrls,
        query: cleaned,
        limit: 20,
        apiBaseUrl: config.apiBaseUrl,
        network: config.network,
      });
      setHorizonResults(results);
      if (results.length === 0 && cleaned.length > 0) {
        setSearchError(
          `No issued assets matched "${cleaned}" on ${config.network.toUpperCase()} Horizon. Try exact ticker (e.g. USDC) or CODE:G... issuer.`,
        );
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Horizon asset search failed");
    } finally {
      setSearchingHorizon(false);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedField(key);
      triggerTelegramHaptic("selection");
      setTimeout(() => setCopiedField(null), 1600);
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  const handleToggleTrustline = async (add: boolean) => {
    if (!selectedToken?.assetIssuer) return;
    setTrustBusy(true);
    try {
      if (add) {
        await addOrRemoveTrustline(
          selectedToken.assetCode,
          selectedToken.assetIssuer as ClassicAddress,
        );
      } else {
        await addOrRemoveTrustline(
          selectedToken.assetCode,
          selectedToken.assetIssuer as ClassicAddress,
          "0",
        );
      }
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      showToast(err instanceof Error ? err.message : "Trustline update failed", "error");
    } finally {
      setTrustBusy(false);
    }
  };

  const handleReclaimZero = async () => {
    setTrustBusy(true);
    try {
      await reclaimZeroBalanceReserves();
      triggerTelegramHaptic("success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Reserve reclaim failed", "error");
    } finally {
      setTrustBusy(false);
    }
  };

  if (!activeAccount) return null;

  // ============================================================================
  // VIEW 1: TOKEN DIRECTORY & SEARCH
  // ============================================================================
  if (!selectedToken) {
    return (
      <section
        className="glass-card"
        aria-label="Stellar Token Directory"
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}
      >
        <form onSubmit={(e) => void handleHorizonSearch(e)} className="aw-search-row">
          <input
            type="text"
            className="aw-input"
            placeholder="Search ticker, domain, or CODE:G..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchError(null);
            }}
          />
          <button type="submit" className="aw-btn-secondary" disabled={searchingHorizon}>
            <IconSearch size={15} />
            <span>{searchingHorizon ? "Searching..." : "Search Chain"}</span>
          </button>
        </form>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(
            [
              ["all", `All (${catalogItems.length})`],
              ["holdings", "Holdings"],
              ["official", `Official (${verifiedAssets.length + 1})`],
              ...(config.network === "mainnet"
                ? ([
                    ["oft", "Ethena & OFT"],
                    ["community", "Community Hub"],
                  ] as const)
                : []),
              ["liquid", "Liquid Pools"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="aw-chip-btn"
              aria-pressed={catalogFilter === id}
              onClick={() => setCatalogFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {searchError && (
          <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
            {searchError}
          </div>
        )}

        {catalogItems.length === 0 ? (
          <div className="aw-empty-state">
            <div style={{ fontWeight: 600, fontSize: 13 }}>No matching tokens found locally</div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Tap &ldquo;Search Chain&rdquo; above to query {config.network.toUpperCase()} Horizon
              for any asset code or issuer G... address.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
            {catalogItems.map((item) => {
              const k = tokenAssetKey(item.assetCode, item.assetIssuer);
              const tomlMeta = item.assetIssuer
                ? tokenMetaMap[`${item.assetCode.toUpperCase()}:${item.assetIssuer}`]
                : undefined;
              const isNativeItem = item.assetCode.trim().toUpperCase() === "XLM" && !item.assetIssuer;
              const rowIcon = tomlMeta?.image ?? item.icon;
              const rowFallbackIcon =
                tomlMeta?.image && item.icon && item.icon !== tomlMeta.image ? item.icon : undefined;
              const rowDomain = item.domain ?? tomlMeta?.homeDomain;
              const rowName = tomlMeta?.name ?? item.name;
              const trust = classifyTokenTrust({
                assetCode: item.assetCode,
                assetIssuer: item.assetIssuer,
                verifiedAssets,
                network: config.network,
              });
              return (
                <button
                  key={k}
                  type="button"
                  className="aw-token-row"
                  onClick={() => {
                    triggerTelegramHaptic("selection");
                    setSelectedToken({
                      assetCode: item.assetCode,
                      assetIssuer: item.assetIssuer,
                      name: rowName,
                      domain: rowDomain,
                      icon: rowIcon,
                    });
                  }}
                >
                  <div className="aw-token-row-left">
                    <TokenBadge
                      code={item.assetCode}
                      icon={rowIcon}
                      fallbackIcon={rowFallbackIcon}
                      isNative={isNativeItem}
                      trustStatus={trust.status}
                    />
                    <div style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{item.assetCode}</span>
                        {trust.status === "official" ? (
                          <span className="glass-pill glass-pill--trust" style={{ padding: "2px 7px", fontSize: 10 }}>
                            ✓ Official
                          </span>
                        ) : trust.status === "scam_spoof" ? (
                          <span className="glass-pill aw-pill-danger" style={{ padding: "2px 7px", fontSize: 10 }}>
                            ⛔ Spoof Risk
                          </span>
                        ) : (
                          <span className="glass-pill glass-pill--gold" style={{ padding: "2px 7px", fontSize: 10 }}>
                            Unverified
                          </span>
                        )}
                        {item.hasLiquidityPool && (
                          <span className="glass-pill" style={{ padding: "2px 6px", fontSize: 10 }}>
                            💧 Liquid
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--aw-ink-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.domain
                          ? item.domain
                          : item.assetIssuer
                            ? `${item.assetIssuer.slice(0, 6)}…${item.assetIssuer.slice(-4)}`
                            : "Native Protocol Asset"}
                        {item.name ? ` · ${item.name}` : ""}
                      </div>
                    </div>
                  </div>

                  <div className="aw-token-row-right">
                    <div style={{ textAlign: "right" }}>
                      {item.hasTrustline ? (
                        <div className="tabular-nums" style={{ fontWeight: 700, fontSize: 13 }}>
                          {Number(item.userBalance ?? "0").toFixed(2)}
                        </div>
                      ) : (
                        <span className="glass-pill" style={{ padding: "2px 8px", fontSize: 10 }}>
                          Inspect
                        </span>
                      )}
                      {item.numAccounts !== undefined && item.numAccounts > 0 && (
                        <div style={{ fontSize: 10, color: "var(--aw-ink-muted)" }} className="tabular-nums">
                          {formatCompactNumber(item.numAccounts)} holders
                        </div>
                      )}
                    </div>
                    <IconChevronRight size={16} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  // ============================================================================
  // VIEW 2: TOKEN INSPECTOR & SCANNER
  // ============================================================================
  const selectedKey = tokenAssetKey(selectedToken.assetCode, selectedToken.assetIssuer);
  const verifiedEntry = verifiedMap.get(selectedKey);
  const isNativeXlm =
    selectedToken.assetCode.trim().toUpperCase() === "XLM" && !selectedToken.assetIssuer;
  const trust = classifyTokenTrust({
    assetCode: selectedToken.assetCode,
    assetIssuer: selectedToken.assetIssuer,
    verifiedAssets,
    network: config.network,
  });
  const isOfficial = trust.status === "official";
  const userHolding = accountState?.balances.find(
    (b) => tokenAssetKey(b.assetCode, b.assetIssuer) === selectedKey,
  );
  const hasTrustline = isNativeXlm || Boolean(userHolding);
  const numericBalance = Number(userHolding?.balance ?? "0");
  const isClassic = activeAccount.capabilities.canSignClassicSdex;
  const selectedTomlMeta = selectedToken.assetIssuer
    ? tokenMetaMap[`${selectedToken.assetCode.toUpperCase()}:${selectedToken.assetIssuer}`]
    : undefined;
  const displayDomain =
    details?.homeDomain ?? selectedTomlMeta?.homeDomain ?? selectedToken.domain ?? verifiedEntry?.domain;
  const displayName =
    details?.name ??
    selectedTomlMeta?.name ??
    selectedToken.name ??
    verifiedEntry?.name ??
    details?.orgName;
  const displayIcon =
    details?.image ?? selectedTomlMeta?.image ?? selectedToken.icon ?? verifiedEntry?.icon;
  const fallbackIcon =
    verifiedEntry?.icon && verifiedEntry.icon !== displayIcon ? verifiedEntry.icon : undefined;
  const quoteCode = priceHistory?.quoteCode ?? (isNativeXlm && verifiedUsdcCounter ? "USDC" : "XLM");
  const positiveChange = (priceHistory?.changePct ?? 0) >= 0;
  const oracleQuote = oraclePrices[selectedToken.assetCode.trim().toUpperCase()];

  return (
    <section
      className="glass-card"
      aria-label="Stellar Token Inspector"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="aw-chip-btn" onClick={() => setSelectedToken(null)}>
          ← All Tokens
        </button>

        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {trust.status === "official" ? (
            <span className="glass-pill glass-pill--trust">
              {isNativeXlm ? "✓ Native Protocol Asset" : "✓ Official SEP-42 Verified"}
            </span>
          ) : trust.status === "scam_spoof" ? (
            <span className="glass-pill aw-pill-danger">⛔ {trust.label}</span>
          ) : (
            <span className="glass-pill glass-pill--gold">⚠ Unverified Issuer</span>
          )}
        </div>
      </div>

      {trust.status === "scam_spoof" && (
        <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
          <strong>Scam / Impostor Token Warning:</strong> {trust.reason}
        </div>
      )}

      {/* Hero Header */}
      <div className="aw-token-hero">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <TokenBadge
            code={selectedToken.assetCode}
            icon={displayIcon}
            fallbackIcon={fallbackIcon}
            isNative={isNativeXlm}
            size={46}
            trustStatus={trust.status}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
                {selectedToken.assetCode}
              </span>
              {displayDomain && <span className="glass-pill">{displayDomain}</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
              {displayName ?? (isNativeXlm ? "Stellar Lumens" : "Stellar Issued Asset")}
              {selectedToken.assetIssuer && (
                <>
                  {" · "}
                  <code>
                    {selectedToken.assetIssuer.slice(0, 6)}…{selectedToken.assetIssuer.slice(-4)}
                  </code>
                </>
              )}
            </div>
            {details?.description && (
              <div style={{ fontSize: 11, color: "var(--aw-ink-muted)", marginTop: 4 }}>
                {details.description}
              </div>
            )}
            {!isNativeXlm && !loadingDetails && !displayIcon && !fallbackIcon && (
              <div style={{ fontSize: 11, color: "var(--aw-ink-muted)", marginTop: 4 }}>
                No image published in stellar.toml
              </div>
            )}
          </div>
        </div>

        {/* Live Price + Personal Balance (Fixed minimum height prevents jitter) */}
        <div className="aw-token-price-strip">
          <div style={{ minWidth: 0, flex: "1 1 160px" }}>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
              Market Price ({quoteCode})
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="tabular-nums" style={{ fontSize: 20, fontWeight: 800 }}>
                {priceHistory?.latestPriceXlm !== null && priceHistory?.latestPriceXlm !== undefined
                  ? `${formatTokenPriceValue(priceHistory.latestPriceXlm)} ${quoteCode}`
                  : isNativeXlm
                    ? "1.0000 XLM"
                    : loadingChart
                      ? "Loading..."
                      : "No SDEX Market"}
              </span>
              {priceHistory?.changePct !== null && priceHistory?.changePct !== undefined && (
                <span
                  className={`glass-pill tabular-nums ${
                    positiveChange ? "glass-pill--trust" : "aw-pill-danger"
                  }`}
                >
                  {positiveChange ? "+" : ""}
                  {priceHistory.changePct.toFixed(2)}% ({timeframe.toUpperCase()})
                </span>
              )}
              {oracleQuote && (
                <span
                  className="glass-pill glass-pill--trust tabular-nums"
                  title="On-chain RedStone SEP-40 USD feed"
                >
                  Oracle ${oracleQuote.priceUsd < 1 ? oracleQuote.priceUsd.toFixed(4) : oracleQuote.priceUsd.toFixed(2)} USD
                </span>
              )}
            </div>
          </div>

          <div style={{ textAlign: "right", minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>Your Balance</div>
            <div className="tabular-nums" style={{ fontSize: 15, fontWeight: 700 }}>
              {userHolding
                ? `${Number(userHolding.balance).toFixed(4)} ${selectedToken.assetCode}`
                : "0.0000"}
            </div>
            <div style={{ fontSize: 10, color: hasTrustline ? "var(--aw-trust-emerald)" : "var(--aw-stellar-gold)" }}>
              {isNativeXlm
                ? "Native balance"
                : hasTrustline
                  ? "Trustline active"
                  : "No trustline (0.5 XLM reserve)"}
            </div>
          </div>
        </div>

        <div className="aw-token-actions">
          <button
            type="button"
            className="aw-btn-primary"
            disabled={!hasTrustline || numericBalance <= 0}
            onClick={() =>
              onOpenSend({
                assetCode: selectedToken.assetCode,
                assetIssuer: selectedToken.assetIssuer,
              })
            }
          >
            <IconSend size={15} />
            <span>Send</span>
          </button>

          <button
            type="button"
            className="aw-btn-secondary"
            disabled={trust.status === "scam_spoof"}
            onClick={() =>
              onOpenSwap({
                assetId: tokenSwapIdentifier(selectedToken.assetCode, selectedToken.assetIssuer),
                mode: numericBalance > 0 ? "from" : "to",
              })
            }
          >
            <IconSwap size={15} />
            <span>{numericBalance > 0 ? "Swap From" : "Swap To"}</span>
          </button>

          {!isNativeXlm && isClassic && selectedToken.assetIssuer && !hasTrustline && (
            <button
              type="button"
              className="aw-btn-gold"
              disabled={trustBusy || trust.status === "scam_spoof"}
              onClick={() => void handleToggleTrustline(true)}
            >
              <span>{trustBusy ? "Activating..." : "+ Add Trustline"}</span>
            </button>
          )}

          {!isNativeXlm && isClassic && selectedToken.assetIssuer && hasTrustline && numericBalance === 0 && (
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={trustBusy}
              onClick={() => void handleReclaimZero()}
            >
              <span>{trustBusy ? "Reclaiming..." : "Reclaim 0.5 XLM"}</span>
            </button>
          )}

          {config.astrodexBotUsername && (
            <button
              type="button"
              className="aw-btn-primary"
              style={{
                gridColumn: "1 / -1",
                background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
              }}
              onClick={() => {
                triggerTelegramHaptic("selection");
                const base = config.astrodexMiniAppShortName
                  ? `https://t.me/${config.astrodexBotUsername}/${config.astrodexMiniAppShortName}`
                  : `https://t.me/${config.astrodexBotUsername}`;
                const param = `${config.network}_token_${
                  selectedToken.assetIssuer
                    ? `${selectedToken.assetCode}_${selectedToken.assetIssuer}`
                    : selectedToken.assetCode
                }`;
                openTelegramMiniAppLink(`${base}?startapp=${encodeURIComponent(param)}`);
              }}
            >
              <IconChart size={15} />
              <span>Open Pro Chart &amp; Orderbook in AstroDex ↗</span>
            </button>
          )}
        </div>
      </div>

      {detailError && <div className="aw-banner aw-banner--warn">{detailError}</div>}

      {/* Progressive Disclosure Sub-Tabs */}
      <div className="aw-dev-tabs" role="tablist" aria-label="Token inspector views">
        {(
          [
            ["overview", "Chart & Stats"],
            ["holders", "Holders & Pools"],
            ["orderbook", "Orderbook & Trades"],
            ["security", "Scanner & Security"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={inspectorTab === id}
            aria-pressed={inspectorTab === id}
            className="aw-chip-btn"
            onClick={() => {
              triggerTelegramHaptic("selection");
              setInspectorTab(id);
            }}
          >
            {id === "overview" && <IconChart size={13} />}
            {id === "holders" && <IconSearch size={13} />}
            {id === "orderbook" && <IconRefresh size={13} />}
            {id === "security" && <IconShield size={13} />}
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* TAB 1: CHART & STATS */}
      {inspectorTab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--aw-ink-secondary)" }}>
              Historical Price ({quoteCode})
              {loadingChart && (
                <span className="glass-pill" style={{ marginLeft: 6, padding: "1px 6px", fontSize: 10 }}>
                  Updating…
                </span>
              )}
              {priceHistory && priceHistory.candles.length >= 2 && (
                <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                  ({new Date(priceHistory.candles[0]!.timestamp).toLocaleDateString()} →{" "}
                  {new Date(
                    priceHistory.candles[priceHistory.candles.length - 1]!.timestamp,
                  ).toLocaleDateString()}
                  )
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="aw-mini-chip"
                aria-pressed={chartMode === "candles"}
                onClick={() => setChartMode((m) => (m === "candles" ? "area" : "candles"))}
              >
                {chartMode === "candles" ? "Candles" : "Area"}
              </button>
              <button
                type="button"
                className="aw-mini-chip"
                onClick={() => setChartExpanded(true)}
                title="Expand chart fullscreen"
              >
                ⤢ Expand
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["24h", "7d", "30d", "1y", "all"] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                className="aw-chip-btn"
                aria-pressed={timeframe === tf}
                onClick={() => setTimeframe(tf)}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          {loadingChart && !priceHistory ? (
            <div className="aw-token-chart-box" style={{ justifyContent: "center", alignContent: "center", textAlign: "center", fontSize: 12 }}>
              Loading Horizon trade aggregations...
            </div>
          ) : (
            <LightweightPriceChart
              candles={priceHistory?.candles ?? []}
              quoteCode={quoteCode}
              positive={positiveChange}
              chartMode={chartMode}
              timeframe={timeframe}
            />
          )}

          {chartExpanded && (
            <div
              className="aw-chart-expanded"
              role="dialog"
              aria-label="Expanded Market Chart"
              onClick={(e) => {
                if (e.target === e.currentTarget) setChartExpanded(false);
              }}
            >
              <div className="aw-chart-expanded-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>
                      {selectedToken.assetCode} / {quoteCode}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      Touch &amp; drag across candles for OHLCV telemetry
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      type="button"
                      className="aw-chip-btn"
                      aria-pressed={chartMode === "candles"}
                      onClick={() => setChartMode((m) => (m === "candles" ? "area" : "candles"))}
                    >
                      {chartMode === "candles" ? "Candles" : "Area"}
                    </button>
                    <button
                      type="button"
                      className="aw-btn-secondary"
                      onClick={() => setChartExpanded(false)}
                    >
                      Close ✕
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["24h", "7d", "30d", "1y", "all"] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      className="aw-chip-btn"
                      aria-pressed={timeframe === tf}
                      onClick={() => setTimeframe(tf)}
                    >
                      {tf.toUpperCase()}
                    </button>
                  ))}
                </div>
                <LightweightPriceChart
                  candles={priceHistory?.candles ?? []}
                  quoteCode={quoteCode}
                  positive={positiveChange}
                  chartMode={chartMode}
                  timeframe={timeframe}
                  expanded
                />
              </div>
            </div>
          )}

          <div className="aw-token-stats-grid">
            <div className="aw-stat-tile">
              <span className="aw-stat-label">
                {isNativeXlm ? "Total Ledger Supply" : "Circulating Supply"}
              </span>
              <strong className="aw-stat-value tabular-nums">
                {loadingDetails
                  ? "…"
                  : `${formatCompactNumber(details?.supplyAmount)} ${selectedToken.assetCode}`}
              </strong>
            </div>
            <div className="aw-stat-tile">
              <span className="aw-stat-label">
                {isNativeXlm ? "Latest Ledger & Protocol" : "Holders (Trustlines)"}
              </span>
              <strong className="aw-stat-value tabular-nums">
                {loadingDetails
                  ? "…"
                  : isNativeXlm
                    ? details?.latestLedgerSequence
                      ? `#${details.latestLedgerSequence.toLocaleString()} (v${details.protocolVersion ?? "?"})`
                      : "Live Horizon"
                    : formatCompactNumber(details?.numAccounts)}
              </strong>
            </div>
            <div className="aw-stat-tile">
              <span className="aw-stat-label">
                {isNativeXlm ? "Base Fee / Reserve" : `${timeframe.toUpperCase()} High / Low`}
              </span>
              <strong className="aw-stat-value tabular-nums">
                {isNativeXlm
                  ? loadingDetails
                    ? "…"
                    : details?.baseFeeStroops !== undefined
                      ? `${details.baseFeeStroops} str / ${((details.baseReserveStroops ?? 5_000_000) / 10_000_000).toFixed(1)} XLM`
                      : "100 str / 0.5 XLM"
                  : priceHistory?.high
                    ? `${formatTokenPriceValue(priceHistory.high)} / ${formatTokenPriceValue(priceHistory.low)}`
                    : "—"}
              </strong>
            </div>
            <div className="aw-stat-tile">
              <span className="aw-stat-label">
                {isNativeXlm
                  ? priceHistory?.high
                    ? `${timeframe.toUpperCase()} High / Low (${quoteCode})`
                    : "Max Tx Set"
                  : "AMM Pools / Volume"}
              </span>
              <strong className="aw-stat-value tabular-nums">
                {isNativeXlm
                  ? priceHistory?.high
                    ? `${formatTokenPriceValue(priceHistory.high)} / ${formatTokenPriceValue(priceHistory.low)}`
                    : details?.maxTxSetSize
                      ? `${details.maxTxSetSize} ops/ledger`
                      : "—"
                  : details?.liquidityPoolsAmount
                    ? `${formatCompactNumber(details.liquidityPoolsAmount)} in Pools`
                    : priceHistory?.volumeBase
                      ? `${formatCompactNumber(priceHistory.volumeBase)} Vol`
                      : "—"}
              </strong>
            </div>
          </div>

          {/* Stellar.Expert-Style Asset Summary */}
          <div className="aw-contract-seals" style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Summary</div>
            {details?.sacContractId && (
              <div className="aw-seal-row">
                <span>Soroban Contract</span>
                <button
                  type="button"
                  className="aw-mini-chip"
                  onClick={() => void handleCopy("sac_summary", details.sacContractId!)}
                >
                  {copiedField === "sac_summary" ? <IconCheck size={11} /> : <IconCopy size={11} />}
                  <code>
                    {details.sacContractId.slice(0, 5)}…{details.sacContractId.slice(-5)}
                  </code>
                </button>
              </div>
            )}
            <div className="aw-seal-row">
              <span>On-Chain Rating</span>
              <span className="glass-pill glass-pill--trust tabular-nums">
                {computeOnChainAssetScore({
                  isNativeXlm,
                  isOfficial,
                  isSpoof: trust.status === "scam_spoof",
                  hasDomain: Boolean(displayDomain),
                  details,
                  poolCount: liquidityPools.length,
                }).toFixed(1)}{" "}
                / 10
              </span>
            </div>
            {details?.supplyAmount && (
              <div className="aw-seal-row">
                <span>Total Supply</span>
                <code className="tabular-nums">
                  {Math.round(Number(details.supplyAmount)).toLocaleString()} {selectedToken.assetCode}
                </code>
              </div>
            )}
            {displayDomain && (
              <div className="aw-seal-row">
                <span>Home Domain</span>
                <code>{displayDomain}</code>
              </div>
            )}
            {!isNativeXlm && details && (
              <>
                <div className="aw-seal-row">
                  <span>Trustlines (Holders)</span>
                  <code className="tabular-nums">
                    {formatCompactNumber(details.numAccounts)} Auth ·{" "}
                    {formatCompactNumber(details.authorizedToMaintainLiabilitiesAccounts ?? 0)} Maint ·{" "}
                    {formatCompactNumber(details.unauthorizedAccounts ?? 0)} Unauth
                  </code>
                </div>
                <div className="aw-seal-row">
                  <span>On-Chain Distribution</span>
                  <code className="tabular-nums">
                    Pools: {details.numLiquidityPools ?? liquidityPools.length} · Claimables:{" "}
                    {details.numClaimableBalances ?? 0} · Contracts: {details.numContracts ?? 0}
                  </code>
                </div>
              </>
            )}
            {userHolding && (
              <div className="aw-seal-row">
                <span>Your Trustline</span>
                <code className="tabular-nums">
                  Limit: {userHolding.limit ? formatCompactNumber(userHolding.limit) : "Max"} ·
                  Sell Liab: {userHolding.sellingLiabilities ?? "0"} ·{" "}
                  {userHolding.isAuthorized === false ? "Frozen" : "Authorized"}
                </code>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: TOP HOLDERS & AMM POOLS */}
      {inspectorTab === "holders" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          {(accountState?.liquidityPoolPositions?.length ?? 0) > 0 && (() => {
            const matchingUserPools = accountState!.liquidityPoolPositions!.filter((lp) =>
              lp.reserves.some((r) =>
                isNativeXlm
                  ? r.assetCode === "XLM" && !r.assetIssuer
                  : r.assetCode.toUpperCase() === selectedToken.assetCode.toUpperCase() &&
                    r.assetIssuer === selectedToken.assetIssuer,
              ),
            );
            if (matchingUserPools.length === 0) return null;
            return (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  Your Active AMM Positions ({matchingUserPools.length})
                </div>
                {matchingUserPools.map((lp) => (
                  <div key={lp.poolId} className="aw-list-row" style={{ fontSize: 12 }}>
                    <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                      <div style={{ fontWeight: 700 }}>
                        {lp.reserves
                          .map((r) => `${formatCompactNumber(r.userAmount)} ${r.assetCode}`)
                          .join(" + ")}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                        Pool {lp.poolId.slice(0, 8)}…{lp.poolId.slice(-6)} · Share {lp.sharePct.toFixed(4)}%
                      </div>
                    </div>
                    <span className="glass-pill glass-pill--trust">LP Active</span>
                  </div>
                ))}
              </div>
            );
          })()}

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {isNativeXlm
                ? `Active XLM Holders Sample (${holders.length})`
                : `Top On-Chain Holders (${holders.length})`}
            </div>
            {holders.length === 0 ? (
              <div className="aw-empty-state" style={{ fontSize: 12 }}>
                No public holder records returned by Horizon right now.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {holders.map((h, idx) => (
                  <div key={h.address} className="aw-seal-row tabular-nums" style={{ fontSize: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span className="glass-pill" style={{ padding: "1px 6px", fontSize: 10 }}>
                        #{idx + 1}
                      </span>
                      {onInspectAddress ? (
                        <button
                          type="button"
                          className="aw-mini-chip"
                          onClick={() => onInspectAddress(h.address)}
                        >
                          <code>
                            {h.address.slice(0, 6)}…{h.address.slice(-5)}
                          </code>
                        </button>
                      ) : (
                        <code>
                          {h.address.slice(0, 6)}…{h.address.slice(-5)}
                        </code>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <strong>{formatCompactNumber(h.balance)}</strong>
                      {h.sharePct !== null && (
                        <span style={{ fontSize: 10, color: "var(--aw-ink-secondary)", marginLeft: 6 }}>
                          ({h.sharePct.toFixed(2)}%)
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              Active AMM Liquidity Pools ({liquidityPools.length})
            </div>
            {liquidityPools.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                No active Stellar AMM liquidity pools found for {selectedToken.assetCode}.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {liquidityPools.map((pool) => (
                  <div key={pool.id} className="aw-list-row" style={{ fontSize: 12 }}>
                    <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
                      <div style={{ fontWeight: 700 }}>
                        {pool.reserves
                          .map((r) => {
                            const code = r.asset === "native" ? "XLM" : (r.asset.split(":")[0] ?? "ASSET");
                            return `${formatCompactNumber(r.amount)} ${code}`;
                          })
                          .join(" / ")}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                        Pool {pool.id.slice(0, 8)}…{pool.id.slice(-6)} · {pool.totalTrustlines} LPs
                      </div>
                    </div>
                    <span className="glass-pill tabular-nums">
                      {formatCompactNumber(pool.totalShares)} shares
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {config.astrodexBotUsername && (
              <button
                type="button"
                className="aw-btn-secondary"
                style={{ flex: "1 1 180px" }}
                onClick={() =>
                  openTelegramMiniAppLink(
                    `${
                      config.astrodexMiniAppShortName
                        ? `https://t.me/${config.astrodexBotUsername}/${config.astrodexMiniAppShortName}`
                        : `https://t.me/${config.astrodexBotUsername}`
                    }?startapp=${encodeURIComponent(`${config.network}_tab_book`)}`,
                  )
                }
              >
                <IconChart size={14} />
                <span>Explore Deep Pools on AstroDex</span>
              </button>
            )}
            {config.explorerBaseUrl && (
              <button
                type="button"
                className="aw-btn-secondary"
                style={{ flex: "1 1 180px" }}
                onClick={() =>
                  openExternalUrl(
                    selectedToken.assetIssuer
                      ? `${config.explorerBaseUrl!.replace(/\/+$/, "")}/asset/${encodeURIComponent(`${selectedToken.assetCode}-${selectedToken.assetIssuer}`)}?filter=asset-holders`
                      : `${config.explorerBaseUrl!.replace(/\/+$/, "")}/asset/XLM?filter=asset-holders`,
                  )
                }
              >
                <span>Full Holders List</span>
                <IconExternalLink size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: ON-CHAIN SCANNER & ISSUER SECURITY */}
      {inspectorTab === "security" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
          {!isOfficial && (
            <div
              className={trust.status === "scam_spoof" ? "aw-banner aw-banner--danger" : "aw-banner aw-banner--warn"}
              style={{ fontSize: 12 }}
            >
              <strong>{trust.status === "scam_spoof" ? "Spoof / Scam Alert:" : "Unverified Asset Caution:"}</strong>{" "}
              {trust.reason}
            </div>
          )}

          <div className="aw-contract-seals">
            {selectedToken.assetIssuer && (
              <div className="aw-seal-row">
                <span>Issuer Account (G...)</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                  <code>{selectedToken.assetIssuer}</code>
                  <button
                    type="button"
                    className="aw-mini-chip"
                    onClick={() => void handleCopy("issuer", selectedToken.assetIssuer!)}
                  >
                    {copiedField === "issuer" ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    <span>{copiedField === "issuer" ? "Copied" : "Copy"}</span>
                  </button>
                  {config.explorerBaseUrl && (
                    <button
                      type="button"
                      className="aw-mini-chip"
                      onClick={() =>
                        openExternalUrl(`${config.explorerBaseUrl!.replace(/\/+$/, "")}/account/${selectedToken.assetIssuer}`)
                      }
                    >
                      <span>Explorer</span>
                      <IconExternalLink size={11} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {details?.sacContractId && (
              <div className="aw-seal-row">
                <span>Soroban SAC Contract (C...)</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                  <code>{details.sacContractId}</code>
                  <button
                    type="button"
                    className="aw-mini-chip"
                    onClick={() => void handleCopy("sac", details.sacContractId)}
                  >
                    {copiedField === "sac" ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    <span>{copiedField === "sac" ? "Copied" : "Copy"}</span>
                  </button>
                  {config.explorerBaseUrl && (
                    <button
                      type="button"
                      className="aw-mini-chip"
                      onClick={() =>
                        openExternalUrl(`${config.explorerBaseUrl!.replace(/\/+$/, "")}/contract/${details.sacContractId}`)
                      }
                    >
                      <span>Contract</span>
                      <IconExternalLink size={11} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="aw-seal-row">
              <span>Home Domain (stellar.toml)</span>
              {displayDomain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(displayDomain) ? (
                <button
                  type="button"
                  className="aw-mini-chip"
                  style={{ color: "var(--aw-stellar-gold)", textDecoration: "underline" }}
                  onClick={() => openExternalUrl(`https://${displayDomain}/.well-known/stellar.toml`)}
                >
                  <code>{displayDomain} ↗</code>
                </button>
              ) : displayDomain ? (
                <code>{displayDomain}</code>
              ) : (
                <code>Not declared on issuer</code>
              )}
            </div>
            {(details?.orgName || details?.anchorAsset) && (
              <div className="aw-seal-row">
                <span>Organization / Anchor</span>
                <code>
                  {details.orgName ?? "Verified Issuer"}
                  {details.isAssetAnchored && details.anchorAsset
                    ? ` · Anchored (${details.anchorAsset})`
                    : ""}
                </code>
              </div>
            )}
          </div>

          {details && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                Stellar Issuer Control Flags &amp; Risk Audit
              </div>

              <div className="aw-flag-card">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12 }}>AUTH_IMMUTABLE</div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    {details.flags.authImmutable
                      ? "Issuer flags are permanently locked on-ledger."
                      : "Issuer can modify account flags in the future."}
                  </div>
                </div>
                <span className={`glass-pill ${details.flags.authImmutable ? "glass-pill--trust" : ""}`}>
                  {details.flags.authImmutable ? "Locked" : "Mutable"}
                </span>
              </div>

              <div className="aw-flag-card">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12 }}>AUTH_CLAWBACK_ENABLED</div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    {details.flags.authClawbackEnabled
                      ? "Regulated asset: issuer can reclaim balances if required by compliance."
                      : "Disabled: issuer cannot claw back your balance."}
                  </div>
                </div>
                <span
                  className={`glass-pill ${
                    details.flags.authClawbackEnabled ? "glass-pill--gold" : "glass-pill--trust"
                  }`}
                >
                  {details.flags.authClawbackEnabled ? "Enabled" : "Safe / Off"}
                </span>
              </div>

              <div className="aw-flag-card">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12 }}>AUTH_REVOCABLE</div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    {details.flags.authRevocable
                      ? "Issuer can freeze trustline authorization."
                      : "Disabled: trustlines cannot be frozen."}
                  </div>
                </div>
                <span
                  className={`glass-pill ${
                    details.flags.authRevocable ? "glass-pill--gold" : "glass-pill--trust"
                  }`}
                >
                  {details.flags.authRevocable ? "Can Freeze" : "Safe / Off"}
                </span>
              </div>

              <div className="aw-flag-card">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12 }}>AUTH_REQUIRED</div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    {details.flags.authRequired
                      ? "KYC / explicit issuer approval required before holding."
                      : "Permissionless: any account can open a trustline."}
                  </div>
                </div>
                <span className="glass-pill">
                  {details.flags.authRequired ? "Approval Req" : "Open"}
                </span>
              </div>
            </div>
          )}

          {config.explorerBaseUrl && (
            <button
              type="button"
              className="aw-btn-secondary"
              onClick={() =>
                openExternalUrl(
                  selectedToken.assetIssuer
                    ? `${config.explorerBaseUrl!.replace(/\/+$/, "")}/asset/${encodeURIComponent(`${selectedToken.assetCode}-${selectedToken.assetIssuer}`)}`
                    : `${config.explorerBaseUrl!.replace(/\/+$/, "")}/asset/XLM`,
                )
              }
            >
              <span>Inspect on External Stellar Explorer</span>
              <IconExternalLink size={14} />
            </button>
          )}
        </div>
      )}

      {/* TAB 3: LIVE SDEX ORDERBOOK */}
      {inspectorTab === "orderbook" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>
              SDEX Orderbook ({selectedToken.assetCode} / {orderbook?.quoteCode ?? quoteCode})
            </span>
            {orderbook?.spreadPct && (
              <span className="glass-pill tabular-nums">Spread: {orderbook.spreadPct}%</span>
            )}
          </div>

          {!orderbook || (orderbook.bids.length === 0 && orderbook.asks.length === 0) ? (
            <div className="aw-empty-state">
              <div style={{ fontWeight: 600, fontSize: 13 }}>Empty SDEX orderbook for this pair</div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Liquidity may still exist through multi-hop Soroswap AMM or Horizon path routing.
              </div>
            </div>
          ) : (
            <div className="aw-orderbook-grid">
              <div className="aw-stat-tile">
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--aw-trust-emerald)", marginBottom: 4 }}>
                  Top Bids (Buy)
                </div>
                {orderbook.bids.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--aw-ink-muted)" }}>No bids</div>
                ) : (
                  orderbook.bids.map((b, idx) => (
                    <div key={`bid-${idx}`} className="aw-ob-row tabular-nums">
                      <span style={{ color: "var(--aw-trust-emerald)" }}>{Number(b.price).toFixed(5)}</span>
                      <span>{formatCompactNumber(b.amount)}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="aw-stat-tile">
                <div style={{ fontSize: 11, fontWeight: 700, color: "#ffb396", marginBottom: 4 }}>
                  Top Asks (Sell)
                </div>
                {orderbook.asks.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--aw-ink-muted)" }}>No asks</div>
                ) : (
                  orderbook.asks.map((a, idx) => (
                    <div key={`ask-${idx}`} className="aw-ob-row tabular-nums">
                      <span style={{ color: "#ffb396" }}>{Number(a.price).toFixed(5)}</span>
                      <span>{formatCompactNumber(a.amount)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              Recent SDEX / AMM Trades ({recentTrades.length})
            </div>
            {recentTrades.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--aw-ink-muted)" }}>
                No recent trades recorded on Horizon for this pair.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {recentTrades.slice(0, 10).map((t) => (
                  <div
                    key={t.id}
                    className="aw-seal-row tabular-nums"
                    style={{ fontSize: 11 }}
                  >
                    <span
                      style={{
                        color: t.isBuy ? "var(--aw-trust-emerald)" : "#ffb396",
                        fontWeight: 700,
                      }}
                    >
                      {t.isBuy ? "BUY" : "SELL"} {formatCompactNumber(t.baseAmount)}{" "}
                      {selectedToken.assetCode} @ {t.price} {quoteCode}
                    </span>
                    <span style={{ color: "var(--aw-ink-muted)" }}>
                      {new Date(t.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
