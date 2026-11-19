import { useMemo, useState, type FormEvent } from "react";
import {
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createCircleCctpRampAdapter,
  createMoonPayRampAdapter,
  createTransakRampAdapter,
} from "@astrowallet/defi";
import { ContractAddressSchema } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

type RampProvider = "circle-cctp" | "moonpay" | "transak";

export function RampSheet() {
  const { config, activeAccount } = useWallet();

  const [provider, setProvider] = useState<RampProvider>("circle-cctp");
  const [direction, setDirection] = useState<"onramp" | "offramp">("onramp");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">("USDC");
  const [fiatCurrency, setFiatCurrency] = useState("USD");
  const [amount, setAmount] = useState("25.00");

  const [cctpBridgeUrl, setCctpBridgeUrl] = useState(() => config.cctpBridgeUrl ?? "");
  const [forwarderId, setForwarderId] = useState(
    () => config.cctpForwarderContractId ?? "",
  );
  const [moonPayUrl, setMoonPayUrl] = useState(() => config.moonPayWidgetUrl ?? "");
  const [transakUrl, setTransakUrl] = useState(() => config.transakWidgetUrl ?? "");

  const [busy, setBusy] = useState(false);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const decimalPreview = useMemo(() => {
    if (provider !== "circle-cctp") return null;
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
  }, [provider, amount]);

  if (!activeAccount) return null;

  const handleBuildSession = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setSessionUrl(null);

    try {
      if (provider === "circle-cctp") {
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
          fiatCurrency,
          assetCode: "USDC",
          amount: amount.trim(),
          destinationAddress: activeAccount.address,
        });
        setSessionUrl(res.url);
      } else if (provider === "moonpay") {
        const adapter = createMoonPayRampAdapter({
          widgetBaseUrl: moonPayUrl.trim(),
        });
        const res = await adapter.createSessionUrl({
          direction,
          fiatCurrency,
          assetCode,
          amount: amount.trim(),
          destinationAddress: activeAccount.address,
        });
        setSessionUrl(res.url);
      } else {
        const adapter = createTransakRampAdapter({
          widgetBaseUrl: transakUrl.trim(),
        });
        const res = await adapter.createSessionUrl({
          direction,
          fiatCurrency,
          assetCode,
          amount: amount.trim(),
          destinationAddress: activeAccount.address,
        });
        setSessionUrl(res.url);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to initialize ramp session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Self-Serve Fiat and Cross-Chain Ramp"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey={`${activeAccount.address}:ramp`}
          kind={activeAccount.kind}
          state={sessionUrl ? "zenith" : busy ? "warp" : "float"}
          size={54}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Self-Serve Ramps (Circle CCTP / Fiat)
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            0-KYB USDC CCTP (6&harr;7 decimal guard) • MoonPay &amp; Transak • {config.network.toUpperCase()}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(
          [
            ["circle-cctp", "Circle CCTP (0 KYB)"],
            ["moonpay", "MoonPay"],
            ["transak", "Transak"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="aw-chip-btn"
            aria-pressed={provider === id}
            onClick={() => {
              setProvider(id);
              if (id === "circle-cctp") setAssetCode("USDC");
              setSessionUrl(null);
              setErrorMsg(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={handleBuildSession} style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label className="aw-label" htmlFor="ramp-direction">
              Flow
            </label>
            <select
              id="ramp-direction"
              className="aw-input"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "onramp" | "offramp")}
            >
              <option value="onramp">On-Ramp / Bridge In</option>
              <option value="offramp">Off-Ramp / Bridge Out</option>
            </select>
          </div>
          <div>
            <label className="aw-label" htmlFor="ramp-asset">
              Asset
            </label>
            <select
              id="ramp-asset"
              className="aw-input"
              value={provider === "circle-cctp" ? "USDC" : assetCode}
              disabled={provider === "circle-cctp"}
              onChange={(e) => setAssetCode(e.target.value as "USDC" | "XLM")}
            >
              <option value="USDC">USDC</option>
              {provider !== "circle-cctp" && <option value="XLM">XLM</option>}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
          <div>
            <label className="aw-label" htmlFor="ramp-amount">
              Amount ({provider === "circle-cctp" ? "USDC" : fiatCurrency})
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
          <div>
            <label className="aw-label" htmlFor="ramp-fiat">
              Fiat
            </label>
            <input
              id="ramp-fiat"
              type="text"
              className="aw-input"
              disabled={provider === "circle-cctp"}
              value={fiatCurrency}
              onChange={(e) => setFiatCurrency(e.target.value.toUpperCase())}
            />
          </div>
        </div>

        {provider === "circle-cctp" && (
          <>
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
                    <strong>6&harr;7 Decimal Guard OK:</strong> {decimalPreview.atomic6} EVM atomic
                    units (6d) = {decimalPreview.stroops7} Stellar stroops ({decimalPreview.formatted}{" "}
                    USDC)
                  </>
                ) : (
                  decimalPreview.error
                )}
              </div>
            )}
          </>
        )}

        {provider === "moonpay" && (
          <input
            type="url"
            className="aw-input"
            placeholder="MoonPay Widget URL (VITE_MOONPAY_WIDGET_URL)"
            value={moonPayUrl}
            onChange={(e) => setMoonPayUrl(e.target.value)}
          />
        )}

        {provider === "transak" && (
          <input
            type="url"
            className="aw-input"
            placeholder="Transak Widget URL (VITE_TRANSAK_WIDGET_URL)"
            value={transakUrl}
            onChange={(e) => setTransakUrl(e.target.value)}
          />
        )}

        <button type="submit" className="aw-btn-primary" disabled={busy}>
          {busy ? "Preparing Ramp Session..." : "Generate Self-Serve Ramp Session"}
        </button>
      </form>

      {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}

      {sessionUrl && (
        <div className="aw-banner" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, wordBreak: "break-all" }}>
            <strong>Session Ready:</strong> <code>{sessionUrl}</code>
          </div>
          <a
            href={sessionUrl}
            target="_blank"
            rel="noreferrer"
            className="aw-btn-gold"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
            }}
          >
            Launch {provider === "circle-cctp" ? "Circle CCTP" : provider} Session
          </a>
        </div>
      )}
    </section>
  );
}
