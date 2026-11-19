import { useState, type FormEvent } from "react";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function UnlockSheet() {
  const {
    unlockWithPin,
    unlockWithBiometric,
    fingerprintSupported,
    fingerprintEnrolled,
  } = useWallet();

  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithPin(pin);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid PIN or passphrase");
    } finally {
      setBusy(false);
    }
  };

  const handleFingerprint = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlockWithBiometric();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Fingerprint unlock cancelled; enter your PIN below",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-sheet" aria-label="Unlock AstroWallet">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
        <AstroNavigatorAvatar seedKey="locked-vault" kind="classic" state="vault" size={64} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Vault Locked</div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Unlock with your PIN/passphrase or enrolled Fingerprint
          </div>
        </div>
      </div>

      <form onSubmit={handlePinSubmit} style={{ display: "grid", gap: 12 }}>
        <div>
          <label className="aw-label" htmlFor="unlock-pin-input">
            PIN or Passphrase
          </label>
          <input
            id="unlock-pin-input"
            type="password"
            className="aw-input"
            autoComplete="current-password"
            placeholder="Enter your PIN or passphrase"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>

        {error && (
          <div className="aw-banner aw-banner--danger" role="alert">
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="submit"
            className="aw-btn-primary"
            style={{ flex: 1 }}
            disabled={busy || pin.length < 4}
          >
            {busy ? "Decrypting..." : "Unlock with PIN"}
          </button>

          {fingerprintSupported && fingerprintEnrolled && (
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={busy}
              onClick={handleFingerprint}
            >
              Use Fingerprint
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
