import { useState } from "react";

function detectIosSafariNotInstalled(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  if (!isIos) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const isStandalone =
    Boolean(nav.standalone) || window.matchMedia("(display-mode: standalone)").matches;
  return !isStandalone;
}

function detectEmbeddedInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Telegram|FBAN|FBAV|Instagram|Line|Wv|WebView/i.test(ua);
}

export function IosBrowserGuard({
  isIntentRoute,
  uninitialized,
}: {
  isIntentRoute: boolean;
  uninitialized: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const iosNotStandalone = detectIosSafariNotInstalled();
  const inAppWebView = detectEmbeddedInAppBrowser();

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  if (isIntentRoute && (inAppWebView || iosNotStandalone)) {
    return (
      <section className="aw-banner aw-banner--warn" aria-label="Browser environment notice">
        <div style={{ fontWeight: 700, color: "var(--aw-stellar-gold)", marginBottom: 4 }}>
          Universal PIN or External Browser
        </div>
        <div>
          You can <strong>Confirm with PIN now</strong> directly here, or open this link in{" "}
          <strong>Safari / Chrome</strong> to use your installed Home Screen vault and
          Fingerprint quick-unlock.
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="aw-chip-btn" onClick={handleCopyUrl}>
            {copied ? "Intent Link Copied!" : "Copy Link for Safari / Chrome"}
          </button>
        </div>
      </section>
    );
  }

  if (uninitialized && iosNotStandalone) {
    return (
      <section className="aw-banner" aria-label="iOS Home Screen installation notice">
        <div style={{ fontWeight: 700, color: "var(--aw-stellar-gold)", marginBottom: 4 }}>
          iOS Tip: Add to Home Screen First
        </div>
        <div>
          iOS isolates <code>IndexedDB</code> storage between Safari tabs and installed Home
          Screen apps. Tap <strong>Share → Add to Home Screen</strong> before creating your
          seed vault, or export an encrypted <code>.agvault.json</code> backup after setup.
        </div>
      </section>
    );
  }

  return null;
}
