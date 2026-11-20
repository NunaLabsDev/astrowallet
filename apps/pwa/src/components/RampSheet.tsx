import { useMemo, useState, type FormEvent } from "react";
import {
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createCircleCctpRampAdapter,
} from "@astrowallet/defi";
import { ContractAddressSchema } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

/**
 * In-app Circle CCTP 6<->7 USDC decimal precision & forwarder validator inside Telegram Mini App.
 * External non-TON promo links/widgets are disabled to comply with Telegram ToS Section 7.3-7.4.
 */
export function RampSheet() {
  const { config, activeAccount } = useWallet();

  const [direction, setDirection] = useState<"onramp" | "offramp">("onramp");
  const [amount, setAmount] = useState("25.00");
  const [cctpBridgeUrl, setCctpBridgeUrl] = useState(() => config.cctpBridgeUrl ?? "");
  const [forwarderId, setForwarderId] = useState(
    () => config.cctpForwarderContractId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  if (!activeAccount) return null;

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
      aria-label="In-App Circle CCTP Validator"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey={`${activeAccount.address}:ramp`}
          kind={activeAccount.kind}
          state={previewPayload ? "zenith" : busy ? "warp" : "float"}
          size={54}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            USDC CCTP Precision &amp; Forwarder Tool
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            6&harr;7 Decimal Guard &amp; CctpForwarder Validator · {config.network.toUpperCase()}
          </div>
        </div>
      </div>

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
              Amount (USDC)
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
                <strong>6&harr;7 Decimal Guard OK:</strong> {decimalPreview.atomic6} EVM atomic units
                (6d) = {decimalPreview.stroops7} Stellar stroops ({decimalPreview.formatted} USDC)
              </>
            ) : (
              decimalPreview.error
            )}
          </div>
        )}

        <button type="submit" className="aw-btn-primary" disabled={busy}>
          {busy ? "Validating Parameters..." : "Validate CCTP Transfer Intent"}
        </button>
      </form>

      {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}

      {previewPayload && (
        <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
          <strong>Validated Parameter Uri (Copy inside Mini App):</strong>
          <code style={{ wordBreak: "break-all" }}>{previewPayload}</code>
        </div>
      )}
    </section>
  );
}
