import { useMemo, useState, type FormEvent } from "react";
import {
  createCompositeSwapEngine,
  createHorizonPathSwapAdapter,
  createSoroswapProxyAdapter,
  parseSwapAssetIdentifier,
} from "@astrowallet/defi";
import type { ClassicAddress, SwapQuote } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconFlip,
  IconZap,
} from "./Icons.js";

const SLIPPAGE_OPTIONS: ReadonlyArray<{ bps: number; label: string }> = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1.0%" },
  { bps: 200, label: "2.0%" },
  { bps: 500, label: "5.0%" },
];

function assetIdentifier(assetCode: string, assetIssuer?: string): string {
  return assetCode.toUpperCase() === "XLM" && !assetIssuer
    ? "XLM"
    : `${assetCode}:${assetIssuer ?? ""}`;
}

function formatTruncated7(num: number): string {
  if (!Number.isFinite(num) || num <= 0) return "0.0000001";
  return (Math.floor(num * 10_000_000) / 10_000_000).toFixed(7);
}

export function SwapSheet({
  initialFromAsset,
}: {
  initialFromAsset?: string | undefined;
}) {
  const {
    config,
    activeAccount,
    accountState,
    executePathSwap,
    signAndSubmitRawXdrWithShield,
  } = useWallet();

  const heldIdentifiers = useMemo(() => {
    const balances = accountState?.balances ?? [];
    if (balances.length === 0) {
      return [{ id: "XLM", label: "XLM", balance: "0" }];
    }
    return balances.map((b) => ({
      id: assetIdentifier(b.assetCode, b.assetIssuer),
      label: b.assetCode,
      balance: b.balance,
    }));
  }, [accountState?.balances]);

  const [fromAsset, setFromAsset] = useState(() => initialFromAsset || "XLM");
  const [toAsset, setToAsset] = useState("");
  const [amount, setAmount] = useState("10");
  const [slippageBps, setSlippageBps] = useState<number>(100);

  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  const fromHolding = heldIdentifiers.find((h) => h.id === fromAsset);

  const minReceived = useMemo(() => {
    if (!quote) return "0";
    const expected = Number(quote.expectedOutputAmount);
    const min = expected * (1 - slippageBps / 10_000);
    return formatTruncated7(min);
  }, [quote, slippageBps]);

  const handleFlipAssets = () => {
    if (!toAsset.trim()) return;
    const prevFrom = fromAsset;
    setFromAsset(toAsset.trim());
    setToAsset(prevFrom);
    setQuote(null);
    setTxHash(null);
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

  const handleGetQuote = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount.trim() || !toAsset.trim()) return;

    setQuoting(true);
    setError(null);
    setQuote(null);
    setTxHash(null);

    try {
      const engine = createCompositeSwapEngine({
        soroswapAdapter: createSoroswapProxyAdapter({
          apiBaseUrl: config.apiBaseUrl,
        }),
        horizonAdapter: createHorizonPathSwapAdapter({
          horizonUrls: config.horizonUrls,
        }),
      });

      const res = await engine.getQuote({
        fromAsset: fromAsset.trim(),
        toAsset: toAsset.trim(),
        amount: amount.trim(),
        slippageBps,
      });
      setQuote(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch swap quote");
    } finally {
      setQuoting(false);
    }
  };

  const handleExecuteSwap = async () => {
    if (!quote || !activeAccount) return;
    setExecuting(true);
    setError(null);

    try {
      if (quote.unsignedXdr) {
        const res = await signAndSubmitRawXdrWithShield(quote.unsignedXdr, true);
        setTxHash(res.hash);
        return;
      }

      const sendParsed = parseSwapAssetIdentifier(fromAsset);
      const destParsed = parseSwapAssetIdentifier(toAsset);
      const res = await executePathSwap({
        sendAssetCode: sendParsed.code,
        sendAssetIssuer: sendParsed.issuer as ClassicAddress | undefined,
        sendAmount: quote.inputAmount,
        destAssetCode: destParsed.code,
        destAssetIssuer: destParsed.issuer as ClassicAddress | undefined,
        destMin: minReceived,
        path: quote.pathAssets,
      });
      setTxHash(res.hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap execution failed");
    } finally {
      setExecuting(false);
    }
  };

  const handleCopyHash = async () => {
    if (!txHash) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Soroswap and Path Swap"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey="swap-aggregator"
          kind="smart"
          state={txHash ? "zenith" : executing || quoting ? "warp" : "float"}
          size={52}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Soroswap &amp; Path Payment Aggregator
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Soroswap AMM + Zero-Key Horizon Strict-Send Path Swap
          </div>
        </div>
      </div>

      <form onSubmit={handleGetQuote} style={{ display: "grid", gap: 10 }}>
        {/* From Asset + Held Quick Picks */}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label className="aw-label" htmlFor="swap-amount-input">
                Amount
              </label>
              {fromHolding && (
                <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
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

        {/* Held Quick Chips & Flip */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {heldIdentifiers.map((h) => (
              <button
                key={h.id}
                type="button"
                className="aw-chip-btn"
                aria-pressed={fromAsset === h.id}
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
            disabled={!toAsset.trim()}
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
            To Asset (XLM or CODE:G...ISSUER)
          </label>
          <input
            id="swap-to-input"
            type="text"
            className="aw-input"
            placeholder="USDC:G... (requires destination asset trustline)"
            value={toAsset}
            onChange={(e) => {
              setToAsset(e.target.value);
              setQuote(null);
            }}
          />
          {heldIdentifiers.length > 1 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {heldIdentifiers
                .filter((h) => h.id !== fromAsset)
                .map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => {
                      setToAsset(h.id);
                      setQuote(null);
                    }}
                  >
                    Target: {h.label}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Slippage Tolerance */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)", fontWeight: 600 }}>
            Max Slippage
          </span>
          <div style={{ display: "flex", gap: 6 }}>
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
          </div>
        </div>

        <button
          type="submit"
          className="aw-btn-secondary"
          disabled={quoting || executing || !toAsset.trim()}
        >
          {quoting ? "Routing Best Liquidity..." : "Get Live Swap Quote"}
        </button>
      </form>

      {error && <div className="aw-banner aw-banner--danger">{error}</div>}

      {quote && !txHash && (
        <div className="aw-banner" style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--aw-ink-secondary)" }}>Estimated Output</span>
            <strong className="tabular-nums" style={{ color: "var(--aw-stellar-gold)" }}>
              {quote.expectedOutputAmount}
            </strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--aw-ink-secondary)" }}>Minimum Received</span>
            <span className="tabular-nums">{minReceived}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--aw-ink-secondary)" }}>Route Provider</span>
            <span>
              {quote.provider} (~{quote.priceImpactPct}% impact)
            </span>
          </div>
          {quote.pathAssets && quote.pathAssets.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--aw-nebula-lavender)" }}>
              Intermediate Hops: {quote.pathAssets.map((h) => h.assetCode).join(" → ")}
            </div>
          )}

          <button
            type="button"
            className="aw-btn-primary"
            disabled={executing}
            onClick={() => void handleExecuteSwap()}
          >
            <IconZap size={16} />
            <span>
              {executing ? "Signing & Settling Swap..." : "Sign & Execute Swap On-Chain"}
            </span>
          </button>
        </div>
      )}

      {txHash && (
        <div className="aw-banner" style={{ display: "grid", gap: 8 }}>
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
      )}
    </section>
  );
}
