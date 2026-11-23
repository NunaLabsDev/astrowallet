import { useState } from "react";
import { useWallet } from "../state/wallet-context.js";
import { triggerTelegramHaptic } from "../telegram/webapp.js";
import { IconShield } from "./Icons.js";

export interface HighValueReauthGateProps {
  reason: string;
  verified: boolean;
  onVerified: () => void;
}

/**
 * Inline PIN / biometric confirmation gate shown before signing high-value
 * or Mainnet-warning transactions. Uses >=16px inputs to prevent mobile iOS zoom.
 */
export function HighValueReauthGate({
  reason,
  verified,
  onVerified,
}: HighValueReauthGateProps) {
  const {
    fingerprintEnrolled,
    telegramBioAvailable,
    verifyPinOrPassphrase,
    verifyBiometricReauth,
  } = useWallet();

  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (verified) {
    return (
      <div className="aw-banner" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
        <IconShield size={14} />
        <span>Re-authentication verified for this transaction.</span>
      </div>
    );
  }

  const handlePinVerify = async () => {
    if (!pin.trim()) {
      setError("Enter your vault PIN or passphrase to confirm.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyPinOrPassphrase(pin);
      setPin("");
      triggerTelegramHaptic("success");
      onVerified();
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Invalid PIN or passphrase");
    } finally {
      setBusy(false);
    }
  };

  const handleBiometricVerify = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyBiometricReauth(reason);
      triggerTelegramHaptic("success");
      onVerified();
    } catch (err) {
      triggerTelegramHaptic("error");
      setError(err instanceof Error ? err.message : "Biometric verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="aw-banner aw-banner--warn"
      style={{ display: "grid", gap: 8, fontSize: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
        <IconShield size={14} />
        <span>Security Re-Auth Required</span>
      </div>
      <div>{reason}</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="password"
          className="aw-input"
          placeholder="Vault PIN / Passphrase"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          style={{ flex: "1 1 160px", fontSize: 16 }}
          autoComplete="current-password"
        />
        <button
          type="button"
          className="aw-btn-secondary"
          disabled={busy || !pin.trim()}
          onClick={() => void handlePinVerify()}
        >
          {busy ? "Checking..." : "Verify PIN"}
        </button>
      </div>

      {(fingerprintEnrolled || telegramBioAvailable) && (
        <button
          type="button"
          className="aw-chip-btn"
          disabled={busy}
          onClick={() => void handleBiometricVerify()}
        >
          Verify with Biometrics
        </button>
      )}

      {error && (
        <div className="aw-banner aw-banner--danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
