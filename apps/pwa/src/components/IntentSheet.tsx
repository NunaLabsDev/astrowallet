import { useEffect, useState } from "react";
import {
  createHorizonPathSwapAdapter,
  parseSwapAssetIdentifier,
} from "@astrowallet/defi";
import type {
  ClassicAddress,
  ContractAddress,
  ScanReport,
  StellarAddress,
} from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export interface ActiveIntentRoute {
  intentId: string;
  sig: string;
  claimSecretHex?: string | undefined;
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
  claimId?: string | undefined;
  claimStatus?: "pending_funding" | "open" | "claimed" | "refunded" | "expired" | undefined;
  escrowContractId?: string | undefined;
  paidCount?: number | undefined;
  payload: {
    message?: string | undefined;
    amount?: string | undefined;
    totalAmount?: string | undefined;
    participantCount?: number | undefined;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
    destination?: string | undefined;
    recipientLabel?: string | undefined;
    recipientUsername?: string | undefined;
    senderLabel?: string | undefined;
    memo?: string | undefined;
    targetAddress?: string | undefined;
    targetLabel?: string | undefined;
    reclaimableXlm?: string | undefined;
    trustlines?: Array<{ assetCode: string; assetIssuer: string }> | undefined;
    fromAsset?: string | undefined;
    toAsset?: string | undefined;
    expectedOutputAmount?: string | undefined;
    provider?: string | undefined;
    priceImpactPct?: string | undefined;
    unsignedXdr?: string | undefined;
    escrowContractId?: string | undefined;
  };
  txHash?: string | undefined;
  expiresAt: number;
}

let cachedClaimSecret: { pathKey: string; secretHex: string } | null = null;

export function parseIntentRouteFromLocation(): ActiveIntentRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/intent\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
  if (!sig) return null;

  const pathKey = `${window.location.pathname}${window.location.search}`;
  const hashMatch = window.location.hash.match(/^#k=([0-9a-fA-F]{64})(?:&.*)?$/);
  let claimSecretHex: string | undefined;
  if (hashMatch?.[1]) {
    claimSecretHex = hashMatch[1].toLowerCase();
    cachedClaimSecret = { pathKey, secretHex: claimSecretHex };
    window.history.replaceState({}, "", pathKey);
  } else if (cachedClaimSecret?.pathKey === pathKey) {
    claimSecretHex = cachedClaimSecret.secretHex;
  }

  return {
    intentId: match[1],
    sig,
    ...(claimSecretHex ? { claimSecretHex } : {}),
  };
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
    executePathSwap,
    signAndSubmitRawXdrWithShield,
    fundClaimEscrow,
    claimFromEscrow,
  } = useWallet();

  const [intent, setIntent] = useState<RemoteIntentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedMsg, setCompletedMsg] = useState<string | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([0]);
  const [includeSmartAccount, setIncludeSmartAccount] = useState<boolean>(
    Boolean(config.smartAccountWasmHash),
  );
  const [manualClaimSecret, setManualClaimSecret] = useState("");
  const [shareClaimUrl, setShareClaimUrl] = useState<string | null>(null);
  const [copiedClaimUrl, setCopiedClaimUrl] = useState(false);
  const [destScanReport, setDestScanReport] = useState<ScanReport | null>(null);
  const [scanningIntent, setScanningIntent] = useState(false);

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

  useEffect(() => {
    if (!intent) {
      setDestScanReport(null);
      return undefined;
    }

    const scanTarget =
      (intent.actionType === "pay" ||
        intent.actionType === "request" ||
        intent.actionType === "split") &&
      intent.payload.destination
        ? intent.payload.destination
        : intent.actionType === "swap" && intent.payload.unsignedXdr
          ? intent.payload.unsignedXdr
          : null;

    if (!scanTarget) {
      setDestScanReport(null);
      return undefined;
    }

    let cancelled = false;
    async function runPreSignScan(targetValue: string) {
      setScanningIntent(true);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: targetValue }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { report?: ScanReport };
        if (!cancelled && body.report) {
          setDestScanReport(body.report);
        }
      } catch {
        // Non-fatal if proxy scan is temporarily unreachable
      } finally {
        if (!cancelled) setScanningIntent(false);
      }
    }
    void runPreSignScan(scanTarget);
    return () => {
      cancelled = true;
    };
  }, [intent, config.apiBaseUrl]);

  const toggleIndex = (idx: number) => {
    setSelectedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const confirmOnServer = async (extraBody: Record<string, unknown>) => {
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    const res = await fetch(
      `${base}/v1/intents/${encodeURIComponent(route.intentId)}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig: route.sig,
          ...extraBody,
        }),
      },
    );
    const body = (await res.json()) as {
      error?: string;
      telegramCardUpdated?: boolean;
      paidCount?: number;
      participantCount?: number;
      status?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? "Transaction confirmed on-chain, but bot callback failed");
    }
    return body;
  };

  const handleConfirmConnect = async () => {
    if (!intent?.payload.message) {
      setError("Connect challenge message is missing from intent");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proofs = await signConnectChallenge(
        intent.payload.message,
        selectedIndices,
        includeSmartAccount,
      );
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
        `Linked ${body.linkedCount ?? proofs.length} account(s) to @${config.tgBotUsername}. Return to Telegram to use /balance and /pay.`,
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
    if (destScanReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked transaction: ${destScanReport.findings[0]?.title ?? "malicious target"}`,
      );
      return;
    }
    if (destScanReport?.requiresMemoCheck && !intent.payload.memo?.trim()) {
      setError(
        "Scan & Shield: Destination requires a SEP-29 Deposit Memo before sending.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tx = await sendPayment({
        destination: intent.payload.destination as StellarAddress,
        amount: intent.payload.amount,
        assetCode: intent.payload.assetCode ?? "XLM",
        assetIssuer: intent.payload.assetIssuer,
        memoText: intent.payload.memo,
      });

      const confirmRes = await confirmOnServer({
        txHash: tx.hash,
        ...(activeAccount ? { payerAddress: activeAccount.address } : {}),
      });

      if (intent.actionType === "split") {
        setCompletedMsg(
          `Split share paid (${confirmRes.paidCount ?? 1}/${confirmRes.participantCount ?? intent.payload.participantCount ?? 2}) — ${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}.`,
        );
      } else {
        setCompletedMsg(
          `Confirmed on Stellar (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}). Telegram chat card updated live!`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment execution failed");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmSwap = async () => {
    if (!intent) return;
    if (destScanReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked swap: ${destScanReport.findings[0]?.title ?? "malicious contract"}`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let txHash: string;
      if (intent.payload.unsignedXdr) {
        const res = await signAndSubmitRawXdrWithShield(intent.payload.unsignedXdr, true);
        txHash = res.hash;
      } else {
        const { fromAsset, toAsset, amount } = intent.payload;
        if (!fromAsset || !toAsset || !amount) {
          throw new Error("Swap intent is missing pair or amount parameters");
        }
        const horizonAdapter = createHorizonPathSwapAdapter({
          horizonUrls: config.horizonUrls,
        });
        const freshQuote = await horizonAdapter.getQuote({
          fromAsset,
          toAsset,
          amount,
          slippageBps: 100,
        });
        const minNum = Math.max(0, Number(freshQuote.expectedOutputAmount) * 0.99);
        const destMin =
          minNum > 0
            ? (Math.floor(minNum * 10_000_000) / 10_000_000).toFixed(7)
            : "0.0000001";
        const sendParsed = parseSwapAssetIdentifier(fromAsset);
        const destParsed = parseSwapAssetIdentifier(toAsset);
        const res = await executePathSwap({
          sendAssetCode: sendParsed.code,
          sendAssetIssuer: sendParsed.issuer as ClassicAddress | undefined,
          sendAmount: amount,
          destAssetCode: destParsed.code,
          destAssetIssuer: destParsed.issuer as ClassicAddress | undefined,
          destMin,
          path: freshQuote.pathAssets,
        });
        txHash = res.hash;
      }

      await confirmOnServer({ txHash });
      setCompletedMsg(
        `Swap settled (${txHash.slice(0, 8)}…${txHash.slice(-8)}). Telegram chat card updated live!`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap execution failed");
    } finally {
      setBusy(false);
    }
  };

  const resolvedEscrowContract = (intent?.escrowContractId ??
    intent?.payload.escrowContractId ??
    config.claimEscrowContractId) as ContractAddress | undefined;

  const handleFundClaimEscrow = async () => {
    if (!intent || !activeAccount || !intent.claimId || !resolvedEscrowContract || !intent.payload.amount) {
      setError("Claim escrow configuration or claimId is missing");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fundResult = await fundClaimEscrow({
        escrowContractId: resolvedEscrowContract,
        claimIdHex: intent.claimId,
        amount: intent.payload.amount,
        assetCode: intent.payload.assetCode ?? "XLM",
        assetIssuer: intent.payload.assetIssuer,
        expiresAtUnix: intent.expiresAt,
      });

      await confirmOnServer({
        txHash: fundResult.hash,
        stage: "funded",
        senderAddress: activeAccount.address,
        expiresAt: fundResult.expiresAtUnix,
      });

      const privateUrl = `${config.pwaOrigin.replace(/\/+$/, "")}/intent/${encodeURIComponent(route.intentId)}?sig=${encodeURIComponent(route.sig)}#k=${fundResult.claimSecretSeedHex}`;
      setShareClaimUrl(privateUrl);
      setCompletedMsg(
        `Escrow locked (${fundResult.hash.slice(0, 8)}…${fundResult.hash.slice(-8)}). Send the private Claim Link below to @${intent.payload.recipientUsername ?? "recipient"}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Escrow funding failed");
    } finally {
      setBusy(false);
    }
  };

  const handleClaimFromEscrow = async () => {
    if (!intent || !activeAccount || !intent.claimId || !resolvedEscrowContract) {
      setError("Claim escrow configuration or claimId is missing");
      return;
    }
    const secretHex = (route.claimSecretHex ?? manualClaimSecret.trim()).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(secretHex)) {
      setError("Valid 64-char claim secret key (#k=) is required to unlock escrow");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await claimFromEscrow({
        escrowContractId: resolvedEscrowContract,
        claimIdHex: intent.claimId,
        claimSecretSeedHex: secretHex,
      });

      await confirmOnServer({
        txHash: res.hash,
        stage: "claimed",
        payerAddress: activeAccount.address,
      });

      cachedClaimSecret = null;
      setCompletedMsg(
        `Claimed ${intent.payload.amount ?? ""} ${intent.payload.assetCode ?? "XLM"} into ${activeAccount.label} (${res.hash.slice(0, 8)}…${res.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim execution failed");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReclaimReserve = async () => {
    setBusy(true);
    setError(null);
    try {
      const tx = await reclaimZeroBalanceReserves();
      await confirmOnServer({ txHash: tx.hash });
      setCompletedMsg(
        `Reclaimed +${tx.reclaimedXlm} XLM via LumenWipe (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reserve reclaim failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyClaimUrl = async () => {
    if (!shareClaimUrl) return;
    try {
      await navigator.clipboard.writeText(shareClaimUrl);
      setCopiedClaimUrl(true);
      setTimeout(() => setCopiedClaimUrl(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  const isClaimFundingView =
    intent?.actionType === "claim" &&
    (intent.claimStatus ?? "pending_funding") === "pending_funding" &&
    !route.claimSecretHex;

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
          {shareClaimUrl && (
            <div className="aw-banner aw-banner--warn" style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                Private Claim Link (Secret stays client-side in #k=)
              </div>
              <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                Neither the server nor the Telegram bot stores the #k= secret. Share this link
                directly with @{intent?.payload.recipientUsername ?? "recipient"}.
              </div>
              <input
                type="text"
                readOnly
                className="aw-input"
                value={shareClaimUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => void handleCopyClaimUrl()}
              >
                {copiedClaimUrl ? "Copied Claim Link" : "Copy Private Claim Link"}
              </button>
            </div>
          )}
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
                {config.smartAccountWasmHash && (
                  <label className="aw-list-row" style={{ cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={includeSmartAccount}
                        onChange={(e) => setIncludeSmartAccount(e.target.checked)}
                      />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Include paired Soroban Smart Account (C...)
                        </div>
                        <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                          Signed via your Primary G... Recovery Guardian
                        </div>
                      </div>
                    </div>
                    <span className="glass-pill glass-pill--gold">C...</span>
                  </label>
                )}
              </div>
              <button
                type="button"
                className="aw-btn-primary"
                disabled={busy || selectedIndices.length === 0}
                onClick={() => void handleConfirmConnect()}
              >
                {busy ? "Signing Challenge..." : `Sign & Link ${selectedIndices.length} Account(s)`}
              </button>
            </>
          ) : intent.actionType === "claim" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Amount</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.assetCode ?? "XLM"}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Recipient</span>
                <strong>@{intent.payload.recipientUsername ?? "recipient"}</strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Escrow Status
                </span>
                <span className="glass-pill">{intent.claimStatus ?? "pending_funding"}</span>
              </div>

              {intent.claimStatus === "claimed" ? (
                <div className="aw-banner">
                  This Claim Link has already been claimed on-chain.
                </div>
              ) : isClaimFundingView ? (
                <button
                  type="button"
                  className="aw-btn-primary"
                  disabled={busy || !resolvedEscrowContract}
                  onClick={() => void handleFundClaimEscrow()}
                >
                  {busy
                    ? "Locking Escrow on Soroban..."
                    : `Fund Escrow (${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"})`}
                </button>
              ) : (
                <>
                  {!route.claimSecretHex && (
                    <div>
                      <label className="aw-label" htmlFor="manual-claim-secret">
                        Claim Secret Key (64-hex from #k= link)
                      </label>
                      <input
                        id="manual-claim-secret"
                        type="password"
                        className="aw-input"
                        placeholder="Paste 64-character hex secret from sender's Claim Link"
                        value={manualClaimSecret}
                        onChange={(e) => setManualClaimSecret(e.target.value)}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className="aw-btn-gold"
                    disabled={busy || !resolvedEscrowContract}
                    onClick={() => void handleClaimFromEscrow()}
                  >
                    {busy
                      ? "Claiming from Escrow..."
                      : `Claim ${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"} to ${activeAccount?.label ?? "Account"}`}
                  </button>
                </>
              )}
            </>
          ) : intent.actionType === "swap" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Sell</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.fromAsset}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Receive (est.)
                </span>
                <strong className="tabular-nums" style={{ color: "var(--aw-stellar-gold)" }}>
                  {intent.payload.expectedOutputAmount} {intent.payload.toAsset}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Route</span>
                <span>
                  {intent.payload.provider ?? "horizon-path"} (~
                  {intent.payload.priceImpactPct ?? "0.05"}% impact)
                </span>
              </div>
              {scanningIntent && (
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Running Scan &amp; Shield pre-sign inspection...
                </div>
              )}
              {destScanReport && (
                <div
                  className={
                    destScanReport.verdict === "malicious"
                      ? "aw-banner aw-banner--danger"
                      : destScanReport.verdict === "warning"
                        ? "aw-banner aw-banner--warn"
                        : "aw-banner"
                  }
                  style={{ fontSize: 12 }}
                >
                  <strong>Scan &amp; Shield: {destScanReport.verdict.toUpperCase()}</strong>
                  {destScanReport.findings[0] && (
                    <div style={{ marginTop: 3 }}>{destScanReport.findings[0].description}</div>
                  )}
                </div>
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={busy || destScanReport?.verdict === "malicious"}
                onClick={() => void handleConfirmSwap()}
              >
                {busy ? "Signing & Settling Swap..." : "Sign & Execute Swap"}
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
              {intent.actionType === "split" && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                    Split Progress
                  </span>
                  <strong className="tabular-nums">
                    {intent.paidCount ?? 0} / {intent.payload.participantCount ?? 2} paid
                  </strong>
                </div>
              )}
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
              {scanningIntent && (
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Running Scan &amp; Shield destination &amp; SEP-29 memo check...
                </div>
              )}
              {destScanReport && (
                <div
                  className={
                    destScanReport.verdict === "malicious"
                      ? "aw-banner aw-banner--danger"
                      : destScanReport.requiresMemoCheck || destScanReport.verdict === "warning"
                        ? "aw-banner aw-banner--warn"
                        : "aw-banner"
                  }
                  style={{ fontSize: 12 }}
                >
                  <strong>Scan &amp; Shield: {destScanReport.verdict.toUpperCase()}</strong>
                  {destScanReport.requiresMemoCheck && !intent.payload.memo && (
                    <div style={{ marginTop: 3, color: "var(--aw-stellar-gold)" }}>
                      SEP-29 Memo Required by destination, and none is set on this intent.
                    </div>
                  )}
                  {destScanReport.findings[0] && (
                    <div style={{ marginTop: 3 }}>{destScanReport.findings[0].description}</div>
                  )}
                </div>
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={
                  busy ||
                  destScanReport?.verdict === "malicious" ||
                  Boolean(destScanReport?.requiresMemoCheck && !intent.payload.memo?.trim())
                }
                onClick={() => void handleConfirmPayment()}
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
