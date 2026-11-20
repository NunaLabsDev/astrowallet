export function IosBrowserGuard({
  isIntentRoute,
  uninitialized,
}: {
  isIntentRoute: boolean;
  uninitialized: boolean;
}) {
  if (!uninitialized && !isIntentRoute) {
    return null;
  }

  return (
    <section
      className="aw-banner aw-banner--warn"
      aria-label="Telegram Mini App vault backup reminder"
    >
      <div style={{ fontWeight: 700, color: "var(--aw-stellar-gold)", marginBottom: 4 }}>
        Telegram Mini App Local Custody Reminder
      </div>
      <div style={{ fontSize: 12 }}>
        Your encrypted vault lives strictly on this device (never on Telegram servers or{" "}
        <code>CloudStorage</code>). Clearing Telegram&apos;s app cache removes local WebView storage,
        so back up your 12-word phrase or export an encrypted <code>.agvault.json</code> file.
      </div>
    </section>
  );
}
