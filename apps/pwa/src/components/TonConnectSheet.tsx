import { useEffect, useState, type FormEvent } from "react";
import { formatNanoTon } from "@astrowallet/ton-core";
import { useWallet, type TonConnectPairingPreview } from "../state/wallet-context.js";
import {
  getTelegramWebApp,
  openTelegramQrScanner,
  triggerTelegramHaptic,
} from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { requiresHighValueReauth } from "./flow-validators.js";
import { HighValueReauthGate } from "./HighValueReauthGate.js";
import { IconCheck, IconPlug, IconQr, IconShield, IconTrash } from "./Icons.js";

export function TonConnectSheet() {
  const {
    config,
    tonAccount,
    tonConnectSessions,
    pendingTonConnectTx,
    ensureTonAccount,
    previewTonConnectUri,
    approveTonConnectPairing,
    disconnectTonConnectSession,
    resolvePendingTonConnectTx,
  } = useWallet();

  const [uriInput, setUriInput] = useState("");
  const [pairingPreview, setPairingPreview] = useState<TonConnectPairingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [txReauthVerified, setTxReauthVerified] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    setTxReauthVerified(false);
  }, [pendingTonConnectTx?.requestId]);

  useEffect(() => {
    if (!tonAccount) {
      void ensureTonAccount();
    }
  }, [tonAccount, ensureTonAccount]);

  if (!tonAccount) {
    return (
      <section className="glass-card" aria-label="TON Connect" style={{ display: "grid", gap: 10 }}>
        <div className="aw-banner" style={{ fontSize: 13 }}>
          Initializing TON Connect wallet…
        </div>
      </section>
    );
  }

  const totalPendingNano = pendingTonConnectTx
    ? pendingTonConnectTx.messages.reduce((sum, m) => sum + m.amountNano, 0n)
    : 0n;
  const hasContractOrTokenCall = Boolean(
    pendingTonConnectTx?.messages.some(
      (m) =>
        m.classification.hasStateInit ||
        (m.classification.hasPayload && m.classification.kind !== "text_comment"),
    ),
  );
  const pendingReauthGate = pendingTonConnectTx
    ? requiresHighValueReauth({
        amount: formatNanoTon(totalPendingNano),
        assetCode: "TON",
        thresholdTon: 10,
        network: config.network,
        forceHighRiskReason: hasContractOrTokenCall
          ? "TON Connect request includes Jetton/NFT transfer, contract call payload, or contract deployment (stateInit)."
          : undefined,
      })
    : { required: false };

  const handleResolvePendingTx = async (approved: boolean) => {
    if (txBusy) return;
    if (approved && pendingReauthGate.required && !txReauthVerified) {
      setErrorMsg("Complete PIN or biometric confirmation before signing.");
      return;
    }
    setTxBusy(true);
    setErrorMsg(null);
    try {
      await resolvePendingTonConnectTx(approved);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "TON Connect signing failed");
    } finally {
      setTxBusy(false);
    }
  };

  const handlePreviewPair = async (e: FormEvent) => {
    e.preventDefault();
    if (!uriInput.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const preview = await previewTonConnectUri(uriInput.trim());
      setPairingPreview(preview);
      triggerTelegramHaptic("selection");
    } catch (err) {
      setPairingPreview(null);
      setErrorMsg(err instanceof Error ? err.message : "TON Connect URI validation failed");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPairing = async () => {
    if (!pairingPreview || busy) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const session = await approveTonConnectPairing(pairingPreview);
      setPairingPreview(null);
      setUriInput("");
      setStatusMsg(`Connected to ${session.dappName} via TON Connect v2.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "TON Connect pairing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="TON Connect v2 Wallet Bridge"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, minWidth: 0 }}>
        <AstroNavigatorAvatar
          seedKey={`${tonAccount.rawAddress}:tc`}
          kind="smart"
          state={pendingTonConnectTx ? "shield" : busy ? "warp" : "comms"}
          size={54}
        />
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            TON Connect v2 (Telegram §7.3 Compliant)
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Connect Telegram Mini Apps &amp; TON dApps cleanly via encrypted NaCl bridge (
            {tonAccount.version.toUpperCase()})
          </div>
        </div>
      </div>

      {!config.tonBridgeUrl && (
        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
          Set <code>VITE_TON_BRIDGE_URL</code> to enable TON Connect v2 encrypted bridge sessions.
        </div>
      )}

      {pendingTonConnectTx && (
        <div className="aw-banner aw-banner--warn" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Incoming TON Connect Signature Request · {pendingTonConnectTx.dappName}
          </div>
          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", overflowWrap: "anywhere" }}>
            Bound Session Address: <code>{pendingTonConnectTx.connectedAddress}</code>
          </div>
          {pendingTonConnectTx.messages.map((m, idx) => (
            <div
              key={`${m.address}-${idx}`}
              style={{
                fontSize: 11,
                overflowWrap: "anywhere",
                display: "grid",
                gap: 4,
                padding: "6px 8px",
                borderRadius: 10,
                background: "rgba(15, 23, 42, 0.25)",
              }}
            >
              <div>
                To: <code style={{ wordBreak: "break-all" }}>{m.address}</code> · Amount:{" "}
                <strong>{formatNanoTon(m.amountNano)} TON</strong>
              </div>
              {m.classification.kind !== "none" && (
                <div>
                  Payload: <strong>{m.classification.kind.replace(/_/g, " ").toUpperCase()}</strong>
                  {m.classification.opcodeHex ? ` (${m.classification.opcodeHex})` : ""}
                  {m.classification.comment ? ` — "${m.classification.comment}"` : ""}
                </div>
              )}
              {m.classification.warnings.map((w) => (
                <div key={w} style={{ color: "var(--aw-amber-glow, #fbbf24)", fontWeight: 600 }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          ))}
          {pendingReauthGate.required && pendingReauthGate.reason && (
            <HighValueReauthGate
              reason={pendingReauthGate.reason}
              verified={txReauthVerified}
              onVerified={() => setTxReauthVerified(true)}
            />
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              style={{ flex: 1 }}
              disabled={txBusy}
              onClick={() => void handleResolvePendingTx(false)}
            >
              Reject
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              style={{ flex: 1 }}
              disabled={txBusy || (pendingReauthGate.required && !txReauthVerified)}
              onClick={() => void handleResolvePendingTx(true)}
            >
              <IconCheck size={14} />
              <span>{txBusy ? "Signing BOC..." : "Approve & Sign BOC"}</span>
            </button>
          </div>
        </div>
      )}

      {pairingPreview ? (
        <div className="aw-review-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Verify TON dApp Pairing</span>
            <span
              className={
                pairingPreview.originVerified
                  ? "glass-pill glass-pill--trust"
                  : "glass-pill"
              }
            >
              {pairingPreview.originVerified ? "Origin Verified" : "Unverified Origin"}
            </span>
          </div>
          <div className="aw-review-rows">
            <div className="aw-review-row">
              <span>App</span>
              <strong>{pairingPreview.dappName}</strong>
            </div>
            <div className="aw-review-row">
              <span>Origin</span>
              <code style={{ wordBreak: "break-all" }}>{pairingPreview.dappUrl}</code>
            </div>
            <div className="aw-review-row">
              <span>Manifest</span>
              <code style={{ wordBreak: "break-all", fontSize: 11 }}>{pairingPreview.manifestUrl}</code>
            </div>
            <div className="aw-review-row">
              <span>Wallet</span>
              <code>
                {tonAccount.version.toUpperCase()} · {tonAccount.friendlyAddress.slice(0, 6)}…
                {tonAccount.friendlyAddress.slice(-6)}
              </code>
            </div>
            <div className="aw-review-row">
              <span>Auth Proof</span>
              <code>
                {pairingPreview.hasTonProof
                  ? `ton_proof (${pairingPreview.domainForProof})`
                  : "Address only"}
              </code>
            </div>
          </div>
          {!pairingPreview.originVerified && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              Manifest could not be origin-verified via HTTPS proxy.
              {pairingPreview.hasTonProof
                ? " Signing ton_proof is blocked until manifest origin verifies."
                : " Verify you recognize the manifest URL before connecting."}
            </div>
          )}
          {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => {
                setPairingPreview(null);
                setErrorMsg(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              style={{ flex: 2 }}
              disabled={busy || (pairingPreview.hasTonProof && !pairingPreview.originVerified)}
              onClick={() => void handleConfirmPairing()}
            >
              <IconShield size={14} />
              <span>{busy ? "Connecting..." : "Confirm & Connect"}</span>
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handlePreviewPair} style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <label className="aw-label" htmlFor="ton-connect-uri-input" style={{ marginBottom: 0 }}>
                Paste TON Connect v2 URI (<code>tc://...</code>)
              </label>
              {getTelegramWebApp()?.showScanQrPopup && (
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => {
                    void openTelegramQrScanner("Scan a TON Connect v2 tc:// QR code").then((scanned) => {
                      if (scanned) {
                        setUriInput(scanned);
                        triggerTelegramHaptic("selection");
                      }
                    });
                  }}
                >
                  <IconQr size={13} />
                  <span>Scan QR</span>
                </button>
              )}
            </div>
            <input
              id="ton-connect-uri-input"
              type="text"
              className="aw-input"
              placeholder="tc://?v=2&id=..."
              value={uriInput}
              onChange={(e) => setUriInput(e.target.value)}
            />
          </div>
          {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
          {statusMsg && <div className="aw-banner">{statusMsg}</div>}
          <button
            type="submit"
            className="aw-btn-primary"
            disabled={busy || !uriInput.trim() || !config.tonBridgeUrl}
          >
            <IconPlug size={15} />
            <span>{busy ? "Inspecting Manifest..." : "Inspect & Review dApp"}</span>
          </button>
        </form>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          Active TON Connect Sessions ({tonConnectSessions.length})
        </div>
        {tonConnectSessions.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            No connected external TON apps yet.
          </div>
        ) : (
          tonConnectSessions.map((sess) => (
            <div key={sess.walletClientId} className="aw-list-row">
              <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{sess.dappName}</div>
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", overflowWrap: "anywhere" }}>
                  {sess.dappUrl} • {sess.network.toUpperCase()}
                </div>
              </div>
              <button
                type="button"
                className="aw-mini-chip"
                aria-label={`Disconnect ${sess.dappName}`}
                onClick={() => void disconnectTonConnectSession(sess.walletClientId)}
              >
                <IconTrash size={12} />
                <span>Disconnect</span>
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
