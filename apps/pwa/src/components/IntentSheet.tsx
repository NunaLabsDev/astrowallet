import { useEffect, useState } from "react";
import type { StellarAddress } from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export interface ActiveIntentRoute {
  intentId: string;
  sig: string;
}

interface RemoteIntentResponse {
  intentId: string;
  network: string;
  actionType:
    | "connect"
    | "pay"
    | "request"
    | "split"
    | "swap"
    | "claim"
    | "reclaim_reserve"
    | "sign_xdr";
  status: string;
  payload: {
    message?: string;
    amount?: string;
    assetCode?: string;
    destination?: string;
    recipientLabel?: string;
    senderLabel?: string;
    memo?: string;
    targetAddress?: string;
    targetLabel?: string;
    reclaimableXlm?: string;
    trustlines?: Array<{ assetCode: string; assetIssuer: string }>;
  };
  txHash?: string;
  expiresAt: number;
}

export function parseIntentRouteFromLocation(): ActiveIntentRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/intent\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
  if (!sig) return null;
  return { intentId: match[1], sig };
}

export function IntentSheet({
  route,
  onDismiss,
}: {
  route: ActiveIntentRoute;
  onDismiss: () => void;
}) {
  const {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    signConnectChallenge,
    sendPayment,
    reclaimZeroBalanceReserves,
  } = useWallet();

  const [intent, setIntent] = useState<RemoteIntentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedMsg, setCompletedMsg] = useState<string | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([0]);

  useEffect(() => {
    if (accounts.length > 0) {
      setSelectedIndices(accounts.map((a) => a.derivationIndex ?? 0));
    }
  }, [accounts]);

  useEffect(() => {
    let cancelled = false;
    async function fetchIntent() {
      setLoading(true);
      setError(null);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(
          `${base}/v1/intents/${encodeURIComponent(route.intentId)}?sig=${encodeURIComponent(route.sig)}`,
        );
        const data = (await res.json()) as RemoteIntentResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `Failed to load intent (${res.status})`);
        }
        if (!cancelled) {
          setIntent(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load signed Telegram intent");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void fetchIntent();
    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl, route.intentId, route.sig]);

  const toggleIndex = (idx: number) => {
    setSelectedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const handleConfirmConnect = async () => {
    if (!intent?.payload.message) {
      setError("Connect challenge message is missing from intent");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proofs = await signConnectChallenge(intent.payload.message, selectedIndices);
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(
        `${base}/v1/intents/${encodeURIComponent(route.intentId)}/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sig: route.sig,
            accounts: proofs,
          }),
        },
      );
      const body = (await res.json()) as { ok?: boolean; linkedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to verify connect signature");
      }
      setCompletedMsg(
        `Linked ${body.linkedCount ?? proofs.length} SEP-0005 account(s) to @${config.tgBotUsername}. Return to Telegram to use /balance and /pay.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete /connect");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPayment = async () => {
    if (!intent?.payload.destination || !intent.payload.amount) {
      setError("Payment intent is missing destination or amount");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tx = await sendPayment({
        destination: intent.payload.destination as StellarAddress,
        amount: intent.payload.amount,
        assetCode: intent.payload.assetCode ?? "XLM",
        memoText: intent.payload.memo,
      });

      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(
        `${base}/v1/intents/${encodeURIComponent(route.intentId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sig: route.sig,
            txHash: tx.hash,
          }),
        },
      );
      const body = (await res.json()) as { error?: string; telegramCardUpdated?: boolean };
      if (!res.ok) {
        throw new Error(body.error ?? "Transaction confirmed on-chain, but bot callback failed");
      }
      setCompletedMsg(
        `Confirmed on Stellar (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}). Telegram chat card updated live!`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment execution failed");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReclaimReserve = async () => {
    setBusy(true);
    setError(null);
    try {
      const tx = await reclaimZeroBalanceReserves();
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(
        `${base}/v1/intents/${encodeURIComponent(route.intentId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sig: route.sig,
            txHash: tx.hash,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Reserve reclaim confirmed on-chain, but server callback failed");
      }
      setCompletedMsg(
        `Reclaimed +${tx.reclaimedXlm} XLM via LumenWipe (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reserve reclaim failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-sheet" aria-label="Telegram Signed Intent">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <AstroNavigatorAvatar
            seedKey={route.intentId}
            kind="classic"
            state={completedMsg ? "zenith" : intent?.actionType === "connect" ? "comms" : "shield"}
            size={54}
          />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Telegram Signed Intent
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              ID: {route.intentId} • {config.network.toUpperCase()}
            </div>
          </div>
        </div>
        <button type="button" className="aw-chip-btn" onClick={onDismiss}>
          Close
        </button>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
          Verifying HMAC signature &amp; loading intent from server...
        </div>
      )}

      {error && (
        <div className="aw-banner aw-banner--danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {completedMsg && (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="aw-banner">{completedMsg}</div>
          <a
            href={`https://t.me/${config.tgBotUsername}`}
            className="aw-btn-primary"
            style={{
              textAlign: "center",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Return to @{config.tgBotUsername}
          </a>
        </div>
      )}

      {!loading && intent && !completedMsg && (
        <div style={{ display: "grid", gap: 12 }}>
          {vaultStatus !== "unlocked" ? (
            <div className="aw-banner aw-banner--warn">
              Unlock or create your vault below first—this Telegram Intent will stay ready right
              here.
            </div>
          ) : intent.actionType === "connect" ? (
            <>
              <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
                Select which derived SEP-0005 accounts to link to your Telegram handle (your seed
                phrase never leaves this phone):
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {accounts.map((acc) => {
                  const idx = acc.derivationIndex ?? 0;
                  const checked = selectedIndices.includes(idx);
                  return (
                    <label
                      key={acc.id}
                      className="aw-list-row"
                      style={{ cursor: "pointer" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIndex(idx)}
                        />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{acc.label}</div>
                          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                            {acc.address.slice(0, 8)}…{acc.address.slice(-8)}
                          </div>
                        </div>
                      </div>
                      <span className="glass-pill">m/44&apos;/148&apos;/{idx}&apos;</span>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="aw-btn-primary"
                disabled={busy || selectedIndices.length === 0}
                onClick={handleConfirmConnect}
              >
                {busy ? "Signing Challenge..." : `Sign & Link ${selectedIndices.length} Account(s)`}
              </button>
            </>
          ) : intent.actionType === "reclaim_reserve" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Account</span>
                <strong style={{ fontSize: 13 }}>
                  {intent.payload.targetLabel ?? activeAccount?.label}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Reclaimable XLM</span>
                <strong className="tabular-nums">
                  +{intent.payload.reclaimableXlm ?? intent.payload.amount ?? "0.5"} XLM
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Zero-Balance Trustlines
                </span>
                <span>{intent.payload.trustlines?.length ?? 0}</span>
              </div>
              <button
                type="button"
                className="aw-btn-gold"
                disabled={busy}
                onClick={() => void handleConfirmReclaimReserve()}
              >
                {busy ? "Reclaiming Locked Reserves..." : "Reclaim Locked XLM Now"}
              </button>
            </>
          ) : (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Amount</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.assetCode ?? "XLM"}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Recipient</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {intent.payload.recipientLabel ?? intent.payload.destination}
                </span>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Paying From
                </span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {activeAccount?.label} ({activeAccount?.address.slice(0, 6)}…
                  {activeAccount?.address.slice(-4)})
                </span>
              </div>
              {intent.payload.memo && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Memo</span>
                  <code>{intent.payload.memo}</code>
                </div>
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={busy}
                onClick={handleConfirmPayment}
              >
                {busy
                  ? "Signing & Updating Telegram..."
                  : `Confirm ${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"}`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
