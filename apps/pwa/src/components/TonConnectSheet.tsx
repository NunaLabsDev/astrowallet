import { useState, type FormEvent } from "react";
import { formatNanoTon } from "@astrowallet/ton-core";
import { useWallet } from "../state/wallet-context.js";
import {
  getTelegramWebApp,
  openTelegramQrScanner,
  triggerTelegramHaptic,
} from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { IconCheck, IconPlug, IconQr, IconTrash } from "./Icons.js";

export function TonConnectSheet() {
  const {
    config,
    tonAccount,
    tonConnectSessions,
    pendingTonConnectTx,
    pairTonConnectUri,
    disconnectTonConnectSession,
    resolvePendingTonConnectTx,
  } = useWallet();

  const [uriInput, setUriInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  if (!tonAccount) return null;

  const handlePair = async (e: FormEvent) => {
    e.preventDefault();
    if (!uriInput.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const session = await pairTonConnectUri(uriInput.trim());
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
            Connect Telegram Mini Apps &amp; TON dApps cleanly via encrypted NaCl bridge
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
          {pendingTonConnectTx.messages.map((m, idx) => (
            <div key={`${m.address}-${idx}`} style={{ fontSize: 11, overflowWrap: "anywhere" }}>
              To: <code style={{ wordBreak: "break-all" }}>{m.address}</code> · Amount:{" "}
              <strong>{formatNanoTon(m.amountNano)} TON</strong>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              style={{ flex: 1 }}
              onClick={() => void resolvePendingTonConnectTx(false)}
            >
              Reject
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              style={{ flex: 1 }}
              onClick={() => void resolvePendingTonConnectTx(true)}
            >
              <IconCheck size={14} />
              <span>Approve &amp; Sign BOC</span>
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handlePair} style={{ display: "grid", gap: 10 }}>
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
          <span>{busy ? "Connecting via Bridge..." : "Approve & Connect"}</span>
        </button>
      </form>

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
