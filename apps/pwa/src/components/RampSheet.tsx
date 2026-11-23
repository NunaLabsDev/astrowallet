import { useMemo, useState, type FormEvent } from "react";
import {
  computeLayerZeroOftSharedAmount,
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createCircleCctpRampAdapter,
  createNearIntentsQuoteAdapter,
  createSep24AnchorRampAdapter,
  encodeLayerZeroRecipientBytes32,
  type NearIntentsQuoteResult,
} from "@astrowallet/defi";
import { ContractAddressSchema } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

type RampTab = "cash" | "any_chain" | "pro_bridge";

const NEAR_ORIGIN_ASSETS = [
  { id: "nep141:btc.omft.near", label: "Bitcoin (BTC)" },
  { id: "nep141:eth.omft.near", label: "Ethereum (ETH)" },
  { id: "nep141:sol.omft.near", label: "Solana (SOL)" },
  { id: "nep141:ton.omft.near", label: "TON (TON)" },
  { id: "stellar:usdc", label: "Stellar USDC (Origin -> Cross-Chain)" },
] as const;

const NEAR_DEST_ASSETS = [
  { id: "stellar:usdc", label: "Stellar USDC" },
  { id: "stellar:xlm", label: "Stellar XLM" },
] as const;

/**
 * Unified Cash & Cross-Chain Hub inside Telegram Mini App:
 * 1) MoneyGram Ramps (SEP-24 Cash-Out / Cash-In)
 * 2) NEAR Intents 1-Click Cross-Chain Deposit (with strict MEMO guard)
 * 3) Pro Bridge Validator (Circle CCTP 6<->7 + LayerZero V2 OFT)
 */
export function RampSheet() {
  const { config, activeAccount, accountState } = useWallet();

  const [activeTab, setActiveTab] = useState<RampTab>("cash");

  // MoneyGram SEP-24 state
  const [cashDirection, setCashDirection] = useState<"offramp" | "onramp">("offramp");
  const [cashAmount, setCashAmount] = useState("50.00");
  const [anchorDomain, setAnchorDomain] = useState(
    () => config.moneygramAnchorDomain ?? "extstellar.moneygram.com",
  );
  const [cashSessionUrl, setCashSessionUrl] = useState<string | null>(null);
  const [cashError, setCashError] = useState<string | null>(null);

  // NEAR Intents 1-Click state
  const [originAsset, setOriginAsset] = useState<string>(NEAR_ORIGIN_ASSETS[0].id);
  const [destAsset, setDestAsset] = useState<string>(NEAR_DEST_ASSETS[0].id);
  const [nearAmountAtomic, setNearAmountAtomic] = useState("1000000");
  const [nearBusy, setNearBusy] = useState(false);
  const [nearQuote, setNearQuote] = useState<NearIntentsQuoteResult | null>(null);
  const [nearError, setNearError] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);

  // Pro Bridge (CCTP + OFT) state
  const [direction, setDirection] = useState<"onramp" | "offramp">("onramp");
  const [amount, setAmount] = useState("25.00");
  const [cctpBridgeUrl, setCctpBridgeUrl] = useState(() => config.cctpBridgeUrl ?? "");
  const [forwarderId, setForwarderId] = useState(
    () => config.cctpForwarderContractId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasUsdcTrustline = useMemo(() => {
    if (!accountState?.funded) return false;
    return accountState.balances.some((b) => b.assetCode.toUpperCase() === "USDC");
  }, [accountState]);

  const decimalPreview = useMemo(() => {
    try {
      const evm = convertStellarUsdcToEvmAtomic6(amount);
      const back = convertEvmUsdc6ToStellarStroops7(evm.atomic6);
      return {
        ok: true as const,
        atomic6: evm.atomic6.toString(),
        stroops7: evm.stroops7.toString(),
        formatted: back.formattedStellarUsdc,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid decimal precision",
      };
    }
  }, [amount]);

  const oftPreview = useMemo(() => {
    if (!activeAccount) return null;
    try {
      const oft = computeLayerZeroOftSharedAmount(amount);
      const recipientBytes32 = encodeLayerZeroRecipientBytes32(activeAccount.address);
      return {
        ok: true as const,
        ...oft,
        recipientBytes32,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid OFT parameters",
      };
    }
  }, [amount, activeAccount]);

  if (!activeAccount) return null;

  const handleBuildMoneyGramSession = async (e: FormEvent) => {
    e.preventDefault();
    setCashError(null);
    setCashSessionUrl(null);
    try {
      const adapter = createSep24AnchorRampAdapter({
        anchorDomain,
        assetCode: "USDC",
      });
      const res = await adapter.createSessionUrl({
        direction: cashDirection,
        fiatCurrency: "USD",
        assetCode: "USDC",
        amount: cashAmount,
        destinationAddress: activeAccount.address,
      });
      setCashSessionUrl(res.url);
    } catch (err) {
      setCashError(err instanceof Error ? err.message : "Failed to prepare MoneyGram SEP-24 session");
    }
  };

  const handleNearDryQuote = async (e: FormEvent) => {
    e.preventDefault();
    setNearBusy(true);
    setNearError(null);
    setNearQuote(null);
    try {
      const adapter = createNearIntentsQuoteAdapter({
        apiBaseUrl: config.nearIntentsApiBase,
      });
      const q = await adapter.requestQuote({
        originAsset,
        destinationAsset: destAsset,
        amountAtomic: nearAmountAtomic.trim(),
        recipient: activeAccount.address,
        refundTo: activeAccount.address,
        dry: true,
      });
      setNearQuote(q);
    } catch (err) {
      setNearError(err instanceof Error ? err.message : "Failed to fetch NEAR Intents quote");
    } finally {
      setNearBusy(false);
    }
  };

  const handleBuildPreview = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setPreviewPayload(null);

    try {
      const parsedContract = ContractAddressSchema.safeParse(forwarderId.trim());
      if (!parsedContract.success) {
        throw new Error("Enter a valid CctpForwarder C... contract address");
      }
      const adapter = createCircleCctpRampAdapter({
        bridgeBaseUrl: cctpBridgeUrl.trim(),
        forwarderContractId: parsedContract.data,
      });
      const res = await adapter.createSessionUrl({
        direction,
        fiatCurrency: "USD",
        assetCode: "USDC",
        amount: amount.trim(),
        destinationAddress: activeAccount.address,
      });
      const parsed = new URL(res.url);
      if (config.network === "mainnet" && parsed.protocol !== "https:") {
        throw new Error("Mainnet CCTP endpoint requires strict HTTPS URL");
      }
      setPreviewPayload(parsed.toString());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to prepare CCTP parameters");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Cash and Cross-Chain Hub"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey={`${activeAccount.address}:ramp`}
          kind={activeAccount.kind}
          state={cashSessionUrl || nearQuote || previewPayload ? "zenith" : busy || nearBusy ? "warp" : "float"}
          size={52}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            Cash &amp; Cross-Chain Hub
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            MoneyGram SEP-24 Cash-Out · 1-Click Deposits · CCTP &amp; OFT · {config.network.toUpperCase()}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="tablist" aria-label="Ramp mode">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "cash"}
          className={activeTab === "cash" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("cash")}
        >
          Cash (MoneyGram)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "any_chain"}
          className={activeTab === "any_chain" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("any_chain")}
        >
          Any Chain (1-Click)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "pro_bridge"}
          className={activeTab === "pro_bridge" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("pro_bridge")}
        >
          Pro Bridge (CCTP / OFT)
        </button>
      </div>

      {activeTab === "cash" && (
        <form onSubmit={handleBuildMoneyGramSession} style={{ display: "grid", gap: 10 }}>
          <div className="aw-banner" style={{ fontSize: 12, display: "grid", gap: 4 }}>
            <strong>MoneyGram Ramps (SEP-24 · 500,000+ Locations)</strong>
            <span>
              Cash out USDC to physical cash or deposit cash into Stellar USDC with zero bank account required.
            </span>
            <span style={{ color: hasUsdcTrustline ? "#6EE7B7" : "#FDBA74" }}>
              {hasUsdcTrustline
                ? "✓ USDC trustline active on this account"
                : "⚠ Activate a USDC trustline first (or receive via Auto-Escrow)"}
            </span>
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="mg-direction">
                Action
              </label>
              <select
                id="mg-direction"
                className="aw-input"
                value={cashDirection}
                onChange={(e) => setCashDirection(e.target.value as "offramp" | "onramp")}
              >
                <option value="offramp">Cash-Out (USDC → Cash)</option>
                <option value="onramp">Cash-In (Cash → USDC)</option>
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="mg-amount">
                Amount (USDC)
              </label>
              <input
                id="mg-amount"
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                value={cashAmount}
                onChange={(e) => setCashAmount(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="aw-label" htmlFor="mg-domain">
              SEP-24 Anchor Domain
            </label>
            <input
              id="mg-domain"
              type="text"
              className="aw-input"
              value={anchorDomain}
              onChange={(e) => setAnchorDomain(e.target.value)}
            />
          </div>

          <button type="submit" className="aw-btn-primary">
            Prepare MoneyGram SEP-24 Session
          </button>

          {cashError && <div className="aw-banner aw-banner--danger">{cashError}</div>}
          {cashSessionUrl && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>Validated SEP-24 Interactive Session:</strong>
              <code style={{ wordBreak: "break-all" }}>{cashSessionUrl}</code>
              <a
                href={cashSessionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="aw-btn-secondary"
                style={{ textAlign: "center", textDecoration: "none" }}
              >
                Open Anchor Checkout
              </a>
            </div>
          )}
        </form>
      )}

      {activeTab === "any_chain" && (
        <form onSubmit={handleNearDryQuote} style={{ display: "grid", gap: 10 }}>
          <div className="aw-banner" style={{ fontSize: 12 }}>
            <strong>1-Click Cross-Chain Deposit (NEAR Intents):</strong> Swap BTC, ETH, SOL, or TON directly into Stellar USDC or XLM without managing bridge contracts.
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="near-origin">
                From Asset
              </label>
              <select
                id="near-origin"
                className="aw-input"
                value={originAsset}
                onChange={(e) => setOriginAsset(e.target.value)}
              >
                {NEAR_ORIGIN_ASSETS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="near-dest">
                To Stellar Asset
              </label>
              <select
                id="near-dest"
                className="aw-input"
                value={destAsset}
                onChange={(e) => setDestAsset(e.target.value)}
              >
                {NEAR_DEST_ASSETS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="aw-label" htmlFor="near-amt">
              Input Amount (Atomic Units)
            </label>
            <input
              id="near-amt"
              type="text"
              inputMode="numeric"
              className="aw-input tabular-nums"
              value={nearAmountAtomic}
              onChange={(e) => setNearAmountAtomic(e.target.value)}
            />
          </div>

          <button type="submit" className="aw-btn-primary" disabled={nearBusy}>
            {nearBusy ? "Quoting Market Makers..." : "Preview 1-Click Cross-Chain Quote"}
          </button>

          {nearError && <div className="aw-banner aw-banner--danger">{nearError}</div>}
          {nearQuote && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>Dry Quote Ready ({nearQuote.amountOutFormatted ?? nearQuote.minAmountOut ?? "est."})</strong>
              <div style={{ wordBreak: "break-all" }}>
                <strong>Deposit Address:</strong> <code>{nearQuote.depositAddress}</code>
              </div>
              {nearQuote.depositMemo && (
                <div className="aw-banner aw-banner--warn" style={{ margin: 0 }}>
                  <strong>REQUIRED MEMO:</strong> <code>{nearQuote.depositMemo}</code> — Never send without this memo.
                </div>
              )}
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={async () => {
                  const ok = await copyTextToClipboard(nearQuote.depositAddress);
                  if (ok) {
                    setCopiedAddr(true);
                    setTimeout(() => setCopiedAddr(false), 1800);
                  }
                }}
              >
                {copiedAddr ? "Copied Deposit Address" : "Copy Deposit Address"}
              </button>
            </div>
          )}
        </form>
      )}

      {activeTab === "pro_bridge" && (
        <form onSubmit={handleBuildPreview} style={{ display: "grid", gap: 10 }}>
          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="ramp-direction">
                Direction
              </label>
              <select
                id="ramp-direction"
                className="aw-input"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "onramp" | "offramp")}
              >
                <option value="onramp">Mint onto Stellar</option>
                <option value="offramp">Burn from Stellar</option>
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="ramp-amount">
                Amount (USDC / USDT0 / USDe)
              </label>
              <input
                id="ramp-amount"
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <input
            type="url"
            className="aw-input"
            placeholder="CCTP Bridge Base URL (VITE_CCTP_BRIDGE_URL)"
            value={cctpBridgeUrl}
            onChange={(e) => setCctpBridgeUrl(e.target.value)}
          />
          <input
            type="text"
            className="aw-input"
            placeholder="CctpForwarder Contract C... (VITE_CCTP_FORWARDER_CONTRACT_ID)"
            value={forwarderId}
            onChange={(e) => setForwarderId(e.target.value)}
          />

          {decimalPreview && (
            <div
              className={decimalPreview.ok ? "aw-banner" : "aw-banner aw-banner--danger"}
              style={{ fontSize: 12 }}
            >
              {decimalPreview.ok ? (
                <>
                  <strong>CCTP 6&harr;7 Decimal Guard OK:</strong> {decimalPreview.atomic6} EVM units
                  (6d) = {decimalPreview.stroops7} stroops ({decimalPreview.formatted} USDC)
                </>
              ) : (
                decimalPreview.error
              )}
            </div>
          )}

          {oftPreview && (
            <div
              className={oftPreview.ok ? "aw-banner" : "aw-banner aw-banner--danger"}
              style={{ fontSize: 12, display: "grid", gap: 4 }}
            >
              {oftPreview.ok ? (
                <>
                  <strong>LayerZero V2 OFT (USDT0 / Ethena USDe):</strong>{" "}
                  <span className="tabular-nums">
                    {oftPreview.sharedUnits6.toString()} shared units (6d) · Sendable: {oftPreview.sendableFormatted}
                    {oftPreview.dustStroops > 0n ? ` (7th-digit dust: ${oftPreview.dustStroops.toString()} stroops)` : ""}
                  </span>
                  <code style={{ wordBreak: "break-all", fontSize: 11 }}>
                    bytes32 recipient: {oftPreview.recipientBytes32}
                  </code>
                </>
              ) : (
                oftPreview.error
              )}
            </div>
          )}

          <button type="submit" className="aw-btn-primary" disabled={busy}>
            {busy ? "Validating Parameters..." : "Validate CCTP Transfer Intent"}
          </button>

          {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
          {previewPayload && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>Validated Parameter Uri (Copy inside Mini App):</strong>
              <code style={{ wordBreak: "break-all" }}>{previewPayload}</code>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
