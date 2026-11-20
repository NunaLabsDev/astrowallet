import { useEffect, useState, type FormEvent } from "react";
import {
  clearPinLockoutState,
  getPinLockoutState,
  recordFailedPinAttempt,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { IconFingerprint, IconLock } from "./Icons.js";

export function UnlockSheet() {
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
  const [cooldownUntilMs, setCooldownUntilMs] = useState(0);
  const [remainingSec, setRemainingSec] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getPinLockoutState().then((state) => {
      if (cancelled) return;
      setCooldownUntilMs(state.lockedUntilMs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      await clearPinLockoutState();
      setPin("");
      setCooldownUntilMs(0);
      setRemainingSec(0);
    } catch (err) {
      const nextState = await recordFailedPinAttempt();
      if (nextState.lockedUntilMs > Date.now()) {
        const sec = Math.max(1, Math.ceil((nextState.lockedUntilMs - Date.now()) / 1000));
        setCooldownUntilMs(nextState.lockedUntilMs);
        setRemainingSec(sec);
        setError(`Too many failed PIN attempts. Wait ${sec}s before retrying.`);
      } else {
        const baseMsg = err instanceof Error ? err.message : "Invalid PIN or passphrase";
        setError(`${baseMsg} (${nextState.failedAttempts}/5 attempts before lockout)`);
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
      await clearPinLockoutState();
      setCooldownUntilMs(0);
      setRemainingSec(0);
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
              <span>Use Biometrics</span>
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
