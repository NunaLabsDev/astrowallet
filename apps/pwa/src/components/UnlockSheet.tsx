import { useEffect, useState, type FormEvent } from "react";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { IconFingerprint, IconGlobe, IconLock } from "./Icons.js";

const PIN_COOLDOWN_SECONDS = [5, 15, 30, 60] as const;

export function UnlockSheet({
  onExploreSite,
}: {
  onExploreSite?: (() => void) | undefined;
}) {
  const {
    config,
    unlockWithPin,
    unlockWithBiometric,
    fingerprintSupported,
    fingerprintEnrolled,
  } = useWallet();

  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntilMs, setCooldownUntilMs] = useState(0);
  const [remainingSec, setRemainingSec] = useState(0);

  useEffect(() => {
    if (cooldownUntilMs <= Date.now()) {
      setRemainingSec(0);
      return undefined;
    }
    const tick = () => {
      const rem = Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000));
      setRemainingSec(rem);
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [cooldownUntilMs]);

  const handlePinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || remainingSec > 0) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithPin(pin);
      setPin("");
      setFailedAttempts(0);
      setCooldownUntilMs(0);
      setRemainingSec(0);
    } catch (err) {
      const nextFails = failedAttempts + 1;
      setFailedAttempts(nextFails);
      if (nextFails >= 3) {
        const idx = Math.min(nextFails - 3, PIN_COOLDOWN_SECONDS.length - 1);
        const sec = PIN_COOLDOWN_SECONDS[idx] ?? 60;
        setCooldownUntilMs(Date.now() + sec * 1000);
        setRemainingSec(sec);
        setError(`Too many failed PIN attempts. Wait ${sec}s before retrying.`);
      } else {
        setError(err instanceof Error ? err.message : "Invalid PIN or passphrase");
      }
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
    <section className="glass-sheet glass-card--vault aw-unlock-card" aria-label="Unlock AstroWallet">
      <div className="aw-unlock-hero">
        <div className="aw-pixel-frame">
          <AstroNavigatorAvatar seedKey="locked-vault" kind="classic" state="vault" size={84} />
        </div>
        <span className="glass-pill glass-pill--trust">
          Argon2id + AES-GCM-256 · {config.network.toUpperCase()}
        </span>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Vault Locked
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--aw-ink-secondary)" }}>
          Decrypt locally with your PIN/passphrase or enrolled Fingerprint
        </p>
      </div>

      <form onSubmit={handlePinSubmit} style={{ display: "grid", gap: 12, marginTop: 18 }}>
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
            disabled={busy || pin.length < 6 || remainingSec > 0}
          >
            <IconLock size={16} />
            <span>
              {busy
                ? "Decrypting..."
                : remainingSec > 0
                  ? `Wait ${remainingSec}s`
                  : "Unlock with PIN"}
            </span>
          </button>

          {fingerprintSupported && fingerprintEnrolled && (
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={busy}
              onClick={handleFingerprint}
            >
              <IconFingerprint size={16} />
              <span>Use Fingerprint</span>
            </button>
          )}
        </div>
      </form>

      {onExploreSite && (
        <div className="aw-unlock-footer">
          <button type="button" className="aw-chip-btn" onClick={onExploreSite}>
            <IconGlobe size={14} />
            <span>Explore AstroWallet Overview</span>
          </button>
        </div>
      )}
    </section>
  );
}
