import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useWallet } from "../state/wallet-context.js";

export function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { activeAccount, config } = useWallet();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!activeAccount) return;

    QRCode.toDataURL(activeAccount.address, {
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
  }, [activeAccount]);

  if (!activeAccount) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeAccount.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <section className="glass-sheet" aria-label="Receive Stellar assets">
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
            Classic Account (G...) • {config.network.toUpperCase()}
          </div>
        </div>
        <button type="button" className="aw-chip-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          textAlign: "center",
        }}
      >
        {qrDataUrl && (
          <div className="aw-qr-frame">
            <img
              src={qrDataUrl}
              width={180}
              height={180}
              alt={`QR code for ${activeAccount.address}`}
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
          }}
        >
          <code>{activeAccount.address}</code>
        </div>

        <button
          type="button"
          className="aw-btn-primary"
          style={{ width: "100%" }}
          onClick={handleCopy}
        >
          {copied ? "Address Copied!" : "Copy Stellar Public Address"}
        </button>
      </div>
    </section>
  );
}
