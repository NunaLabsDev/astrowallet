import { useEffect, useMemo, useState } from "react";
import {
  decodeAuthEntryXdr,
  type DecodedAuthEntrySummary,
} from "@astrowallet/security-shield";
import type {
  ConnectActionType,
  ConnectAppMetadata,
  ConnectAppTrustTier,
  ConnectRequestStatus,
  ScanReport,
} from "@astrowallet/domain";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import {
  openTelegramMiniAppLink,
  triggerTelegramHaptic,
} from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { ClearSignSummaryCard } from "./ClearSignSummaryCard.js";
import { requiresHighValueReauth } from "./flow-validators.js";
import { HighValueReauthGate } from "./HighValueReauthGate.js";

export interface ActiveConnectRoute {
  requestId: string;
  sig: string;
}

interface RemoteConnectRequest {
  requestId: string;
  network: string;
  action: ConnectActionType;
  status: ConnectRequestStatus;
  trustTier: ConnectAppTrustTier;
  app: ConnectAppMetadata;
  payload: {
    nonce?: string | undefined;
    statement?: string | undefined;
    domain?: string | undefined;
    includeAccounts?: boolean | undefined;
    challengeMessage?: string | undefined;
    message?: string | undefined;
    humanSummary?: string | undefined;
    unsignedXdr?: string | undefined;
    xdrSha256?: string | undefined;
    authEntryXdr?: string | undefined;
    entrySha256?: string | undefined;
    submit?: boolean | undefined;
    subAction?: string | undefined;
    sourceAddress?: string | undefined;
  };
  expiresAt: number;
  returnUrl: string;
}

export function parseConnectRouteFromLocation(): ActiveConnectRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/connect\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
  if (!sig) return null;
  return {
    requestId: match[1],
    sig,
  };
}

function trustTierLabel(tier: ConnectAppTrustTier): {
  badge: string;
  pillClass: string;
  note?: string;
} {
  switch (tier) {
    case "official":
      return { badge: "ASTRO Official", pillClass: "glass-pill glass-pill--trust" };
    case "verified":
      return { badge: "Verified App", pillClass: "glass-pill glass-pill--gold" };
    case "external":
      return {
        badge: "External App",
        pillClass: "glass-pill",
        note: "Unverified third-party app. Review every field and Scan & Shield report carefully before signing.",
      };
  }
}

export function ConnectRequestSheet({
  route,
  onDismiss,
}: {
  route: ActiveConnectRoute;
  onDismiss: () => void;
}) {
  const { sessionToken } = useTelegram();
  const {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    setActiveIndex,
    signActiveSep53Message,
    signAuthEntryWithShield,
    signRawXdrWithShield,
    signAndSubmitRawXdrWithShield,
  } = useWallet();

  const [request, setRequest] = useState<RemoteConnectRequest | null>(null);
  const [authEntrySummary, setAuthEntrySummary] = useState<DecodedAuthEntrySummary | null>(null);
  const [showRawAuthEntry, setShowRawAuthEntry] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedMsg, setCompletedMsg] = useState<string | null>(null);
  const [completedStatus, setCompletedStatus] = useState<"approved" | "rejected" | null>(null);
  const [completedReturnUrl, setCompletedReturnUrl] = useState<string | null>(null);
  const [completedTxHash, setCompletedTxHash] = useState<string | null>(null);
  const [autoReturnCancelled, setAutoReturnCancelled] = useState(false);
  const [scanReport, setScanReport] = useState<ScanReport | null>(null);
  const [scanningXdr, setScanningXdr] = useState(false);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [reauthVerified, setReauthVerified] = useState(false);

  useEffect(() => {
    setWarningAcknowledged(false);
    setReauthVerified(false);
  }, [route.requestId]);

  useEffect(() => {
    const requestedSource = request?.payload.sourceAddress?.trim();
    if (!requestedSource || activeAccount?.address === requestedSource) return;
    const match = accounts.find((a) => a.address === requestedSource);
    if (match && typeof match.derivationIndex === "number") {
      setActiveIndex(match.derivationIndex);
    }
  }, [request?.payload.sourceAddress, activeAccount?.address, accounts, setActiveIndex]);

  useEffect(() => {
    let cancelled = false;
    async function loadRequest() {
      setLoading(true);
      setError(null);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(
          `${base}/v1/connect/requests/${encodeURIComponent(route.requestId)}?sig=${encodeURIComponent(route.sig)}`,
          {
            headers: { "X-Astro-Network": config.network },
          },
        );
        const body = (await res.json()) as RemoteConnectRequest & { error?: string };
        if (!res.ok) {
          throw new Error(body.error ?? `Failed to load AstroConnect request (${res.status})`);
        }
        if (!cancelled) {
          setRequest(body);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load AstroConnect request",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void loadRequest();
    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl, config.network, route.requestId, route.sig]);

  useEffect(() => {
    if (!request) {
      setScanReport(null);
      setAuthEntrySummary(null);
      return undefined;
    }

    if (request.action === "sign_auth_entry" && request.payload.authEntryXdr) {
      let cancelled = false;
      try {
        const decoded = decodeAuthEntryXdr(request.payload.authEntryXdr);
        if (!cancelled) {
          setAuthEntrySummary(decoded);
        }
      } catch {
        if (!cancelled) setAuthEntrySummary(null);
      }
      setScanningXdr(true);
      void import("../state/session-vault.js")
        .then(({ inspectDappAuthEntrySecurity }) =>
          inspectDappAuthEntrySecurity(
            request.payload.authEntryXdr ?? "",
            config.networkPassphrase,
          ),
        )
        .then((inspected) => {
          if (cancelled) return;
          const verdict = inspected.blockedReason
            ? "malicious"
            : inspected.findings.some((f) => f.severity === "warning")
              ? "warning"
              : "benign";
          setScanReport({
            verdict,
            operationsCount: 1,
            findings: inspected.findings,
            balanceDiffs: [],
            requiresMemoCheck: false,
            estimatedFeeStroops: "0",
          });
        })
        .catch((err) => {
          if (!cancelled) {
            setScanReport({
              verdict: "malicious",
              operationsCount: 1,
              findings: [
                {
                  code: "AUTH_ENTRY_INVALID",
                  severity: "malicious",
                  title: "Invalid or cross-network Soroban auth entry",
                  description:
                    err instanceof Error ? err.message : "Failed to verify auth entry XDR",
                  blocksSigning: true,
                },
              ],
              balanceDiffs: [],
              requiresMemoCheck: false,
              estimatedFeeStroops: "0",
            });
          }
        })
        .finally(() => {
          if (!cancelled) setScanningXdr(false);
        });
      return () => {
        cancelled = true;
      };
    }

    setAuthEntrySummary(null);
    if (request.action !== "sign_xdr" || !request.payload.unsignedXdr) {
      setScanReport(null);
      return undefined;
    }
    const targetXdr = request.payload.unsignedXdr;
    let cancelled = false;
    async function runPreSignScan() {
      setScanningXdr(true);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Astro-Network": config.network,
          },
          body: JSON.stringify({
            target: targetXdr,
            ...(activeAccount?.address ? { sourceAddress: activeAccount.address } : {}),
          }),
        });
        if (!res.ok) {
          if (!cancelled && config.network === "mainnet") {
            setError("Mainnet pre-sign Scan & Shield check unavailable. Verify transaction carefully.");
          }
          return;
        }
        const data = (await res.json()) as { report?: ScanReport };
        if (!cancelled && data.report) {
          setScanReport(data.report);
        }
      } catch {
        // Local client-side Scan & Shield still runs inside signRawXdrWithShield
      } finally {
        if (!cancelled) setScanningXdr(false);
      }
    }
    void runPreSignScan();
    return () => {
      cancelled = true;
    };
  }, [
    request,
    config.apiBaseUrl,
    config.network,
    config.networkPassphrase,
    activeAccount?.address,
  ]);

  const trustMeta = useMemo(
    () => (request ? trustTierLabel(request.trustTier) : null),
    [request],
  );

  const submitCompletion = async (payload: Record<string, unknown>): Promise<string | null> => {
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Astro-Network": config.network,
    };
    if (sessionToken) {
      headers.Authorization = `Bearer ${sessionToken}`;
    }
    const res = await fetch(
      `${base}/v1/connect/requests/${encodeURIComponent(route.requestId)}/complete`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sig: route.sig,
          ...payload,
        }),
      },
    );
    const data = (await res.json()) as {
      error?: string;
      returnUrl?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `Failed to complete request (${res.status})`);
    }
    return data.returnUrl ?? request?.returnUrl ?? null;
  };

  const handleApprove = async () => {
    if (!request) return;
    if (vaultStatus !== "unlocked" || !activeAccount) {
      setError("Unlock or create your AstroWallet vault below before approving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let returnUrl: string | null = null;
      if (request.action === "auth") {
        const challenge = request.payload.challengeMessage;
        if (!challenge) {
          throw new Error("Missing auth challenge message");
        }
        const signed = await signActiveSep53Message(challenge);
        const includeAccounts = request.payload.includeAccounts !== false;
        const accountList = includeAccounts
          ? accounts.map((acc) => ({
              address: acc.address,
              kind: acc.kind,
              label: acc.label,
              isDefault: acc.address === activeAccount.address,
            }))
          : undefined;
        returnUrl = await submitCompletion({
          status: "approved",
          address: signed.signerAddress,
          ...(accountList ? { accounts: accountList } : {}),
          signatureBase64: signed.signature,
        });
        triggerTelegramHaptic("success");
        setCompletedMsg(`Signed in to ${request.app.name} as ${signed.signerAddress.slice(0, 6)}…${signed.signerAddress.slice(-4)}.`);
      } else if (request.action === "sign_message") {
        const msg = request.payload.message;
        if (!msg) {
          throw new Error("Missing message payload");
        }
        const signed = await signActiveSep53Message(msg);
        returnUrl = await submitCompletion({
          status: "approved",
          address: signed.signerAddress,
          signatureBase64: signed.signature,
        });
        triggerTelegramHaptic("success");
        setCompletedMsg(`Signed SEP-53 message for ${request.app.name}.`);
      } else if (request.action === "sign_auth_entry") {
        const authEntryXdr = request.payload.authEntryXdr;
        if (!authEntryXdr) {
          throw new Error("Missing authEntryXdr payload");
        }
        if (scanReport?.verdict === "malicious") {
          throw new Error(
            `Scan & Shield blocked auth entry: ${scanReport.findings[0]?.title ?? "malicious authorization"}`,
          );
        }
        if (scanReport?.verdict === "warning" && !warningAcknowledged) {
          throw new Error("Acknowledge the Scan & Shield warning before signing.");
        }
        const signed = await signAuthEntryWithShield(authEntryXdr, true);
        returnUrl = await submitCompletion({
          status: "approved",
          address: signed.signerAddress,
          signedAuthEntry: signed.signedAuthEntry,
        });
        triggerTelegramHaptic("success");
        setCompletedMsg(`Signed Soroban authorization entry for ${request.app.name}.`);
      } else {
        const unsignedXdr = request.payload.unsignedXdr;
        if (!unsignedXdr) {
          throw new Error("Missing unsignedXdr payload");
        }
        if (scanReport?.verdict === "malicious") {
          throw new Error(
            `Scan & Shield blocked transaction: ${scanReport.findings[0]?.title ?? "malicious transaction"}`,
          );
        }
        if (scanReport?.verdict === "warning" && !warningAcknowledged) {
          throw new Error("Acknowledge the Scan & Shield warning before signing.");
        }
        const shouldSubmit = request.payload.submit !== false;
        if (shouldSubmit) {
          const res = await signAndSubmitRawXdrWithShield(unsignedXdr, true);
          returnUrl = await submitCompletion({
            status: "approved",
            address: activeAccount.address,
            txHash: res.hash,
            ledger: res.ledger,
            signedXdr: res.signedXdr,
          });
          triggerTelegramHaptic("success");
          setCompletedTxHash(res.hash);
          setCompletedMsg(
            `Transaction confirmed on Stellar (${res.hash.slice(0, 8)}…${res.hash.slice(-8)}).`,
          );
        } else {
          const res = await signRawXdrWithShield(unsignedXdr, true);
          returnUrl = await submitCompletion({
            status: "approved",
            address: activeAccount.address,
            signedXdr: res.signedXdr,
          });
          triggerTelegramHaptic("success");
          setCompletedMsg(`Signed XDR returned securely to ${request.app.name}.`);
        }
      }
      setCompletedStatus("approved");
      setCompletedReturnUrl(returnUrl);
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Request approval failed");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const returnUrl = await submitCompletion({
        status: "rejected",
        reason: "User rejected in AstroWallet",
      });
      triggerTelegramHaptic("warning");
      setCompletedMsg(`Rejected request from ${request.app.name}.`);
      setCompletedStatus("rejected");
      setCompletedReturnUrl(returnUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject request");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!completedMsg || autoReturnCancelled) return undefined;
    const statusToSend = completedStatus ?? "approved";
    if (typeof window !== "undefined" && window.opener && !window.opener.closed) {
      let targetOrigin: string | null = null;
      try {
        if (request?.app.origin) {
          targetOrigin = new URL(request.app.origin).origin;
        } else if (document.referrer) {
          targetOrigin = new URL(document.referrer).origin;
        }
      } catch {
        targetOrigin = null;
      }
      if (targetOrigin) {
        try {
          window.opener.postMessage(
            {
              type: "ASTRO_SIGN_COMPLETE",
              status: statusToSend,
              requestId: route.requestId,
              txHash: statusToSend === "approved" ? completedTxHash : null,
            },
            targetOrigin,
          );
        } catch {
          // Ignore postMessage error
        }
      }
      const timer = window.setTimeout(() => {
        window.close();
      }, 900);
      return () => window.clearTimeout(timer);
    }
    if (completedReturnUrl) {
      const timer = window.setTimeout(() => {
        openBoomerang(completedReturnUrl);
      }, 900);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [
    completedMsg,
    completedStatus,
    autoReturnCancelled,
    route.requestId,
    completedTxHash,
    completedReturnUrl,
    request?.app.origin,
  ]);

  const openBoomerang = (url: string) => {
    openTelegramMiniAppLink(url);
  };

  return (
    <section className="glass-sheet" aria-label="AstroConnect Request">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 200px" }}>
          <AstroNavigatorAvatar
            seedKey={route.requestId}
            kind="classic"
            state={completedMsg ? "zenith" : request?.action === "auth" ? "comms" : "shield"}
            size={54}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {request?.action === "auth"
                ? "Sign In with AstroWallet"
                : request?.action === "sign_message"
                  ? "Sign Message (SEP-53)"
                  : "Clear-Sign Transaction"}
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", overflowWrap: "anywhere" }}>
              AstroConnect v1 • {route.requestId} • {config.network.toUpperCase()}
            </div>
          </div>
        </div>
        <button type="button" className="aw-chip-btn" onClick={onDismiss}>
          Close
        </button>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
          Verifying AstroConnect request...
        </div>
      )}

      {error && (
        <div className="aw-banner aw-banner--danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {completedMsg && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <div className="aw-banner">{completedMsg}</div>
          {!autoReturnCancelled && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              <span>Returning automatically…</span>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => setAutoReturnCancelled(true)}
              >
                Stay Here
              </button>
            </div>
          )}
          {completedReturnUrl && (
            <button
              type="button"
              className="aw-btn-primary"
              onClick={() => openBoomerang(completedReturnUrl)}
            >
              Return to {request?.app.name ?? "App"}
            </button>
          )}
        </div>
      )}

      {!loading && request && !completedMsg && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <div className="aw-list-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{request.app.name}</div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                @{request.app.botUsername}
                {request.app.origin ? ` • ${request.app.origin}` : ""}
              </div>
            </div>
            {trustMeta && <span className={trustMeta.pillClass}>{trustMeta.badge}</span>}
          </div>

          {trustMeta?.note && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              {trustMeta.note}
            </div>
          )}

          {request.status !== "pending" ? (
            <div className="aw-banner">
              This AstroConnect request is already <strong>{request.status}</strong>.
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="aw-btn-secondary"
                  onClick={() => openBoomerang(request.returnUrl)}
                >
                  Return to {request.app.name}
                </button>
              </div>
            </div>
          ) : (
            <>
              {vaultStatus !== "unlocked" && (
                <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                  Unlock or create your AstroWallet vault below to sign and approve this request.
                </div>
              )}

              {activeAccount && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                    Signing Account
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {activeAccount.label} ({activeAccount.address.slice(0, 6)}…
                    {activeAccount.address.slice(-4)})
                  </span>
                </div>
              )}

              {request.action === "auth" && (
                <>
                  {request.payload.statement && (
                    <div className="aw-banner" style={{ fontSize: 12 }}>
                      {request.payload.statement}
                    </div>
                  )}
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Scope</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      Public Stellar address + SEP-53 login proof (0 private keys shared)
                    </span>
                  </div>
                </>
              )}

              {request.action === "sign_message" && (
                <div style={{ display: "grid", gap: 6 }}>
                  {request.payload.humanSummary && (
                    <div className="aw-banner" style={{ fontSize: 12 }}>
                      <strong>Summary:</strong> {request.payload.humanSummary}
                    </div>
                  )}
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      borderRadius: 10,
                      background: "rgba(6, 14, 36, 0.55)",
                      fontSize: 12,
                      maxHeight: 160,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {request.payload.message}
                  </pre>
                </div>
              )}

              {(request.action === "sign_xdr" || request.action === "sign_auth_entry") && (
                <>
                  {request.action === "sign_xdr" && request.payload.unsignedXdr && (
                    <ClearSignSummaryCard
                      unsignedXdr={request.payload.unsignedXdr}
                      networkPassphrase={config.networkPassphrase}
                      scanReport={scanReport}
                      overrideSummary={request.payload.humanSummary}
                    />
                  )}
                  {request.action === "sign_auth_entry" && request.payload.authEntryXdr && (
                    <div className="glass-card" style={{ display: "grid", gap: 8, padding: 12 }}>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aw-nebula-lavender)", fontWeight: 700 }}>
                        Soroban Auth Entry Clear-Sign (SEP-60)
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {request.payload.humanSummary ??
                          `Authorize ${authEntrySummary?.invocation.functionName ?? "Soroban contract"}()`}
                      </div>
                      {authEntrySummary && (
                        <div className="aw-review-rows" style={{ fontSize: 12 }}>
                          <div className="aw-review-row">
                            <span>Function</span>
                            <code>{authEntrySummary.invocation.functionName}</code>
                          </div>
                          {authEntrySummary.invocation.contractId && (
                            <div className="aw-review-row">
                              <span>Contract</span>
                              <code style={{ wordBreak: "break-all" }}>
                                {authEntrySummary.invocation.contractId}
                              </code>
                            </div>
                          )}
                          {authEntrySummary.signatureExpirationLedger !== undefined && (
                            <div className="aw-review-row">
                              <span>Expires Ledger</span>
                              <code className="tabular-nums">
                                #{authEntrySummary.signatureExpirationLedger}
                              </code>
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        className="aw-chip-btn"
                        style={{ justifySelf: "flex-start", fontSize: 11 }}
                        onClick={() => setShowRawAuthEntry((prev) => !prev)}
                      >
                        {showRawAuthEntry ? "Hide Raw Auth XDR" : "Pro Inspector · Auth XDR"}
                      </button>
                      {showRawAuthEntry && (
                        <pre style={{ margin: 0, padding: 8, borderRadius: 8, background: "rgba(11,20,51,0.85)", fontSize: 11, overflowX: "auto", maxHeight: 160 }}>
                          {JSON.stringify(
                            {
                              kind: authEntrySummary?.kind ?? "unknown",
                              invocation: authEntrySummary?.invocation ?? null,
                              rawPrefix: request.payload.authEntryXdr.slice(0, 120),
                            },
                            null,
                            2,
                          )}
                        </pre>
                      )}
                    </div>
                  )}
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Execution Mode
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {request.action === "sign_auth_entry"
                        ? "Zero-XLM Auth Signature Only (Returns signed auth)"
                        : request.payload.submit !== false
                          ? "Sign & Submit to Stellar"
                          : "Sign Only (Return Signed XDR)"}
                    </span>
                  </div>
                  {scanningXdr && (
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      Running Scan &amp; Shield XDR simulation...
                    </div>
                  )}
                  {scanReport && (
                    <div
                      className={
                        scanReport.verdict === "malicious"
                          ? "aw-banner aw-banner--danger"
                          : scanReport.verdict === "warning"
                            ? "aw-banner aw-banner--warn"
                            : "aw-banner"
                      }
                      style={{ fontSize: 12, display: "grid", gap: 6 }}
                    >
                      <strong>Scan &amp; Shield: {scanReport.verdict.toUpperCase()}</strong>
                      {scanReport.findings[0] && <div>{scanReport.findings[0].description}</div>}
                      {scanReport.verdict === "warning" && (
                        <label className="aw-checkbox-row" style={{ marginTop: 4 }}>
                          <input
                            type="checkbox"
                            checked={warningAcknowledged}
                            onChange={(e) => setWarningAcknowledged(e.target.checked)}
                          />
                          <span>I reviewed this warning and accept the risk.</span>
                        </label>
                      )}
                    </div>
                  )}
                  {(() => {
                    const gate = requiresHighValueReauth({
                      network: config.network,
                      hasWarningVerdict: scanReport?.verdict === "warning",
                    });
                    return gate.required && gate.reason ? (
                      <HighValueReauthGate
                        reason={gate.reason}
                        verified={reauthVerified}
                        onVerified={() => setReauthVerified(true)}
                      />
                    ) : null;
                  })()}
                </>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="aw-btn-secondary"
                  disabled={busy}
                  onClick={() => void handleReject()}
                  style={{ flex: "1 1 0" }}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="aw-btn-primary"
                  disabled={
                    busy ||
                    scanningXdr ||
                    vaultStatus !== "unlocked" ||
                    !activeAccount ||
                    ((request.action === "sign_xdr" || request.action === "sign_auth_entry") &&
                      (scanReport?.verdict === "malicious" ||
                        (scanReport?.verdict === "warning" && !warningAcknowledged) ||
                        (requiresHighValueReauth({
                          network: config.network,
                          hasWarningVerdict: scanReport?.verdict === "warning",
                        }).required &&
                          !reauthVerified)))
                  }
                  onClick={() => void handleApprove()}
                  style={{ flex: "2 1 0" }}
                >
                  {busy
                    ? "Signing..."
                    : request.action === "auth"
                      ? "Approve & Sign In"
                      : request.action === "sign_message"
                        ? "Sign Message"
                        : request.action === "sign_auth_entry"
                          ? "Approve Soroban Auth"
                          : request.payload.submit !== false
                            ? "Sign & Execute"
                            : "Sign XDR Only"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
