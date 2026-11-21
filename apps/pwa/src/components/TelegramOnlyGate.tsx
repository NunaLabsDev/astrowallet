import type { PwaConfig } from "@astrowallet/domain";
import { buildTelegramMiniAppLink } from "@astrowallet/tg-protocol";
import type { TelegramAuthStatus } from "../telegram/webapp.js";
import { AstroWalletLogo } from "./AstroWalletLogo.js";
import { IconExternalLink, IconLock, IconTelegram } from "./Icons.js";
import { parseIntentRouteFromLocation } from "./IntentSheet.js";

export function TelegramOnlyGate({
  config,
  authStatus,
  authError,
  onRetry,
}: {
  config: PwaConfig;
  authStatus: TelegramAuthStatus;
  authError: string | null;
  onRetry?: () => void;
}) {
  const intentRoute = parseIntentRouteFromLocation();
  const miniAppUrl = buildTelegramMiniAppLink({
    botUsername: config.tgBotUsername,
    shortName: config.tgMiniAppShortName,
    pwaOrigin: config.pwaOrigin,
    intentId: intentRoute?.intentId,
    sig: intentRoute?.sig,
  });

  return (
    <main className="glass-canvas">
      <div className="aw-shell aw-center-stage" style={{ marginTop: 24 }}>
        <section
          className="glass-sheet glass-card--vault"
          aria-label="Open AstroWallet Inside Telegram"
          style={{ display: "grid", gap: 16, textAlign: "center" }}
        >
          <div style={{ display: "flex", justifyContent: "center" }}>
            <AstroWalletLogo size={54} />
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <span className="glass-pill glass-pill--trust" style={{ margin: "0 auto" }}>
              Telegram-Exclusive Multichain Mini App · {config.network.toUpperCase()}
            </span>
            <h1 style={{ margin: "6px 0 0", fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {authStatus === "checking"
                ? "Verifying Telegram Session..."
                : authStatus === "error"
                  ? "Telegram Session Verification Failed"
                  : "Launch Inside Telegram"}
            </h1>
            <p style={{ margin: 0, fontSize: 13, color: "var(--aw-ink-secondary)", lineHeight: 1.5 }}>
              {authStatus === "checking"
                ? "Validating your cryptographic Telegram initData before unlocking the vault."
                : authStatus === "error"
                  ? "Reopen this Mini App directly from Telegram so your fresh session signature can be verified."
                  : "AstroWallet runs exclusively as a non-custodial Stellar & TON wallet inside Telegram—never on open browser tabs."}
            </p>
          </div>

          {authError && (
            <div className="aw-banner aw-banner--danger" style={{ fontSize: 12, textAlign: "left" }}>
              {authError}
            </div>
          )}

          {authStatus !== "checking" && (
            <div style={{ display: "grid", gap: 10 }}>
              <a
                href={miniAppUrl}
                className="aw-btn-primary"
                style={{ textDecoration: "none", justifyContent: "center" }}
              >
                <IconTelegram size={17} />
                <span>Open @{config.tgBotUsername} Mini App</span>
                <IconExternalLink size={14} />
              </a>

              {authStatus === "error" && onRetry && (
                <button type="button" className="aw-btn-secondary" onClick={onRetry}>
                  <IconLock size={15} />
                  <span>Retry Verification</span>
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
