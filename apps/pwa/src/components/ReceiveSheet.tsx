import { useEffect, useMemo, useState } from "react";
import type { ClassicAddress } from "@astrowallet/domain";
import { buildSep7PayUri, encodeMuxedAddress } from "@astrowallet/stellar-core";
import QRCode from "qrcode";
import { useWallet } from "../state/wallet-context.js";
import { IconCheck, IconCopy, IconExternalLink } from "./Icons.js";

type ReceiveMode = "standard" | "sep7" | "muxed";

export function ReceiveSheet({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  embedded?: boolean | undefined;
}) {
  const { activeAccount, config, showToast } = useWallet();

  const [mode, setMode] = useState<ReceiveMode>("standard");
  const [reqAmount, setReqAmount] = useState("25");
  const [reqMemo, setReqMemo] = useState("");
  const [muxedId, setMuxedId] = useState("1001");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const muxedResult = useMemo(() => {
    if (!activeAccount || mode !== "muxed") return { value: null, error: null };
    try {
      const encoded = encodeMuxedAddress(activeAccount.address as ClassicAddress, muxedId);
      return { value: encoded, error: null };
    } catch (err) {
      return {
        value: null,
        error: err instanceof Error ? err.message : "Invalid muxed uint64 ID",
      };
    }
  }, [activeAccount, mode, muxedId]);

  const activePayload = useMemo(() => {
    if (!activeAccount) return "";
    if (mode === "standard") {
      return activeAccount.address;
    }
    if (mode === "muxed") {
      return muxedResult.value ?? activeAccount.address;
    }
    return buildSep7PayUri({
      destination: activeAccount.address,
      amount: reqAmount.trim() || undefined,
      memo: reqMemo.trim() || undefined,
      memoType: reqMemo.trim() ? "MEMO_TEXT" : undefined,
      msg: `Pay ${activeAccount.label} (${config.network.toUpperCase()})`,
    });
  }, [activeAccount, mode, muxedResult.value, reqAmount, reqMemo, config.network]);

  useEffect(() => {
    let cancelled = false;
    if (!activePayload) return;

    QRCode.toDataURL(activePayload, {
      width: 220,
      margin: 1,
      color: {
        dark: "#172C69",
        light: "#F8FAFF",
      },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activePayload]);

  if (!activeAccount) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activePayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleShare = async () => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `AstroWallet ${activeAccount.label}`,
          text: activePayload,
        });
        return;
      } catch {
        // Fall through to copy on dismiss
      }
    }
    await handleCopy();
    showToast("Payment details copied to clipboard", "info");
  };

  return (
    <section className="glass-sheet" aria-label="Receive Stellar assets">
      {!embedded && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Receive to {activeAccount.label}
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Classic Account (G...) · {config.network.toUpperCase()}
            </div>
          </div>
          <button type="button" className="aw-chip-btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="aw-chip-btn"
            aria-pressed={mode === "standard"}
            onClick={() => setMode("standard")}
          >
            Standard G...
          </button>
          <button
            type="button"
            className="aw-chip-btn"
            aria-pressed={mode === "sep7"}
            onClick={() => setMode("sep7")}
          >
            Payment Request (SEP-0007)
          </button>
          <button
            type="button"
            className="aw-chip-btn"
            aria-pressed={mode === "muxed"}
            onClick={() => setMode("muxed")}
          >
            Muxed M... (CAP-27)
          </button>
        </div>

        {mode === "sep7" && (
          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="recv-sep7-amount">
                Requested XLM Amount (Optional)
              </label>
              <input
                id="recv-sep7-amount"
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                placeholder="25"
                value={reqAmount}
                onChange={(e) => setReqAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="aw-label" htmlFor="recv-sep7-memo">
                Memo (Optional, max 28 bytes)
              </label>
              <input
                id="recv-sep7-memo"
                type="text"
                className="aw-input"
                maxLength={28}
                placeholder="Order #402"
                value={reqMemo}
                onChange={(e) => setReqMemo(e.target.value)}
              />
            </div>
          </div>
        )}

        {mode === "muxed" && (
          <div>
            <label className="aw-label" htmlFor="recv-muxed-id">
              Unsigned 64-bit Sub-Account / Invoice ID
            </label>
            <input
              id="recv-muxed-id"
              type="text"
              inputMode="numeric"
              className="aw-input tabular-nums"
              value={muxedId}
              onChange={(e) => setMuxedId(e.target.value)}
            />
            {muxedResult.error && (
              <div className="aw-banner aw-banner--danger" style={{ marginTop: 8 }}>
                {muxedResult.error}
              </div>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            textAlign: "center",
          }}
        >
          {qrDataUrl && (
            <div className="aw-qr-frame">
              <img
                src={qrDataUrl}
                width={184}
                height={184}
                alt={`QR code for ${mode}`}
                style={{ display: "block", borderRadius: 12 }}
              />
            </div>
          )}

          <div
            style={{
              padding: 12,
              borderRadius: 14,
              background: "rgba(11, 20, 51, 0.72)",
              border: "1px solid rgba(165, 139, 224, 0.25)",
              fontSize: 12,
              wordBreak: "break-all",
              width: "100%",
              textAlign: "left",
            }}
          >
            <code>{activePayload}</code>
          </div>

          <div style={{ display: "flex", gap: 8, width: "100%", flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-primary"
              style={{ flex: 1 }}
              onClick={() => void handleCopy()}
            >
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
              <span>
                {copied
                  ? "Copied!"
                  : mode === "sep7"
                    ? "Copy SEP-0007 URI"
                    : mode === "muxed"
                      ? "Copy M... Address"
                      : "Copy Public G... Address"}
              </span>
            </button>

            <button
              type="button"
              className="aw-btn-secondary"
              onClick={() => void handleShare()}
            >
              <IconExternalLink size={15} />
              <span>Share</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
