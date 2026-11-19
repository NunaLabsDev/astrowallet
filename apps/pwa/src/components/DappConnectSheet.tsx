import { useState, type FormEvent } from "react";
import { expectedCaip2ChainId, type WalletConnectStellarMethod } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function DappConnectSheet() {
  const { config, activeAccount, handleDappRpcRequest } = useWallet();

  const [method, setMethod] = useState<WalletConnectStellarMethod>("stellar_signMessage");
  const [payloadInput, setPayloadInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultJson, setResultJson] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!activeAccount) return null;

  const sep43Injected =
    typeof window !== "undefined" &&
    Boolean((window as unknown as { stellar?: unknown }).stellar);
  const caip2Chain = expectedCaip2ChainId(config.network);

  const handleExecuteRpc = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setResultJson(null);

    try {
      const cleaned = payloadInput.trim();
      const params =
        method === "stellar_signMessage"
          ? { message: cleaned, networkPassphrase: config.networkPassphrase }
          : method === "stellar_signAuthEntry"
            ? { entryXdr: cleaned, networkPassphrase: config.networkPassphrase }
            : { xdr: cleaned, networkPassphrase: config.networkPassphrase };

      const response = await handleDappRpcRequest({
        method,
        chainId: caip2Chain,
        origin: config.pwaOrigin,
        params,
      });
      setResultJson(JSON.stringify(response, null, 2));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "dApp RPC request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card" aria-label="Ecosystem dApp Interoperability" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey={activeAccount.address}
          kind={activeAccount.kind}
          state={resultJson ? "zenith" : busy ? "warp" : "comms"}
          size={54}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Local dApp JSON-RPC Sandbox (SEP-43 / WalletConnect Payload Tester)
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            CAIP-2 <code>{caip2Chain}</code> • Scan &amp; Shield + explicit user approval enforced
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div className="aw-list-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>SEP-43 / SEP-60 &amp; Wallets Kit v2</div>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
              Exposes <code>window.stellar</code> &amp; <code>@creit-tech/stellar-wallets-kit</code> module
            </div>
          </div>
          <span className={sep43Injected ? "glass-pill glass-pill--gold" : "glass-pill"}>
            {sep43Injected ? "Active" : "Standby"}
          </span>
        </div>

        <div className="aw-list-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Reown AppKit / WalletConnect v2</div>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
              {config.reownProjectId
                ? `Project ID ${config.reownProjectId.slice(0, 8)}… configured — cloud QR relay activates once @reown/walletkit is connected`
                : "Local sandbox mode — cloud WalletConnect v2 QR pairing activates once @reown/walletkit + VITE_REOWN_PROJECT_ID is connected"}
            </div>
          </div>
          <span className="glass-pill">Sandbox</span>
        </div>
      </div>

      <form onSubmit={handleExecuteRpc} style={{ display: "grid", gap: 10 }}>
        <div>
          <label className="aw-label" htmlFor="dapp-rpc-method">
            Stellar dApp JSON-RPC Responder
          </label>
          <select
            id="dapp-rpc-method"
            className="aw-input"
            value={method}
            onChange={(e) => setMethod(e.target.value as WalletConnectStellarMethod)}
          >
            <option value="stellar_signMessage">stellar_signMessage (SEP-53)</option>
            <option value="stellar_signXDR">stellar_signXDR</option>
            <option value="stellar_signAndSubmitXDR">stellar_signAndSubmitXDR</option>
            <option value="stellar_signAuthEntry">stellar_signAuthEntry (Soroban)</option>
          </select>
        </div>

        <textarea
          className="aw-textarea"
          rows={3}
          placeholder={
            method === "stellar_signMessage"
              ? "Enter message string to sign with SEP-53..."
              : method === "stellar_signAuthEntry"
                ? "Paste Base64 HashIdPreimage or SorobanAuthorizationEntry XDR..."
                : "Paste Base64 TransactionEnvelope XDR..."
          }
          value={payloadInput}
          onChange={(e) => setPayloadInput(e.target.value)}
        />

        <button
          type="submit"
          className="aw-btn-primary"
          disabled={busy || payloadInput.trim().length === 0}
        >
          {busy ? "Verifying with Scan & Shield..." : `Execute ${method}`}
        </button>
      </form>

      {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}

      {resultJson && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            borderRadius: 12,
            background: "rgba(11, 20, 51, 0.78)",
            fontSize: 11,
            overflowX: "auto",
            color: "var(--aw-nebula-lavender)",
          }}
        >
          {resultJson}
        </pre>
      )}
    </section>
  );
}
