import { useState, type FormEvent } from "react";
import {
  createCompositeSwapEngine,
  createHorizonPathSwapAdapter,
  createSoroswapProxyAdapter,
} from "@astrowallet/defi";
import type { SwapQuote } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function SwapSheet() {
  const { config } = useWallet();

  const [fromAsset, setFromAsset] = useState("XLM");
  const [toAsset, setToAsset] = useState("");
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);

  const handleGetQuote = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount.trim() || !toAsset.trim()) return;

    setBusy(true);
    setError(null);
    setQuote(null);

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
        slippageBps: 50,
      });
      setQuote(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch swap quote");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card" aria-label="Soroswap and Path Swap" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey="swap-aggregator"
          kind="smart"
          state={busy ? "warp" : "float"}
          size={52}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Soroswap &amp; Path Payment Aggregator
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Edge-proxied Soroswap primary • Zero-key Horizon Path fallback
          </div>
        </div>
      </div>

      <form onSubmit={handleGetQuote} style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label className="aw-label" htmlFor="swap-from-input">
              From Asset
            </label>
            <input
              id="swap-from-input"
              type="text"
              className="aw-input"
              placeholder="XLM"
              value={fromAsset}
              onChange={(e) => setFromAsset(e.target.value)}
            />
          </div>
          <div>
            <label className="aw-label" htmlFor="swap-amount-input">
              Amount
            </label>
            <input
              id="swap-amount-input"
              type="text"
              inputMode="decimal"
              className="aw-input tabular-nums"
              placeholder="10"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="aw-label" htmlFor="swap-to-input">
            To Asset (XLM or CODE:G...ISSUER)
          </label>
          <input
            id="swap-to-input"
            type="text"
            className="aw-input"
            placeholder="USDC:G..."
            value={toAsset}
            onChange={(e) => setToAsset(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="aw-btn-primary"
          disabled={busy || !toAsset.trim()}
        >
          {busy ? "Routing Best Swap..." : "Get Best Swap Quote"}
        </button>
      </form>

      {error && <div className="aw-banner aw-banner--danger">{error}</div>}

      {quote && (
        <div className="aw-banner" style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--aw-ink-secondary)" }}>Estimated Output</span>
            <strong className="tabular-nums" style={{ color: "var(--aw-stellar-gold)" }}>
              {quote.expectedOutputAmount}
            </strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--aw-ink-secondary)" }}>Route Provider</span>
            <span>{quote.provider} (~{quote.priceImpactPct}% impact)</span>
          </div>
        </div>
      )}
    </section>
  );
}
