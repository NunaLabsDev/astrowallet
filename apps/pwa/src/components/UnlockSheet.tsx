import { useEffect, useState, type FormEvent } from "react";
import {
  clearPinLockoutState,
  getPinLockoutState,
  recordFailedPinAttempt,
} from "@astrowallet/stellar-core";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { IconFingerprint, IconLock, IconTrash } from "./Icons.js";

export function UnlockSheet() {
  const { hasEncryptedBackup, backupUpdatedAt } = useTelegram();
  const {
    config,
    storageScopeId,
    localVaultUpdatedAt,
    unlockWithPin,
    unlockWithBiometric,
    wipeLocalVault,
    fingerprintSupported,
    fingerprintEnrolled,
  } = useWallet();

  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntilMs, setCooldownUntilMs] = useState(0);
  const [remainingSec, setRemainingSec] = useState(0);
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPinLockoutState(storageScopeId).then((state) => {
      if (cancelled) return;
      setCooldownUntilMs(state.lockedUntilMs);
    });
    return () => {
      cancelled = true;
    };
  }, [storageScopeId]);

  useEffect(() => {
    if (cooldownUntilMs <= Date.now()) {
      setRemainingSec(0);
      return undefined;
    }
    const tick = () => {
      const rem = Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000));
      setRemainingSec(rem);
      if (rem === 0) {
        window.clearInterval(id);
      }
    };
    const id = window.setInterval(tick, 500);
    tick();
    return () => window.clearInterval(id);
  }, [cooldownUntilMs]);

  const handlePinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || remainingSec > 0) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithPin(pin);
      await clearPinLockoutState(storageScopeId);
      setPin("");
      setCooldownUntilMs(0);
      setRemainingSec(0);
    } catch (err) {
      const nextState = await recordFailedPinAttempt(Date.now(), storageScopeId);
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
      await clearPinLockoutState(storageScopeId);
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

      {hasEncryptedBackup &&
        backupUpdatedAt !== null &&
        localVaultUpdatedAt !== null &&
        backupUpdatedAt > localVaultUpdatedAt + 5 && (
          <div className="aw-banner" style={{ fontSize: 12, marginTop: 12 }}>
            A newer Telegram Encrypted Backup was detected from another device. If your password
            changed, reset this device&apos;s local copy below to pull the latest backup.
          </div>
        )}

      <form onSubmit={handlePinSubmit} style={{ display: "grid", gap: 12, marginTop: 18 }}>
        <div>
          <label className="aw-label" htmlFor="unlock-pin-input">
            PIN or Passphrase
          </label>
          <div className="aw-input-row">
            <input
              id="unlock-pin-input"
              type={showPin ? "text" : "password"}
              className="aw-input"
              autoComplete="current-password"
              placeholder="Enter your PIN or passphrase"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button
              type="button"
              className="aw-chip-btn"
              onClick={() => setShowPin((v) => !v)}
            >
              {showPin ? "Hide" : "Show"}
            </button>
          </div>
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

      <div className="aw-unlock-footer" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        {!resetArmed ? (
          <button
            type="button"
            className="aw-chip-btn"
            style={{ alignSelf: "center" }}
            onClick={() => setResetArmed(true)}
          >
            Forgot PIN? Reset / Restore Wallet
          </button>
        ) : (
          <div className="aw-banner aw-banner--danger" style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12 }}>
              <strong>Reset Local Device Vault?</strong> This erases only the local encrypted vault
              from this device&apos;s IndexedDB (your Telegram Encrypted Backup stays safe). You can
              restore anytime using your Recovery Password, 12/24-word phrase, or{" "}
              <code>.agvault.json</code> backup.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="aw-btn-danger"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => {
                  setResetArmed(false);
                  void wipeLocalVault();
                }}
              >
                <IconTrash size={14} />
                <span>Confirm Reset Vault</span>
              </button>
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => setResetArmed(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
