import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  calculateMinReceivedStroops7,
  createCompositeSwapEngine,
  createHorizonPathSwapAdapter,
  createSoroswapProxyAdapter,
  decimalToStroops7,
  parseSwapAssetIdentifier,
  stroops7ToDecimal,
  type ParsedSwapAsset,
} from "@astrowallet/defi";
import type { ClassicAddress, SwapQuote } from "@astrowallet/domain";
import type { VerifiedAssetEntry } from "@astrowallet/security-shield";
import {
  fetchTokenOnChainDetails,
  type HeldTokenTomlMetadata,
  type StellarTokenDetails,
  type TokenCatalogItem,
} from "@astrowallet/stellar-core";
import { fetchCachedLiquidAssets, readCachedEntry } from "../state/market-cache.js";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, triggerTelegramHaptic } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import {
  IconChart,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconFlip,
  IconRefresh,
  IconShield,
  IconZap,
} from "./Icons.js";
import { TokenBadge } from "./TokenBadge.js";
import {
  classifyTokenTrust,
  formatCompactNumber,
  resolveMissingSwapTrustline,
  resolveSwapAssetInput,
  tokenAssetKey,
  tokenSwapIdentifier,
  type TokenTrustVerdict,
} from "./token-catalog.js";

const SLIPPAGE_OPTIONS: ReadonlyArray<{ bps: number; label: string }> = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1.0%" },
  { bps: 200, label: "2.0%" },
  { bps: 500, label: "5.0%" },
];

function safeParseSwapAsset(raw: string): ParsedSwapAsset | null {
  if (!raw.trim()) return null;
  try {
    return parseSwapAssetIdentifier(raw);
  } catch {
    return null;
  }
}

function TokenSwapPreviewCard({
  roleLabel,
  parsed,
  verifiedEntry,
  tomlMeta,
  trust,
  details,
  balance,
  onInspect,
}: {
  roleLabel: string;
  parsed: ParsedSwapAsset | null;
  verifiedEntry?: VerifiedAssetEntry | undefined;
  tomlMeta?: HeldTokenTomlMetadata | undefined;
  trust: TokenTrustVerdict | null;
  details: StellarTokenDetails | null;
  balance?: string | undefined;
  onInspect?: (() => void) | undefined;
}) {
  if (!parsed || !trust) {
    return (
      <div className="aw-token-card-preview aw-token-card-preview--empty">
        <span style={{ fontSize: 12, color: "var(--aw-ink-muted)" }}>
          Select or type a {roleLabel.toLowerCase()} asset (e.g. XLM, USDC, or CODE:G...)
        </span>
      </div>
    );
  }

  const isNative = parsed.code.toUpperCase() === "XLM" && !parsed.issuer;
  const domain =
    details?.homeDomain ??
    tomlMeta?.homeDomain ??
    verifiedEntry?.domain ??
    (isNative ? "stellar.org" : undefined);
  const name =
    details?.name ??
    tomlMeta?.name ??
    verifiedEntry?.name ??
    details?.orgName ??
    (isNative ? "Stellar Lumens" : undefined);
  const iconUrl = details?.image ?? tomlMeta?.image ?? verifiedEntry?.icon;
  const fallbackIconUrl =
    verifiedEntry?.icon && verifiedEntry.icon !== iconUrl ? verifiedEntry.icon : undefined;
  const badgeClass =
    trust.status === "official"
      ? "glass-pill glass-pill--trust"
      : trust.status === "scam_spoof"
        ? "glass-pill aw-pill-danger"
        : "glass-pill glass-pill--gold";

  return (
    <div
      className={`aw-token-card-preview ${
        trust.status === "scam_spoof" ? "aw-token-card-preview--danger" : ""
      }`}
    >
      <div className="aw-token-card-head">
        <div className="aw-token-row-left">
          <TokenBadge
            code={parsed.code}
            icon={iconUrl}
            fallbackIcon={fallbackIconUrl}
            isNative={isNative}
            size={34}
            trustStatus={trust.status}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>{parsed.code}</strong>
              <span className={badgeClass} style={{ padding: "2px 7px", fontSize: 10 }}>
                {trust.status === "official"
                  ? `✓ ${trust.label}`
                  : trust.status === "scam_spoof"
                    ? `⛔ ${trust.label}`
                    : `⚠ ${trust.label}`}
              </span>
              {domain && (
                <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>{domain}</span>
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
              {name ? `${name} · ` : ""}
              {parsed.issuer
                ? `${parsed.issuer.slice(0, 6)}…${parsed.issuer.slice(-4)}`
                : "Native Protocol Asset"}
              {balance !== undefined ? ` · Bal: ${Number(balance).toFixed(4)}` : ""}
              {details && !isNative && details.numAccounts > 0
                ? ` · ${formatCompactNumber(details.numAccounts)} holders`
                : ""}
            </div>
          </div>
        </div>

        {onInspect && (
          <button type="button" className="aw-mini-chip" onClick={onInspect}>
            <IconChart size={11} />
            <span>Inspect</span>
          </button>
        )}
      </div>

      {trust.status === "scam_spoof" && (
        <div className="aw-token-card-alert aw-token-card-alert--danger">
          <IconShield size={13} />
          <span>{trust.reason}</span>
        </div>
      )}

      {trust.status === "unverified" && (
        <div className="aw-token-card-alert aw-token-card-alert--warn">
          <IconShield size={13} />
          <span>
            {details?.flags.authClawbackEnabled || details?.flags.authRevocable
              ? "Issuer has Clawback/Freeze flags enabled. Verify before swapping."
              : trust.reason}
          </span>
        </div>
      )}
    </div>
  );
}

export function SwapSheet({
  initialFromAsset,
  initialToAsset,
  onInspectToken,
}: {
  initialFromAsset?: string | undefined;
  initialToAsset?: string | undefined;
  onInspectToken?:
    | ((target: { assetCode: string; assetIssuer?: string | undefined }) => void)
    | undefined;
}) {
  const {
    config,
    activeAccount,
    accountState,
    verifiedAssets,
    tokenMetaMap,
    addOrRemoveTrustline,
    executePathSwap,
    signAndSubmitRawXdrWithShield,
    showToast,
  } = useWallet();

  const heldIdentifiers = useMemo(() => {
    const balances = accountState?.balances ?? [];
    if (balances.length === 0) {
      return [{ id: "XLM", label: "XLM", balance: "0" }];
    }
    return balances.map((b) => ({
      id: tokenSwapIdentifier(b.assetCode, b.assetIssuer),
      label: b.assetCode,
      balance: b.balance,
    }));
  }, [accountState?.balances]);

  const [liquidAssets, setLiquidAssets] = useState<TokenCatalogItem[]>([]);
  const [fromAsset, setFromAsset] = useState(() => initialFromAsset || "XLM");
  const [toAsset, setToAsset] = useState(() => initialToAsset || "");
  const [amount, setAmount] = useState("10");
  const [slippageBps, setSlippageBps] = useState<number>(100);

  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [swapPhase, setSwapPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  const [fromDetails, setFromDetails] = useState<StellarTokenDetails | null>(null);
  const [toDetails, setToDetails] = useState<StellarTokenDetails | null>(null);

  const quoteSeqRef = useRef(0);
  const autoPickedToRef = useRef(Boolean(initialToAsset));

  const balances = accountState?.balances ?? [];

  // Discover live functional tokens with active pools / trustlines via 3-tier SWR cache
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `liquid:${config.network}:12`;
    void readCachedEntry<TokenCatalogItem[]>(cacheKey, 24 * 60 * 60 * 1000).then((hit) => {
      if (!cancelled && hit) setLiquidAssets(hit.data);
    });
    void fetchCachedLiquidAssets({
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
      horizonUrls: config.horizonUrls,
      limit: 12,
    })
      .then((items) => {
        if (!cancelled) {
          setLiquidAssets(items);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config.horizonUrls, config.apiBaseUrl, config.network]);

  // Auto-pick a functional default destination token when Swap opens without initialToAsset
  useEffect(() => {
    if (autoPickedToRef.current || toAsset.trim().length > 0) return;
    const verifiedCandidate = verifiedAssets.find(
      (v) => tokenSwapIdentifier(v.code, v.issuer) !== fromAsset,
    );
    if (verifiedCandidate) {
      autoPickedToRef.current = true;
      setToAsset(tokenSwapIdentifier(verifiedCandidate.code, verifiedCandidate.issuer));
      return;
    }
    const liquidCandidate = liquidAssets.find(
      (l) => l.assetIssuer && tokenSwapIdentifier(l.assetCode, l.assetIssuer) !== fromAsset,
    );
    if (liquidCandidate?.assetIssuer) {
      autoPickedToRef.current = true;
      setToAsset(tokenSwapIdentifier(liquidCandidate.assetCode, liquidCandidate.assetIssuer));
    }
  }, [verifiedAssets, liquidAssets, fromAsset, toAsset]);

  const resolvedFrom = useMemo(
    () => resolveSwapAssetInput(fromAsset, verifiedAssets, balances, liquidAssets),
    [fromAsset, verifiedAssets, balances, liquidAssets],
  );

  const resolvedTo = useMemo(
    () => resolveSwapAssetInput(toAsset, verifiedAssets, balances, liquidAssets),
    [toAsset, verifiedAssets, balances, liquidAssets],
  );

  const fromParsed = useMemo(() => safeParseSwapAsset(resolvedFrom), [resolvedFrom]);
  const toParsed = useMemo(() => safeParseSwapAsset(resolvedTo), [resolvedTo]);

  const verifiedMap = useMemo(() => {
    const map = new Map<string, VerifiedAssetEntry>();
    for (const v of verifiedAssets) {
      map.set(tokenAssetKey(v.code, v.issuer), v);
    }
    return map;
  }, [verifiedAssets]);

  const fromTrust = useMemo(
    () =>
      fromParsed
        ? classifyTokenTrust({
            assetCode: fromParsed.code,
            assetIssuer: fromParsed.issuer,
            verifiedAssets,
          })
        : null,
    [fromParsed, verifiedAssets],
  );

  const toTrust = useMemo(
    () =>
      toParsed
        ? classifyTokenTrust({
            assetCode: toParsed.code,
            assetIssuer: toParsed.issuer,
            verifiedAssets,
          })
        : null,
    [toParsed, verifiedAssets],
  );

  const fromVerified = fromParsed
    ? verifiedMap.get(tokenAssetKey(fromParsed.code, fromParsed.issuer))
    : undefined;
  const toVerified = toParsed
    ? verifiedMap.get(tokenAssetKey(toParsed.code, toParsed.issuer))
    : undefined;

  const fromHolding = heldIdentifiers.find((h) => h.id === resolvedFrom);
  const toHolding = heldIdentifiers.find((h) => h.id === resolvedTo);

  const { parsed: parsedDestForTrust, missingTrustline: missingDestTrustline } = useMemo(
    () =>
      resolveMissingSwapTrustline({
        toAsset: resolvedTo,
        balances,
      }),
    [resolvedTo, balances],
  );

  const isClassic = Boolean(activeAccount?.capabilities.canSignClassicSdex);
  const hasScamSpoof = fromTrust?.status === "scam_spoof" || toTrust?.status === "scam_spoof";

  // Fetch live on-chain metadata/flags for selected From and To tokens
  useEffect(() => {
    if (!fromParsed) {
      setFromDetails(null);
      return undefined;
    }
    if (fromParsed.code !== "XLM" && !fromParsed.issuer) {
      setFromDetails(null);
      return undefined;
    }
    let cancelled = false;
    void fetchTokenOnChainDetails({
      horizonUrls: config.horizonUrls,
      networkPassphrase: config.networkPassphrase,
      assetCode: fromParsed.code,
      assetIssuer: fromParsed.issuer as ClassicAddress | undefined,
      apiBaseUrl: config.apiBaseUrl,
    })
      .then((det) => {
        if (!cancelled) setFromDetails(det);
      })
      .catch(() => {
        if (!cancelled) setFromDetails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fromParsed, config.horizonUrls, config.networkPassphrase, config.apiBaseUrl]);

  useEffect(() => {
    if (!toParsed) {
      setToDetails(null);
      return undefined;
    }
    if (toParsed.code !== "XLM" && !toParsed.issuer) {
      setToDetails(null);
      return undefined;
    }
    let cancelled = false;
    void fetchTokenOnChainDetails({
      horizonUrls: config.horizonUrls,
      networkPassphrase: config.networkPassphrase,
      assetCode: toParsed.code,
      assetIssuer: toParsed.issuer as ClassicAddress | undefined,
      apiBaseUrl: config.apiBaseUrl,
    })
      .then((det) => {
        if (!cancelled) setToDetails(det);
      })
      .catch(() => {
        if (!cancelled) setToDetails(null);
      });
    return () => {
      cancelled = true;
    };
  }, [toParsed, config.horizonUrls, config.networkPassphrase, config.apiBaseUrl]);

  const minReceived = useMemo(() => {
    if (!quote) return "0";
    try {
      return stroops7ToDecimal(
        calculateMinReceivedStroops7(quote.expectedOutputAmount, slippageBps),
      );
    } catch {
      return "0";
    }
  }, [quote, slippageBps]);

  const fetchLiveQuote = useCallback(async () => {
    const cleanAmount = amount.trim();
    if (!resolvedFrom || !resolvedTo || !cleanAmount) {
      setQuote(null);
      setQuoting(false);
      return;
    }
    if (!/^\d+(\.\d{1,7})?$/.test(cleanAmount) || Number(cleanAmount) <= 0) {
      setQuote(null);
      setError("Enter a valid positive swap amount (up to 7 decimals).");
      return;
    }
    if (resolvedFrom.toUpperCase() === resolvedTo.toUpperCase()) {
      setQuote(null);
      setError("Source and destination assets must be different.");
      return;
    }
    if (!fromParsed || !toParsed) {
      setQuote(null);
      return;
    }
    if (
      (fromParsed.code !== "XLM" && !fromParsed.issuer) ||
      (toParsed.code !== "XLM" && !toParsed.issuer)
    ) {
      setQuote(null);
      setError(
        `Enter full CODE:G... issuer for ${toParsed.issuer ? fromParsed.code : toParsed.code} or pick from Official / Liquid tokens below.`,
      );
      return;
    }

    const seq = ++quoteSeqRef.current;
    setQuoting(true);
    setError(null);

    try {
      const engine = createCompositeSwapEngine({
        soroswapAdapter: createSoroswapProxyAdapter({
          apiBaseUrl: config.apiBaseUrl,
          network: config.network,
        }),
        horizonAdapter: createHorizonPathSwapAdapter({
          horizonUrls: config.horizonUrls,
        }),
      });

      const res = await engine.getQuote({
        fromAsset: resolvedFrom,
        toAsset: resolvedTo,
        amount: cleanAmount,
        slippageBps,
        sourceAddress: activeAccount?.address,
      });
      if (seq === quoteSeqRef.current) {
        setQuote(res);
      }
    } catch (err) {
      if (seq === quoteSeqRef.current) {
        setQuote(null);
        setError(err instanceof Error ? err.message : "No swap route found for this pair");
      }
    } finally {
      if (seq === quoteSeqRef.current) {
        setQuoting(false);
      }
    }
  }, [
    amount,
    resolvedFrom,
    resolvedTo,
    fromParsed,
    toParsed,
    slippageBps,
    config.apiBaseUrl,
    config.horizonUrls,
    activeAccount?.address,
  ]);

  // Automatic debounced live quote whenever pair, amount, or slippage changes
  useEffect(() => {
    setTxHash(null);
    const timer = window.setTimeout(() => {
      void fetchLiveQuote();
    }, 380);
    return () => {
      window.clearTimeout(timer);
    };
  }, [fetchLiveQuote]);

  const handleFlipAssets = () => {
    if (!resolvedTo.trim()) return;
    const prevFrom = resolvedFrom;
    setFromAsset(resolvedTo);
    setToAsset(prevFrom);
    setQuote(null);
    setTxHash(null);
    triggerTelegramHaptic("selection");
  };

  const applyFromPercentage = (ratio: number) => {
    if (!fromHolding) return;
    const isNative = fromHolding.id === "XLM";
    const avail = isNative
      ? Math.max(0, Number(accountState?.spendableXlm ?? fromHolding.balance) - 0.002)
      : Number(fromHolding.balance);
    const computed = Math.max(0, avail * ratio);
    setAmount((Math.floor(computed * 10_000_000) / 10_000_000).toFixed(7).replace(/\.?0+$/, "") || "0");
    setQuote(null);
  };

  const handleManualQuoteSubmit = (e: FormEvent) => {
    e.preventDefault();
    void fetchLiveQuote();
  };

  const handleExecuteSwap = async () => {
    if (!quote || !activeAccount || hasScamSpoof) return;
    setExecuting(true);
    setSwapPhase(null);
    setError(null);

    try {
      const sendParsed = parseSwapAssetIdentifier(resolvedFrom);
      const destParsed = parseSwapAssetIdentifier(resolvedTo);
      let activeQuote = quote;

      if (missingDestTrustline && destParsed.issuer && isClassic) {
        setSwapPhase(`1/2 Activating ${destParsed.code} trustline...`);
        await addOrRemoveTrustline(destParsed.code, destParsed.issuer as ClassicAddress);
        setSwapPhase("2/2 Settling swap on-chain...");

        if (quote.unsignedXdr) {
          const engine = createCompositeSwapEngine({
            soroswapAdapter: createSoroswapProxyAdapter({
              apiBaseUrl: config.apiBaseUrl,
              network: config.network,
            }),
            horizonAdapter: createHorizonPathSwapAdapter({
              horizonUrls: config.horizonUrls,
            }),
          });
          activeQuote = await engine.getQuote({
            fromAsset: resolvedFrom,
            toAsset: resolvedTo,
            amount: quote.inputAmount,
            slippageBps,
            sourceAddress: activeAccount.address,
          });
        }
      }

      if (activeQuote.unsignedXdr) {
        try {
          const res = await signAndSubmitRawXdrWithShield(activeQuote.unsignedXdr, true);
          setTxHash(res.hash);
          triggerTelegramHaptic("success");
          return;
        } catch {
          // Graceful fallback to Horizon SDEX/AMM path payment if Soroswap XDR simulation expired
          setSwapPhase("Routing via Horizon fallback...");
        }
      }

      const horizon = createHorizonPathSwapAdapter({
        horizonUrls: config.horizonUrls,
      });
      const freshQuote = await horizon.getQuote({
        fromAsset: resolvedFrom,
        toAsset: resolvedTo,
        amount: activeQuote.inputAmount,
        slippageBps,
        sourceAddress: activeAccount.address,
      });

      const minBaselineStroops = calculateMinReceivedStroops7(
        activeQuote.expectedOutputAmount,
        slippageBps,
      );
      if (decimalToStroops7(freshQuote.expectedOutputAmount) < minBaselineStroops) {
        throw new Error(
          "Live swap quote moved past your slippage tolerance; refreshing quote now.",
        );
      }

      const liveDestMin = stroops7ToDecimal(
        calculateMinReceivedStroops7(freshQuote.expectedOutputAmount, slippageBps),
      );
      const res = await executePathSwap({
        sendAssetCode: sendParsed.code,
        sendAssetIssuer: sendParsed.issuer as ClassicAddress | undefined,
        sendAmount: activeQuote.inputAmount,
        destAssetCode: destParsed.code,
        destAssetIssuer: destParsed.issuer as ClassicAddress | undefined,
        destMin: liveDestMin,
        path: freshQuote.pathAssets,
      });
      setTxHash(res.hash);
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Swap execution failed");
    } finally {
      setExecuting(false);
      setSwapPhase(null);
    }
  };

  const handleCopyHash = async () => {
    if (!txHash) return;
    const ok = await copyTextToClipboard(txHash);
    if (ok) {
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 1800);
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  const combinedQuickTokens = useMemo(() => {
    const map = new Map<string, { id: string; code: string; badge: string }>();
    for (const v of verifiedAssets) {
      const id = tokenSwapIdentifier(v.code, v.issuer);
      if (id !== resolvedFrom) {
        map.set(id, { id, code: v.code, badge: "✓" });
      }
    }
    for (const l of liquidAssets) {
      if (!l.assetIssuer) continue;
      const id = tokenSwapIdentifier(l.assetCode, l.assetIssuer);
      if (id === resolvedFrom || map.has(id)) continue;
      map.set(id, {
        id,
        code: l.assetCode,
        badge: l.hasLiquidityPool ? "💧" : "•",
      });
    }
    return Array.from(map.values()).slice(0, 8);
  }, [verifiedAssets, liquidAssets, resolvedFrom]);

  return (
    <section
      className="glass-card"
      aria-label="Soroswap and Path Swap"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <AstroNavigatorAvatar
          seedKey="swap-aggregator"
          kind="smart"
          state={txHash ? "zenith" : executing || quoting ? "warp" : "float"}
          size={48}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Auto-Routed Swap &amp; Shield
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Soroswap AMM + Horizon Path/SDEX · Anti-scam &amp; 1-tap trustline
          </div>
        </div>
      </div>

      <form
        onSubmit={handleManualQuoteSubmit}
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}
      >
        {/* From Asset + Amount */}
        <div className="aw-two-col-inputs">
          <div>
            <label className="aw-label" htmlFor="swap-from-input">
              From Asset
            </label>
            <input
              id="swap-from-input"
              type="text"
              className="aw-input"
              placeholder="XLM or CODE:G..."
              value={fromAsset}
              onChange={(e) => {
                setFromAsset(e.target.value);
                setQuote(null);
              }}
            />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <label className="aw-label" htmlFor="swap-amount-input">
                Amount
              </label>
              {fromHolding && (
                <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
                  Avail: {Number(fromHolding.balance).toFixed(2)}
                </span>
              )}
            </div>
            <input
              id="swap-amount-input"
              type="text"
              inputMode="decimal"
              className="aw-input tabular-nums"
              placeholder="10"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setQuote(null);
              }}
            />
          </div>
        </div>

        {/* Visual From Token Card */}
        <TokenSwapPreviewCard
          roleLabel="Source"
          parsed={fromParsed}
          verifiedEntry={fromVerified}
          tomlMeta={
            fromParsed?.issuer
              ? tokenMetaMap[`${fromParsed.code.toUpperCase()}:${fromParsed.issuer}`]
              : undefined
          }
          trust={fromTrust}
          details={fromDetails}
          balance={fromHolding?.balance}
          onInspect={
            onInspectToken && fromParsed
              ? () =>
                  onInspectToken({
                    assetCode: fromParsed.code,
                    assetIssuer: fromParsed.issuer,
                  })
              : undefined
          }
        />

        {/* Held Quick Chips & Flip */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {heldIdentifiers.map((h) => (
              <button
                key={h.id}
                type="button"
                className="aw-chip-btn"
                aria-pressed={resolvedFrom === h.id}
                onClick={() => {
                  setFromAsset(h.id);
                  setQuote(null);
                }}
              >
                {h.label}
              </button>
            ))}
            {fromHolding && (
              <>
                <button type="button" className="aw-chip-btn" onClick={() => applyFromPercentage(0.25)}>
                  25%
                </button>
                <button type="button" className="aw-chip-btn" onClick={() => applyFromPercentage(0.5)}>
                  50%
                </button>
                <button type="button" className="aw-chip-btn" onClick={() => applyFromPercentage(1)}>
                  MAX
                </button>
              </>
            )}
          </div>

          <button
            type="button"
            className="aw-chip-btn"
            disabled={!resolvedTo.trim()}
            onClick={handleFlipAssets}
            title="Flip assets"
          >
            <IconFlip size={14} />
            <span>Flip</span>
          </button>
        </div>

        {/* To Asset */}
        <div>
          <label className="aw-label" htmlFor="swap-to-input">
            To Asset (Ticker, XLM, or CODE:G...ISSUER)
          </label>
          <input
            id="swap-to-input"
            type="text"
            className="aw-input"
            placeholder="USDC or CODE:G..."
            value={toAsset}
            onChange={(e) => {
              autoPickedToRef.current = true;
              setToAsset(e.target.value);
              setQuote(null);
            }}
          />
          {heldIdentifiers.length > 1 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {heldIdentifiers
                .filter((h) => h.id !== resolvedFrom)
                .map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => {
                      autoPickedToRef.current = true;
                      setToAsset(h.id);
                      setQuote(null);
                    }}
                  >
                    Held: {h.label}
                  </button>
                ))}
            </div>
          )}
          {combinedQuickTokens.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {combinedQuickTokens.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="aw-mini-chip"
                  aria-pressed={resolvedTo === item.id}
                  onClick={() => {
                    autoPickedToRef.current = true;
                    setToAsset(item.id);
                    setQuote(null);
                  }}
                >
                  <span>
                    {item.badge} {item.code}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Visual To Token Card (Logo, Metadata, Official/Scam Status) */}
        <TokenSwapPreviewCard
          roleLabel="Destination"
          parsed={toParsed}
          verifiedEntry={toVerified}
          tomlMeta={
            toParsed?.issuer
              ? tokenMetaMap[`${toParsed.code.toUpperCase()}:${toParsed.issuer}`]
              : undefined
          }
          trust={toTrust}
          details={toDetails}
          balance={toHolding?.balance}
          onInspect={
            onInspectToken && toParsed
              ? () =>
                  onInspectToken({
                    assetCode: toParsed.code,
                    assetIssuer: toParsed.issuer,
                  })
              : undefined
          }
        />

        {/* Slippage Tolerance + Manual Refresh */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)", fontWeight: 600 }}>
            Max Slippage
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SLIPPAGE_OPTIONS.map((opt) => (
              <button
                key={opt.bps}
                type="button"
                className="aw-chip-btn"
                aria-pressed={slippageBps === opt.bps}
                onClick={() => setSlippageBps(opt.bps)}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="submit"
              className="aw-chip-btn"
              disabled={quoting || executing || !resolvedTo.trim()}
              title="Refresh live quote"
            >
              <IconRefresh size={13} />
            </button>
          </div>
        </div>
      </form>

      {/* Fixed-height Stable Quote & Execution Slot (Prevents Layout Shift) */}
      <div className="aw-quote-slot">
        {txHash ? (
          <div className="aw-banner" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
            <div style={{ fontWeight: 700, color: "var(--aw-trust-emerald)" }}>
              Swap Settled on {config.network.toUpperCase()}
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>
              Tx Hash: <code>{txHash}</code>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="aw-chip-btn" onClick={() => void handleCopyHash()}>
                {copiedHash ? <IconCheck size={13} /> : <IconCopy size={13} />}
                <span>{copiedHash ? "Copied" : "Copy Hash"}</span>
              </button>
              {config.explorerBaseUrl && (
                <a
                  href={`${config.explorerBaseUrl.replace(/\/+$/, "")}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="aw-chip-btn"
                >
                  <span>View on Explorer</span>
                  <IconExternalLink size={13} />
                </a>
              )}
            </div>
          </div>
        ) : quoting ? (
          <div className="aw-banner" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              Routing Live Quote Automatically...
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Checking Soroswap AMM pools, Horizon strict-send paths &amp; SDEX orderbook depth.
            </div>
          </div>
        ) : error ? (
          <div className="aw-banner aw-banner--danger" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
            <div>{error}</div>
            <button type="button" className="aw-chip-btn" onClick={() => void fetchLiveQuote()}>
              <IconRefresh size={13} />
              <span>Retry Quote</span>
            </button>
          </div>
        ) : quote ? (
          <div className="aw-banner" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span style={{ color: "var(--aw-ink-secondary)" }}>Estimated Output</span>
              <strong className="tabular-nums" style={{ color: "var(--aw-stellar-gold)" }}>
                {quote.expectedOutputAmount} {toParsed?.code ?? ""}
              </strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
              <span style={{ color: "var(--aw-ink-secondary)" }}>Minimum Received</span>
              <span className="tabular-nums">
                {minReceived} {toParsed?.code ?? ""}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
              <span style={{ color: "var(--aw-ink-secondary)" }}>Route Provider</span>
              <span>
                {quote.provider}{" "}
                {quote.priceImpactPct === "N/A"
                  ? "(market rate)"
                  : `(~${quote.priceImpactPct}% impact)`}
              </span>
            </div>
            {quote.pathAssets && quote.pathAssets.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--aw-nebula-lavender)" }}>
                Hops: {quote.pathAssets.map((h) => h.assetCode).join(" → ")}
              </div>
            )}
            {missingDestTrustline && isClassic && parsedDestForTrust && (
              <div style={{ fontSize: 11, color: "var(--aw-stellar-gold)" }}>
                Auto-Trustline: activates {parsedDestForTrust.code} trustline (0.5 XLM reserve)
                before settling swap.
              </div>
            )}

            <button
              type="button"
              className="aw-btn-primary"
              disabled={executing || hasScamSpoof}
              onClick={() => void handleExecuteSwap()}
            >
              <IconZap size={16} />
              <span>
                {hasScamSpoof
                  ? "Blocked: Scam / Spoofed Issuer"
                  : executing
                    ? (swapPhase ?? "Signing & Settling Swap...")
                    : missingDestTrustline && isClassic && parsedDestForTrust
                      ? `Add ${parsedDestForTrust.code} Trustline & Execute Swap`
                      : "Sign & Execute Swap On-Chain"}
              </span>
            </button>
          </div>
        ) : (
          <div className="aw-banner" style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Choose a destination token above to stream live quotes automatically.
          </div>
        )}
      </div>
    </section>
  );
}
