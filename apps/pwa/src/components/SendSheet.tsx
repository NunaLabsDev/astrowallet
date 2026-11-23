import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  StellarAddressSchema,
  type ScanReport,
  type StellarAddress,
} from "@astrowallet/domain";
import {
  parseSep7Uri,
  type TypedMemoInput,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { mapSep7MemoKind } from "../state/session-vault.js";
import { copyTextToClipboard, triggerTelegramHaptic } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import {
  requiresHighValueReauth,
  validateStellarMemoInput,
  validateTransferAmount,
} from "./flow-validators.js";
import { HighValueReauthGate } from "./HighValueReauthGate.js";
import { TokenBadge } from "./TokenBadge.js";
import { classifyTokenTrust } from "./token-catalog.js";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconExternalLink,
  IconQr,
  IconSend,
  IconShield,
  IconUserPlus,
} from "./Icons.js";

type MemoKind = TypedMemoInput["kind"];

interface PendingStellarReview {
  destination: StellarAddress;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  typedMemo?: TypedMemoInput | undefined;
  memoSummary?: string | undefined;
  saveAsContact: boolean;
  contactLabel: string;
}

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

export interface SendSheetProps {
  onClose: () => void;
  embedded?: boolean | undefined;
  initialAssetCode?: string | undefined;
  initialAssetIssuer?: string | undefined;
  initialDestination?: string | undefined;
  initialMemo?: string | undefined;
  initialAmount?: string | undefined;
}

function assetKeyOf(code: string, issuer?: string): string {
  return `${code}:${issuer ?? "native"}`;
}

function formatTruncatedAmount(num: number): string {
  if (!Number.isFinite(num) || num <= 0) return "0";
  const floored = Math.floor(num * 10_000_000) / 10_000_000;
  return floored.toFixed(7).replace(/\.?0+$/, "");
}

export function SendSheet({
  onClose,
  embedded = false,
  initialAssetCode,
  initialAssetIssuer,
  initialDestination,
  initialMemo,
  initialAmount,
}: SendSheetProps) {
  const {
    activeAccount,
    accounts,
    accountState,
    contacts,
    verifiedAssets,
    tokenMetaMap,
    sendPayment,
    saveContact,
    showToast,
    config,
  } = useWallet();

  const availableAssets = useMemo(() => {
    const list = accountState?.balances ?? [];
    if (list.length > 0) return list;
    return [{ assetCode: "XLM", balance: "0.0000000", isVerifiedAsset: true }];
  }, [accountState?.balances]);

  const [selectedAssetKey, setSelectedAssetKey] = useState<string>(() =>
    assetKeyOf(initialAssetCode ?? "XLM", initialAssetIssuer),
  );
  const [destination, setDestination] = useState(initialDestination ?? "");
  const [amount, setAmount] = useState(initialAmount ?? "");
  const [memoKind, setMemoKind] = useState<MemoKind>("text");
  const [memoValue, setMemoValue] = useState(initialMemo ?? "");
  const [saveAsContact, setSaveAsContact] = useState(false);
  const [contactLabel, setContactLabel] = useState("");

  const [resolvingFed, setResolvingFed] = useState(false);
  const [destShieldReport, setDestShieldReport] = useState<ScanReport | null>(null);
  const [scanningDest, setScanningDest] = useState(false);

  const [qrOpen, setQrOpen] = useState(false);
  const [qrMessage, setQrMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState<PendingStellarReview | null>(null);
  const [reauthVerified, setReauthVerified] = useState(false);
  const [confirmedTxHash, setConfirmedTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  const selectedBalance = useMemo(
    () =>
      availableAssets.find(
        (b) => assetKeyOf(b.assetCode, b.assetIssuer) === selectedAssetKey,
      ) ??
      availableAssets[0] ?? {
        assetCode: "XLM",
        balance: "0",
        isVerifiedAsset: true,
      },
    [availableAssets, selectedAssetKey],
  );

  const selectedAssetTrust = useMemo(
    () =>
      classifyTokenTrust({
        assetCode: selectedBalance.assetCode,
        assetIssuer: selectedBalance.assetIssuer,
        verifiedAssets,
      }),
    [selectedBalance.assetCode, selectedBalance.assetIssuer, verifiedAssets],
  );

  const selectedAssetToml = selectedBalance.assetIssuer
    ? tokenMetaMap[`${selectedBalance.assetCode.toUpperCase()}:${selectedBalance.assetIssuer}`]
    : undefined;
  const selectedAssetVerified = selectedBalance.assetIssuer
    ? verifiedAssets.find(
        (v) =>
          v.code.toUpperCase() === selectedBalance.assetCode.toUpperCase() &&
          v.issuer === selectedBalance.assetIssuer,
      )
    : undefined;
  const selectedAssetIcon = selectedAssetToml?.image ?? selectedAssetVerified?.icon;
  const selectedAssetFallbackIcon =
    selectedAssetVerified?.icon && selectedAssetVerified.icon !== selectedAssetIcon
      ? selectedAssetVerified.icon
      : undefined;
  const isSelectedNative =
    selectedBalance.assetCode.toUpperCase() === "XLM" && !selectedBalance.assetIssuer;

  const maxSpendableNumber = useMemo(() => {
    const isNative = selectedBalance.assetCode === "XLM" && !selectedBalance.assetIssuer;
    if (isNative) {
      const spendable = Number(accountState?.spendableXlm ?? selectedBalance.balance);
      return Math.max(0, spendable - 0.001);
    }
    return Math.max(0, Number(selectedBalance.balance));
  }, [selectedBalance, accountState?.spendableXlm]);

  // Live pre-send Scan & Shield check on valid destination strkeys
  useEffect(() => {
    const trimmed = destination.trim();
    const parsed = StellarAddressSchema.safeParse(trimmed);
    if (!parsed.success) {
      setDestShieldReport(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setScanningDest(true);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Astro-Network": config.network,
          },
          body: JSON.stringify({ target: parsed.data }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { report?: ScanReport };
        if (!cancelled && body.report) {
          setDestShieldReport(body.report);
        }
      } catch {
        // Offline/proxy timeout does not block manual review
      } finally {
        if (!cancelled) setScanningDest(false);
      }
    }, 320);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, config.apiBaseUrl, config.network]);

  // Clean up QR video stream
  useEffect(() => {
    if (!qrOpen) return undefined;

    let stopped = false;
    let stream: MediaStream | null = null;
    let rafId = 0;

    async function startScanner() {
      const ctor = (
        window as unknown as {
          BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
        }
      ).BarcodeDetector;

      if (!ctor || !navigator.mediaDevices?.getUserMedia) {
        setQrMessage(
          "In-browser QR camera scanner is unavailable in this browser; paste a G... address or web+stellar:pay URI above.",
        );
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const videoEl = videoRef.current;
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await videoEl.play();

        const detector = new ctor({ formats: ["qr_code"] });
        const loop = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const raw = found[0]?.rawValue?.trim();
            if (raw) {
              applyIncomingUriOrAddress(raw);
              setQrOpen(false);
              return;
            }
          } catch {
            // Keep scanning
          }
          rafId = window.requestAnimationFrame(() => {
            void loop();
          });
        };
        rafId = window.requestAnimationFrame(() => {
          void loop();
        });
      } catch (err) {
        setQrMessage(
          err instanceof Error
            ? `Camera access denied: ${err.message}`
            : "Unable to open device camera for QR scan.",
        );
      }
    }

    void startScanner();

    return () => {
      stopped = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [qrOpen]);

  if (!activeAccount) return null;

  const applyIncomingUriOrAddress = (raw: string) => {
    const trimmed = raw.trim();
    if (/^web\+stellar:(pay|tx)\?/i.test(trimmed)) {
      try {
        const parsed = parseSep7Uri(trimmed);
        if (parsed.destination) setDestination(parsed.destination);
        if (parsed.amount) setAmount(parsed.amount);
        if (parsed.assetCode && parsed.assetIssuer) {
          const match = availableAssets.find(
            (b) =>
              b.assetCode.toUpperCase() === parsed.assetCode?.toUpperCase() &&
              b.assetIssuer === parsed.assetIssuer,
          );
          if (match) {
            setSelectedAssetKey(assetKeyOf(match.assetCode, match.assetIssuer));
          }
        }
        if (parsed.memo) {
          setMemoKind(mapSep7MemoKind(parsed.memoType));
          setMemoValue(parsed.memo);
        }
        setError(null);
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid SEP-0007 URI");
      }
    }
    setDestination(trimmed);
  };

  const handleResolveFederation = async () => {
    const clean = destination.trim();
    if (!clean.includes("*")) return;
    setResolvingFed(true);
    setError(null);
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(
        `${base}/v1/proxy/federation?q=${encodeURIComponent(clean)}`,
        { headers: { "X-Astro-Network": config.network } },
      );
      const rec = (await res.json()) as {
        accountId?: string;
        memoType?: string;
        memo?: string;
        error?: string;
      };
      if (!res.ok || !rec.accountId) {
        throw new Error(rec.error ?? "Unable to resolve Stellar Federation address");
      }
      setDestination(rec.accountId);
      if (rec.memo) {
        setMemoKind(rec.memoType === "id" ? "id" : "text");
        setMemoValue(rec.memo);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to resolve Stellar Federation address",
      );
    } finally {
      setResolvingFed(false);
    }
  };

  const applyPercentage = (ratio: number) => {
    setAmount(formatTruncatedAmount(maxSpendableNumber * ratio));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (config.network === "mainnet" && scanningDest) {
      setError("Waiting for destination security & SEP-29 memo check...");
      return;
    }

    if (destShieldReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked transaction: ${destShieldReport.findings[0]?.title ?? "malicious destination"}`,
      );
      return;
    }

    const parsedDest = StellarAddressSchema.safeParse(destination.trim());
    if (!parsedDest.success) {
      setError(
        "Enter a valid Stellar G..., C..., or M... destination (or resolve a user*domain Federation address first).",
      );
      return;
    }

    const amountError = validateTransferAmount(
      amount,
      accountState ? maxSpendableNumber : Number.POSITIVE_INFINITY,
      {
        assetCode: selectedBalance.assetCode,
        funded: accountState?.funded,
      },
    );
    if (amountError) {
      setError(amountError);
      return;
    }

    const memoError = validateStellarMemoInput(memoKind, memoValue);
    if (memoError) {
      setError(memoError);
      return;
    }

    if (
      destShieldReport?.requiresMemoCheck &&
      (memoKind === "none" || memoValue.trim().length === 0)
    ) {
      setError(
        "Scan & Shield: Destination requires a SEP-29 Deposit Memo before sending.",
      );
      return;
    }

    let typedMemo: TypedMemoInput | undefined;
    const cleanMemo = memoValue.trim();
    if (memoKind !== "none" && cleanMemo.length > 0) {
      if (memoKind === "text") {
        typedMemo = { kind: "text", value: cleanMemo };
      } else if (memoKind === "id") {
        typedMemo = { kind: "id", value: cleanMemo };
      } else if (memoKind === "hash") {
        typedMemo = { kind: "hash", valueHex: cleanMemo };
      } else if (memoKind === "return") {
        typedMemo = { kind: "return", valueHex: cleanMemo };
      }
    }

    const reauthCheck = reviewPending
      ? requiresHighValueReauth({
          amount: reviewPending.amount,
          assetCode: reviewPending.assetCode,
          spendableBalance: maxSpendableNumber,
          thresholdXlm: config.highValueReauthXlm,
          network: config.network,
          hasWarningVerdict: destShieldReport?.verdict === "warning",
        })
      : { required: false };

    triggerTelegramHaptic("selection");
    setReauthVerified(false);
    setReviewPending({
      destination: parsedDest.data,
      amount: amount.trim(),
      assetCode: selectedBalance.assetCode,
      assetIssuer: selectedBalance.assetIssuer,
      typedMemo,
      memoSummary: typedMemo ? `${memoKind.toUpperCase()}: ${cleanMemo}` : undefined,
      saveAsContact,
      contactLabel: contactLabel.trim(),
    });
    void reauthCheck;
  };

  const handleConfirmBroadcast = async () => {
    if (!reviewPending) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendPayment({
        destination: reviewPending.destination,
        amount: reviewPending.amount,
        assetCode: reviewPending.assetCode,
        assetIssuer: reviewPending.assetIssuer,
        typedMemo: reviewPending.typedMemo,
      });
      if (reviewPending.saveAsContact && reviewPending.contactLabel) {
        const defaultMemo =
          reviewPending.typedMemo?.kind === "text" || reviewPending.typedMemo?.kind === "id"
            ? reviewPending.typedMemo.value
            : undefined;
        await saveContact({
          label: reviewPending.contactLabel,
          address: reviewPending.destination,
          defaultMemo,
        }).catch(() => undefined);
      }
      setConfirmedTxHash(res.hash);
      setReviewPending(null);
      triggerTelegramHaptic("success");
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyHash = async () => {
    if (!confirmedTxHash) return;
    const ok = await copyTextToClipboard(confirmedTxHash);
    if (ok) {
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 1800);
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  const otherOwnAccounts = accounts.filter((a) => a.address !== activeAccount.address);

  return (
    <section className="glass-sheet" aria-label="Send Stellar payment">
      {!embedded && (
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
              seedKey={activeAccount.address}
              kind={activeAccount.kind}
              state={confirmedTxHash ? "zenith" : busy ? "warp" : "shield"}
              size={52}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {confirmedTxHash ? "Transaction Confirmed" : `Send from ${activeAccount.label}`}
              </div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Network: {config.network.toUpperCase()} · Supports G..., M..., Federation &amp; SEP-0007
              </div>
            </div>
          </div>
          <button type="button" className="aw-chip-btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}

      {confirmedTxHash ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0 }}>
          <div className="aw-banner">
            <div style={{ fontWeight: 700, color: "var(--aw-stellar-gold)", marginBottom: 4 }}>
              Confirmed on Stellar {config.network.toUpperCase()}
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>
              Tx Hash: <code>{confirmedTxHash}</code>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="aw-btn-secondary" onClick={handleCopyHash}>
              {copiedHash ? <IconCheck size={15} /> : <IconCopy size={15} />}
              <span>{copiedHash ? "Hash Copied" : "Copy Tx Hash"}</span>
            </button>

            {config.explorerBaseUrl && (
              <a
                href={`${config.explorerBaseUrl.replace(/\/+$/, "")}/tx/${confirmedTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="aw-btn-secondary"
              >
                <span>View on Explorer</span>
                <IconExternalLink size={14} />
              </a>
            )}
          </div>

          <button type="button" className="aw-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : reviewPending ? (
        <div className="aw-review-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Review Stellar Transfer</span>
            <span
              className={`glass-pill ${
                destShieldReport?.verdict === "warning" ? "glass-pill--gold" : "glass-pill--trust"
              }`}
            >
              Shield: {destShieldReport?.verdict.toUpperCase() ?? "PRE-CHECKED"}
            </span>
          </div>

          <div
            className="aw-review-amount tabular-nums"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}
          >
            <TokenBadge
              code={reviewPending.assetCode}
              icon={selectedAssetIcon}
              fallbackIcon={selectedAssetFallbackIcon}
              isNative={!reviewPending.assetIssuer && reviewPending.assetCode.toUpperCase() === "XLM"}
              size={30}
              trustStatus={selectedAssetTrust.status}
            />
            <span>
              {reviewPending.amount} <span>{reviewPending.assetCode}</span>
            </span>
          </div>

          <div className="aw-review-rows">
            <div className="aw-review-row">
              <span>From</span>
              <strong>
                {activeAccount.label} ({activeAccount.address.slice(0, 6)}…
                {activeAccount.address.slice(-4)})
              </strong>
            </div>
            <div className="aw-review-row">
              <span>Destination</span>
              <code style={{ wordBreak: "break-all", textAlign: "right" }}>
                {reviewPending.destination}
              </code>
            </div>
            <div className="aw-review-row">
              <span>Network</span>
              <strong>STELLAR {config.network.toUpperCase()}</strong>
            </div>
            <div className="aw-review-row">
              <span>Memo</span>
              <code>{reviewPending.memoSummary ?? "None"}</code>
            </div>
            <div className="aw-review-row">
              <span>Est. Network Fee</span>
              <code className="tabular-nums">~0.00001 XLM (100 stroops)</code>
            </div>
          </div>

          {destShieldReport?.verdict === "warning" && destShieldReport.findings[0] && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              <strong>{destShieldReport.findings[0].title}:</strong>{" "}
              {destShieldReport.findings[0].description}
            </div>
          )}

          {(() => {
            const gate = requiresHighValueReauth({
              amount: reviewPending.amount,
              assetCode: reviewPending.assetCode,
              spendableBalance: maxSpendableNumber,
              thresholdXlm: config.highValueReauthXlm,
              network: config.network,
              hasWarningVerdict: destShieldReport?.verdict === "warning",
            });
            return gate.required && gate.reason ? (
              <HighValueReauthGate
                reason={gate.reason}
                verified={reauthVerified}
                onVerified={() => setReauthVerified(true)}
              />
            ) : null;
          })()}

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              style={{ flex: "1 1 100px" }}
              disabled={busy}
              onClick={() => {
                setError(null);
                setReauthVerified(false);
                setReviewPending(null);
              }}
            >
              ← Edit
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              style={{ flex: "2 1 160px" }}
              disabled={
                busy ||
                (requiresHighValueReauth({
                  amount: reviewPending.amount,
                  assetCode: reviewPending.assetCode,
                  spendableBalance: maxSpendableNumber,
                  thresholdXlm: config.highValueReauthXlm,
                  network: config.network,
                  hasWarningVerdict: destShieldReport?.verdict === "warning",
                }).required &&
                  !reauthVerified)
              }
              onClick={() => void handleConfirmBroadcast()}
            >
              <IconSend size={15} />
              <span>{busy ? "Signing & Broadcasting..." : "Confirm & Broadcast"}</span>
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0 }}
        >
          {accountState && !accountState.funded && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              This account is not activated on the {config.network.toUpperCase()} ledger yet (needs
              at least 1 XLM) before sending payments.
            </div>
          )}

          {/* Contacts & Own Accounts Quick Pickers */}
          {(contacts.length > 0 || otherOwnAccounts.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6, minWidth: 0 }}>
              <span className="aw-label" style={{ marginBottom: 0 }}>
                Quick Recipients
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {otherOwnAccounts.map((acc) => (
                  <button
                    key={acc.address}
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => setDestination(acc.address)}
                  >
                    Self: {acc.label}
                  </button>
                ))}
                {contacts.slice(0, 6).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => {
                      setDestination(c.address);
                      if (c.defaultMemo) {
                        setMemoKind("text");
                        setMemoValue(c.defaultMemo);
                      }
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Destination + QR Scanner + Federation Resolver */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <label className="aw-label" htmlFor="send-dest-input" style={{ marginBottom: 0 }}>
                Destination (G..., M..., C..., user*domain, or SEP-0007 URI)
              </label>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setQrMessage(null);
                  setQrOpen((v) => !v);
                }}
              >
                {qrOpen ? <IconClose size={13} /> : <IconQr size={13} />}
                <span>{qrOpen ? "Close Scanner" : "Scan QR"}</span>
              </button>
            </div>

            <input
              id="send-dest-input"
              type="text"
              className="aw-input"
              placeholder="G..., M..., name*domain.com, or web+stellar:pay?..."
              value={destination}
              onChange={(e) => applyIncomingUriOrAddress(e.target.value)}
            />

            {destination.trim() === activeAccount.address && (
              <div className="aw-banner" style={{ marginTop: 6, padding: "8px 12px", fontSize: 12 }}>
                Self-transfer: destination matches your currently active account.
              </div>
            )}

            {destination.includes("*") && (
              <button
                type="button"
                className="aw-chip-btn"
                style={{ marginTop: 6 }}
                disabled={resolvingFed}
                onClick={() => void handleResolveFederation()}
              >
                {resolvingFed ? "Resolving Federation..." : "Resolve SEP-0002 Federation Address"}
              </button>
            )}

            {qrOpen && (
              <div className="aw-banner" style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {qrMessage ? (
                  <div style={{ fontSize: 12 }}>{qrMessage}</div>
                ) : (
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    style={{
                      width: "100%",
                      maxHeight: 200,
                      borderRadius: 12,
                      background: "#060E24",
                      objectFit: "cover",
                    }}
                  />
                )}
              </div>
            )}

            {/* Pre-Send Scan & Shield live feedback */}
            {scanningDest && (
              <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", marginTop: 6 }}>
                Running Scan &amp; Shield check on destination...
              </div>
            )}

            {destShieldReport && (
              <div
                className={
                  destShieldReport.verdict === "malicious"
                    ? "aw-banner aw-banner--danger"
                    : destShieldReport.requiresMemoCheck || destShieldReport.verdict === "warning"
                      ? "aw-banner aw-banner--warn"
                      : "aw-banner"
                }
                style={{ marginTop: 8, padding: "9px 12px", fontSize: 12 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
                  <IconShield size={14} />
                  <span>Scan &amp; Shield: {destShieldReport.verdict.toUpperCase()}</span>
                </div>
                {destShieldReport.requiresMemoCheck && (
                  <div style={{ marginTop: 3, color: "var(--aw-stellar-gold)" }}>
                    Exchange destination requires a SEP-29 Deposit Memo.
                  </div>
                )}
                {destShieldReport.findings[0] && (
                  <div style={{ marginTop: 3 }}>{destShieldReport.findings[0].description}</div>
                )}
              </div>
            )}
          </div>

          {/* Asset Selector & Amount */}
          <div className="aw-two-col-inputs">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <TokenBadge
                  code={selectedBalance.assetCode}
                  icon={selectedAssetIcon}
                  fallbackIcon={selectedAssetFallbackIcon}
                  isNative={isSelectedNative}
                  size={20}
                  trustStatus={selectedAssetTrust.status}
                />
                <label className="aw-label" htmlFor="send-asset-select" style={{ marginBottom: 0 }}>
                  Asset to Send
                </label>
              </div>
              <select
                id="send-asset-select"
                className="aw-input"
                value={selectedAssetKey}
                onChange={(e) => setSelectedAssetKey(e.target.value)}
              >
                {availableAssets.map((b) => {
                  const key = assetKeyOf(b.assetCode, b.assetIssuer);
                  return (
                    <option key={key} value={key}>
                      {b.assetCode} ({Number(b.balance).toFixed(2)} avail)
                    </option>
                  );
                })}
              </select>
            </div>

            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <label className="aw-label" htmlFor="send-amount-input" style={{ marginBottom: 0 }}>
                  Amount ({selectedBalance.assetCode})
                </label>
                <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Spendable: {formatTruncatedAmount(maxSpendableNumber)}
                </span>
              </div>
              <input
                id="send-amount-input"
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                placeholder="10.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          {/* Quick Percentage Chips */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="aw-chip-btn" onClick={() => applyPercentage(0.25)}>
              25%
            </button>
            <button type="button" className="aw-chip-btn" onClick={() => applyPercentage(0.5)}>
              50%
            </button>
            <button type="button" className="aw-chip-btn" onClick={() => applyPercentage(1)}>
              MAX
            </button>
          </div>

          {/* Memo Controls */}
          <div className="aw-memo-grid">
            <div>
              <label className="aw-label" htmlFor="send-memo-kind">
                Memo Type
              </label>
              <select
                id="send-memo-kind"
                className="aw-input"
                value={memoKind}
                onChange={(e) => setMemoKind(e.target.value as MemoKind)}
              >
                <option value="text">Text</option>
                <option value="id">ID (u64)</option>
                <option value="hash">Hash (Hex)</option>
                <option value="return">Return (Hex)</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="send-memo-input">
                Memo Value {destShieldReport?.requiresMemoCheck ? "(Required)" : "(Optional)"}
              </label>
              <input
                id="send-memo-input"
                type="text"
                className="aw-input"
                disabled={memoKind === "none"}
                placeholder={
                  memoKind === "id"
                    ? "Numeric uint64 memo"
                    : memoKind === "hash" || memoKind === "return"
                      ? "64-char hex digest"
                      : "Max 28 UTF-8 bytes"
                }
                value={memoValue}
                onChange={(e) => setMemoValue(e.target.value)}
              />
            </div>
          </div>

          {/* Optional Save to Contacts */}
          <div className="aw-list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={saveAsContact}
                onChange={(e) => setSaveAsContact(e.target.checked)}
              />
              <IconUserPlus size={14} />
              <span>Save recipient to local Contacts book</span>
            </label>
            {saveAsContact && (
              <input
                type="text"
                className="aw-input"
                placeholder="Contact label (e.g. Alice Treasury)"
                maxLength={40}
                value={contactLabel}
                onChange={(e) => setContactLabel(e.target.value)}
              />
            )}
          </div>

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="aw-btn-primary"
            disabled={busy || destShieldReport?.verdict === "malicious"}
          >
            Review Transfer →
          </button>
        </form>
      )}
    </section>
  );
}
