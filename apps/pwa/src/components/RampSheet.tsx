import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  NEAR_STELLAR_USDC_ASSET_ID,
  NEAR_STELLAR_XLM_ASSET_ID,
  computeLayerZeroOftSharedAmount,
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createCircleCctpRampAdapter,
  createNearIntentsQuoteAdapter,
  encodeLayerZeroRecipientBytes32,
  type NearIntentsQuoteResult,
} from "@astrowallet/defi";
import { ContractAddressSchema } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, openExternalUrl } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

type RampTab = "cash" | "any_chain" | "pro_bridge";

const NEAR_ORIGIN_ASSETS = [
  { id: "nep141:btc.omft.near", label: "Bitcoin (BTC)", decimals: 8 },
  { id: "nep141:eth.omft.near", label: "Ethereum (ETH)", decimals: 18 },
  { id: "nep141:sol.omft.near", label: "Solana (SOL)", decimals: 9 },
  { id: "nep141:ton.omft.near", label: "TON (TON)", decimals: 9 },
  { id: NEAR_STELLAR_USDC_ASSET_ID, label: "Stellar USDC (Origin -> Cross-Chain)", decimals: 7 },
] as const;

function decimalToAtomicString(decimalInput: string, decimals: number): string {
  const clean = decimalInput.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) {
    throw new Error("Enter a valid positive decimal amount");
  }
  const [wholePart = "0", fracPart = ""] = clean.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`Maximum ${decimals} decimal places supported for this asset`);
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFrac}`.replace(/^0+/, "");
  if (!combined) {
    throw new Error("Amount must be greater than 0");
  }
  return combined;
}

async function readJsonSafe<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      res.ok ? "Anchor returned non-JSON response" : `Anchor HTTP ${res.status}`,
    );
  }
}

const NEAR_DEST_ASSETS = [
  { id: NEAR_STELLAR_USDC_ASSET_ID, label: "Stellar USDC" },
  { id: NEAR_STELLAR_XLM_ASSET_ID, label: "Stellar XLM" },
] as const;

/**
 * Unified Cash & Cross-Chain Hub inside Telegram Mini App:
 * 1) MoneyGram Ramps (SEP-24 Cash-Out / Cash-In)
 * 2) NEAR Intents 1-Click Cross-Chain Deposit (with strict MEMO guard)
 * 3) Pro Bridge Validator (Circle CCTP 6<->7 + LayerZero V2 OFT)
 */
export function RampSheet() {
  const { config, activeAccount, accountState, signSep10ChallengeXdr } = useWallet();

  const [activeTab, setActiveTab] = useState<RampTab>("cash");

  // MoneyGram SEP-24 state
  const [cashDirection, setCashDirection] = useState<"offramp" | "onramp">("offramp");
  const [cashAmount, setCashAmount] = useState("50.00");
  const [anchorDomain, setAnchorDomain] = useState(
    () =>
      config.moneygramAnchorDomain ??
      (config.network === "mainnet" ? "stellar.moneygram.com" : "extstellar.moneygram.com"),
  );
  const [cashBusy, setCashBusy] = useState(false);
  const [cashSessionUrl, setCashSessionUrl] = useState<string | null>(null);
  const [cashError, setCashError] = useState<string | null>(null);

  // NEAR Intents 1-Click state
  const [originAsset, setOriginAsset] = useState<string>(NEAR_ORIGIN_ASSETS[0].id);
  const [destAsset, setDestAsset] = useState<string>(NEAR_DEST_ASSETS[0].id);
  const [nearAmountDecimal, setNearAmountDecimal] = useState("0.01");
  const [nearBusy, setNearBusy] = useState(false);
  const [nearQuote, setNearQuote] = useState<NearIntentsQuoteResult | null>(null);
  const [nearLockedQuote, setNearLockedQuote] = useState<NearIntentsQuoteResult | null>(null);
  const [nearError, setNearError] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);

  useEffect(() => {
    setAnchorDomain(
      config.moneygramAnchorDomain ??
        (config.network === "mainnet" ? "stellar.moneygram.com" : "extstellar.moneygram.com"),
    );
    setCashSessionUrl(null);
    setCashError(null);
  }, [config.network, config.moneygramAnchorDomain]);

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
    setCashBusy(true);
    setCashError(null);
    setCashSessionUrl(null);
    try {
      if (accountState?.funded) {
        const hasUsdcTrustline = accountState.balances.some(
          (b) => b.assetCode.toUpperCase() === "USDC" && Boolean(b.assetIssuer),
        );
        if (!hasUsdcTrustline) {
          throw new Error(
            "Activate a USDC trustline first before starting MoneyGram SEP-24 Cash-In/Out.",
          );
        }
      }
      const apiBase = config.apiBaseUrl.replace(/\/+$/, "");
      const cleanDomain = anchorDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const chRes = await fetch(
        `${apiBase}/v1/proxy/sep10/challenge?domain=${encodeURIComponent(cleanDomain)}&account=${encodeURIComponent(activeAccount.address)}`,
        { headers: { "X-Astro-Network": config.network } },
      );
      const chJson = await readJsonSafe<{ transaction?: string; error?: string }>(chRes);
      if (!chRes.ok || !chJson.transaction) {
        throw new Error(chJson.error ?? "Failed to fetch MoneyGram SEP-10 challenge");
      }

      const signedXdr = await signSep10ChallengeXdr(chJson.transaction);
      const tokRes = await fetch(`${apiBase}/v1/proxy/sep10/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": config.network,
        },
        body: JSON.stringify({ domain: cleanDomain, transaction: signedXdr }),
      });
      const tokJson = await readJsonSafe<{ token?: string; error?: string }>(tokRes);
      if (!tokRes.ok || !tokJson.token) {
        throw new Error(tokJson.error ?? "MoneyGram SEP-10 authentication failed");
      }

      const sep24Res = await fetch(`${apiBase}/v1/proxy/sep24/interactive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": config.network,
        },
        body: JSON.stringify({
          domain: cleanDomain,
          direction: cashDirection === "offramp" ? "withdraw" : "deposit",
          token: tokJson.token,
          assetCode: "USDC",
          amount: cashAmount.trim(),
          account: activeAccount.address,
        }),
      });
      const sep24Json = await readJsonSafe<{ url?: string; error?: string }>(sep24Res);
      if (!sep24Res.ok || !sep24Json.url || !sep24Json.url.startsWith("https://")) {
        throw new Error(sep24Json.error ?? "MoneyGram SEP-24 interactive session failed");
      }
      setCashSessionUrl(sep24Json.url);
    } catch (err) {
      setCashError(err instanceof Error ? err.message : "Failed to prepare MoneyGram SEP-24 session");
    } finally {
      setCashBusy(false);
    }
  };

  const requestNearQuote = async (dry: boolean) => {
    setNearBusy(true);
    setNearError(null);
    if (dry) {
      setNearQuote(null);
      setNearLockedQuote(null);
    } else {
      setNearLockedQuote(null);
    }
    try {
      const originMeta = NEAR_ORIGIN_ASSETS.find((a) => a.id === originAsset);
      const amountAtomic = decimalToAtomicString(nearAmountDecimal, originMeta?.decimals ?? 8);
      const adapter = createNearIntentsQuoteAdapter({
        apiBaseUrl: config.nearIntentsApiBase,
      });
      const q = await adapter.requestQuote({
        originAsset,
        destinationAsset: destAsset,
        amountAtomic,
        recipient: activeAccount.address,
        refundTo: activeAccount.address,
        dry,
      });
      if (dry) {
        setNearQuote(q);
      } else {
        setNearLockedQuote(q);
      }
    } catch (err) {
      setNearError(err instanceof Error ? err.message : "Failed to fetch NEAR Intents quote");
    } finally {
      setNearBusy(false);
    }
  };

  const handleNearDryQuote = async (e: FormEvent) => {
    e.preventDefault();
    await requestNearQuote(true);
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

          <button type="submit" className="aw-btn-primary" disabled={cashBusy}>
            {cashBusy ? "Authenticating SEP-10 & Starting SEP-24..." : "Launch MoneyGram SEP-24 Checkout"}
          </button>

          {cashError && <div className="aw-banner aw-banner--danger">{cashError}</div>}
          {cashSessionUrl && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>Validated SEP-24 Interactive Session:</strong>
              <code style={{ wordBreak: "break-all" }}>{cashSessionUrl}</code>
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => openExternalUrl(cashSessionUrl)}
              >
                Open Anchor Checkout ↗
              </button>
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
              Input Amount (Decimal)
            </label>
            <input
              id="near-amt"
              type="text"
              inputMode="decimal"
              className="aw-input tabular-nums"
              value={nearAmountDecimal}
              onChange={(e) => {
                setNearAmountDecimal(e.target.value);
                setNearQuote(null);
                setNearLockedQuote(null);
              }}
            />
          </div>

          <button type="submit" className="aw-btn-primary" disabled={nearBusy}>
            {nearBusy ? "Quoting Market Makers..." : "Preview 1-Click Cross-Chain Quote"}
          </button>

          {nearError && <div className="aw-banner aw-banner--danger">{nearError}</div>}
          {nearQuote && !nearLockedQuote && (
            <div className="aw-banner" style={{ display: "grid", gap: 8, fontSize: 12 }}>
              <strong>
                Dry Quote Preview ({nearQuote.amountOutFormatted ?? nearQuote.minAmountOut ?? "est."})
              </strong>
              <span style={{ color: "var(--aw-ink-secondary)" }}>
                Refund address: <code>{activeAccount.address.slice(0, 8)}…{activeAccount.address.slice(-6)}</code>
              </span>
              <button
                type="button"
                className="aw-btn-gold"
                disabled={nearBusy}
                onClick={() => void requestNearQuote(false)}
              >
                {nearBusy ? "Locking Deposit Address..." : "Lock Deposit Address (Live)"}
              </button>
            </div>
          )}
          {nearLockedQuote && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>
                Live Deposit Ready ({nearLockedQuote.amountOutFormatted ?? nearLockedQuote.minAmountOut ?? "est."})
              </strong>
              <div style={{ wordBreak: "break-all" }}>
                <strong>Deposit Address:</strong> <code>{nearLockedQuote.depositAddress}</code>
              </div>
              {nearLockedQuote.depositMemo && (
                <div className="aw-banner aw-banner--warn" style={{ margin: 0 }}>
                  <strong>REQUIRED MEMO:</strong> <code>{nearLockedQuote.depositMemo}</code> — Never send without this memo.
                </div>
              )}
              {nearLockedQuote.depositAddress && (
                <button
                  type="button"
                  className="aw-btn-secondary"
                  onClick={async () => {
                    const ok = await copyTextToClipboard(nearLockedQuote.depositAddress!);
                    if (ok) {
                      setCopiedAddr(true);
                      setTimeout(() => setCopiedAddr(false), 1800);
                    }
                  }}
                >
                  {copiedAddr ? "Copied Deposit Address" : "Copy Deposit Address"}
                </button>
              )}
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
