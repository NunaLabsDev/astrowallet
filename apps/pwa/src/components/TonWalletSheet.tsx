import { useState, type FormEvent } from "react";
import {
  formatNanoTon,
  isValidTonAddress,
  parseTonToNano,
} from "@astrowallet/ton-core";
import { useWallet } from "../state/wallet-context.js";
import { triggerTelegramHaptic } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { IconCheck, IconCopy, IconExternalLink, IconRefresh, IconSend } from "./Icons.js";

interface PendingTonReview {
  destination: string;
  amountTon: string;
  comment?: string | undefined;
}

export function TonWalletSheet() {
  const {
    config,
    activeIndex,
    tonAccount,
    tonState,
    loadingTonChain,
    tonChainError,
    refreshTonState,
    sendTonPayment,
  } = useWallet();

  const [destination, setDestination] = useState("");
  const [amountTon, setAmountTon] = useState("0.1");
  const [comment, setComment] = useState("");
  const [reviewPending, setReviewPending] = useState<PendingTonReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!tonAccount) return null;

  const formattedBalance = tonState ? formatNanoTon(tonState.balanceNano) : "0.0";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tonAccount.friendlyAddress);
      setCopied(true);
      triggerTelegramHaptic("selection");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const handlePrepareReview = (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setTxHash(null);

    const cleanDest = destination.trim();
    if (!isValidTonAddress(cleanDest)) {
      setErrorMsg("Enter a valid TON destination address (UQ..., EQ..., or 0:...).");
      return;
    }

    let nano: bigint;
    try {
      nano = parseTonToNano(amountTon.trim());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Invalid TON amount");
      return;
    }

    if (tonState && nano > BigInt(tonState.balanceNano)) {
      setErrorMsg(
        `Insufficient TON balance (${formatNanoTon(tonState.balanceNano)} TON available).`,
      );
      return;
    }

    triggerTelegramHaptic("selection");
    setReviewPending({
      destination: cleanDest,
      amountTon: amountTon.trim(),
      comment: comment.trim() || undefined,
    });
  };

  const handleConfirmSend = async () => {
    if (!reviewPending) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await sendTonPayment({
        destination: reviewPending.destination,
        amountTon: reviewPending.amountTon,
        comment: reviewPending.comment,
      });
      setTxHash(res.hash);
      setReviewPending(null);
      setDestination("");
      setComment("");
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setErrorMsg(err instanceof Error ? err.message : "TON transfer failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="glass-card glass-card--vault aw-hero-balance-card">
        <div className="aw-balance-top">
          <div className="aw-pixel-frame">
            <AstroNavigatorAvatar
              seedKey={tonAccount.rawAddress}
              kind="smart"
              state={loadingTonChain ? "warp" : txHash ? "zenith" : "float"}
              size={78}
            />
          </div>
          <div className="aw-balance-meta">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span className="glass-pill glass-pill--trust">TON {tonAccount.version.toUpperCase()}</span>
              <span className="glass-pill">m/44&apos;/607&apos;/{activeIndex}&apos;</span>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => void handleCopy()}
              >
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                <code>
                  {tonAccount.friendlyAddress.slice(0, 6)}…{tonAccount.friendlyAddress.slice(-6)}
                </code>
              </button>
            </div>

            <div className="aw-balance-figure tabular-nums">
              {formattedBalance}{" "}
              <span style={{ fontSize: 16, fontWeight: 600, color: "var(--aw-nebula-lavender)" }}>
                TON
              </span>
            </div>

            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Network: <strong>{config.tonNetwork.toUpperCase()}</strong> • Status:{" "}
              <code>{tonState?.state ?? (config.tonRpcUrls.length > 0 ? "uninitialized" : "rpc-unset")}</code>
              {tonState ? ` • seqno #${tonState.seqno}` : ""}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="aw-btn-secondary"
            onClick={() => void handleCopy()}
          >
            <IconCopy size={14} />
            <span>{copied ? "Copied TON Address" : "Copy TON Address"}</span>
          </button>
          <button
            type="button"
            className="aw-chip-btn"
            disabled={loadingTonChain}
            onClick={() => void refreshTonState()}
          >
            <IconRefresh size={13} />
            <span>{loadingTonChain ? "Syncing..." : "Refresh TON"}</span>
          </button>
          {config.tonExplorerBaseUrl && (
            <a
              href={`${config.tonExplorerBaseUrl.replace(/\/+$/, "")}/address/${tonAccount.friendlyAddress}`}
              target="_blank"
              rel="noreferrer"
              className="aw-chip-btn"
              style={{ textDecoration: "none" }}
            >
              <span>Explorer</span>
              <IconExternalLink size={12} />
            </a>
          )}
        </div>
      </section>

      {tonChainError && (
        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
          TON RPC: {tonChainError}
        </div>
      )}

      {config.tonRpcUrls.length === 0 && (
        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
          Configure <code>VITE_TON_RPC_URLS</code> in your Mini App environment to fetch live TON
          balances and broadcast transfers.
        </div>
      )}

      <section className="glass-card" style={{ display: "grid", gap: 10 }}>
        {reviewPending ? (
          <div className="aw-review-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Review TON Transfer</span>
              <span className="glass-pill glass-pill--trust">
                TON {config.tonNetwork.toUpperCase()}
              </span>
            </div>

            <div className="aw-review-amount tabular-nums">
              {reviewPending.amountTon} <span>TON</span>
            </div>

            <div className="aw-review-rows">
              <div className="aw-review-row">
                <span>From</span>
                <code>
                  {tonAccount.friendlyAddress.slice(0, 8)}…{tonAccount.friendlyAddress.slice(-6)}
                </code>
              </div>
              <div className="aw-review-row">
                <span>Destination</span>
                <code style={{ wordBreak: "break-all", textAlign: "right" }}>
                  {reviewPending.destination}
                </code>
              </div>
              <div className="aw-review-row">
                <span>Comment</span>
                <code>{reviewPending.comment ?? "None"}</code>
              </div>
            </div>

            {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="aw-btn-secondary"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => {
                  setErrorMsg(null);
                  setReviewPending(null);
                }}
              >
                ← Edit
              </button>
              <button
                type="button"
                className="aw-btn-primary"
                style={{ flex: 2 }}
                disabled={busy}
                onClick={() => void handleConfirmSend()}
              >
                <IconSend size={15} />
                <span>{busy ? "Signing & Broadcasting TON..." : "Confirm & Send TON"}</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Send TON</div>
            <form onSubmit={handlePrepareReview} style={{ display: "grid", gap: 10 }}>
              <div>
                <label className="aw-label" htmlFor="ton-send-dest">
                  Recipient TON Address
                </label>
                <input
                  id="ton-send-dest"
                  type="text"
                  className="aw-input"
                  placeholder="UQ... / EQ... / 0:..."
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </div>
              <div className="aw-two-col-inputs">
                <div>
                  <label className="aw-label" htmlFor="ton-send-amount">
                    Amount (TON)
                  </label>
                  <input
                    id="ton-send-amount"
                    type="text"
                    inputMode="decimal"
                    className="aw-input tabular-nums"
                    value={amountTon}
                    onChange={(e) => setAmountTon(e.target.value)}
                  />
                </div>
                <div>
                  <label className="aw-label" htmlFor="ton-send-comment">
                    Comment (Optional)
                  </label>
                  <input
                    id="ton-send-comment"
                    type="text"
                    maxLength={120}
                    className="aw-input"
                    placeholder="Payment memo"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </div>
              </div>

              {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
              {txHash && (
                <div className="aw-banner" style={{ fontSize: 12 }}>
                  Broadcasted TON transfer: <code>{txHash}</code>
                </div>
              )}

              <button
                type="submit"
                className="aw-btn-primary"
                disabled={busy || !destination.trim() || config.tonRpcUrls.length === 0}
              >
                <IconSend size={15} />
                <span>Review TON Transfer →</span>
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
