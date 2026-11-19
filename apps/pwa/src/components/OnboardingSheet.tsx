import { useState, type FormEvent } from "react";
import { generateMnemonicPhrase, validateMnemonicPhrase } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

type OnboardingMode = "create" | "import" | "restore_agvault";

export function OnboardingSheet() {
  const { createOrImportVault, restoreAgVaultJson } = useWallet();

  const [mode, setMode] = useState<OnboardingMode>("create");
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string>(() =>
    generateMnemonicPhrase(128),
  );
  const [importMnemonic, setImportMnemonic] = useState<string>("");
  const [agVaultJson, setAgVaultJson] = useState<string>("");
  const [accountLabel, setAccountLabel] = useState<string>("Primary");
  const [pin, setPin] = useState<string>("");
  const [confirmPin, setConfirmPin] = useState<string>("");
  const [confirmedBackup, setConfirmedBackup] = useState<boolean>(false);
  const [copiedSeed, setCopiedSeed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegenerate = () => {
    setGeneratedMnemonic(generateMnemonicPhrase(128));
    setConfirmedBackup(false);
    setCopiedSeed(false);
  };

  const handleCopySeed = async () => {
    try {
      await navigator.clipboard.writeText(generatedMnemonic);
      setCopiedSeed(true);
      setTimeout(() => setCopiedSeed(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (pin.length < 6) {
      setError("PIN or passphrase must be at least 6 characters.");
      return;
    }

    if (mode !== "restore_agvault" && pin !== confirmPin) {
      setError("PIN confirmation does not match.");
      return;
    }

    if (mode === "create" && !confirmedBackup) {
      setError("Confirm that you have written down your 12-word recovery phrase.");
      return;
    }

    if (mode === "import" && !validateMnemonicPhrase(importMnemonic)) {
      setError("Invalid BIP-39 12/24-word recovery phrase.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "restore_agvault") {
        await restoreAgVaultJson(agVaultJson, pin);
      } else {
        const phrase = mode === "create" ? generatedMnemonic : importMnemonic;
        await createOrImportVault(phrase, pin, accountLabel);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize encrypted vault");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-sheet glass-card--vault" aria-label="Setup non-custodial wallet">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
        <div className="aw-pixel-frame">
          <AstroNavigatorAvatar seedKey="onboarding-vault" kind="classic" state="vault" size={62} />
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Create Sovereign Stellar Vault</div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            SEP-0005 non-custodial custody • Local Argon2id + AES-GCM-256 • Zero server keys
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={mode === "create"}
          onClick={() => {
            setMode("create");
            setError(null);
          }}
        >
          New 12-Word Seed
        </button>
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={mode === "import"}
          onClick={() => {
            setMode("import");
            setError(null);
          }}
        >
          Import Seed
        </button>
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={mode === "restore_agvault"}
          onClick={() => {
            setMode("restore_agvault");
            setError(null);
          }}
        >
          Restore .agvault
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        {mode === "create" && (
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span className="aw-label" style={{ marginBottom: 0 }}>
                Your 12-Word SEP-0005 Recovery Phrase
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="aw-chip-btn" onClick={handleCopySeed}>
                  {copiedSeed ? "Copied" : "Copy"}
                </button>
                <button type="button" className="aw-chip-btn" onClick={handleRegenerate}>
                  New
                </button>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                padding: 12,
                borderRadius: 16,
                background: "rgba(11, 20, 51, 0.72)",
                border: "1px solid rgba(165, 139, 224, 0.28)",
                fontSize: 12,
              }}
            >
              {generatedMnemonic.split(" ").map((word, idx) => (
                <div key={`${idx}-${word}`}>
                  <span style={{ color: "var(--aw-nebula-lavender)" }}>{idx + 1}.</span> {word}
                </div>
              ))}
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                marginTop: 10,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={confirmedBackup}
                onChange={(e) => setConfirmedBackup(e.target.checked)}
              />
              <span>I saved this recovery phrase offline (never stored on servers).</span>
            </label>
          </div>
        )}

        {mode === "import" && (
          <div>
            <label className="aw-label" htmlFor="import-seed-input">
              Enter 12 or 24-Word SEP-0005 Seed Phrase (LOBSTR / Varial / Ledger compatible)
            </label>
            <textarea
              id="import-seed-input"
              className="aw-textarea"
              rows={3}
              placeholder="word1 word2 word3 ..."
              value={importMnemonic}
              onChange={(e) => setImportMnemonic(e.target.value)}
            />
          </div>
        )}

        {mode === "restore_agvault" && (
          <div>
            <label className="aw-label" htmlFor="restore-agvault-input">
              Paste Encrypted AGVAULT JSON Bundle
            </label>
            <textarea
              id="restore-agvault-input"
              className="aw-textarea"
              rows={4}
              placeholder='{"version":1,"format":"AGVAULT",...}'
              value={agVaultJson}
              onChange={(e) => setAgVaultJson(e.target.value)}
            />
          </div>
        )}

        {mode !== "restore_agvault" && (
          <div>
            <label className="aw-label" htmlFor="account-label-input">
              First Account Label (m/44&apos;/148&apos;/0&apos;)
            </label>
            <input
              id="account-label-input"
              type="text"
              className="aw-input"
              maxLength={32}
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
            />
          </div>
        )}

        <div>
          <label className="aw-label" htmlFor="vault-pin-input">
            {mode === "restore_agvault"
              ? "Vault PIN / Passphrase"
              : "Create Vault PIN or Passphrase (min 6 chars — Argon2id encrypted)"}
          </label>
          <input
            id="vault-pin-input"
            type="password"
            className="aw-input"
            autoComplete="new-password"
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>

        {mode !== "restore_agvault" && (
          <div>
            <label className="aw-label" htmlFor="vault-pin-confirm">
              Confirm PIN / Passphrase
            </label>
            <input
              id="vault-pin-confirm"
              type="password"
              className="aw-input"
              autoComplete="new-password"
              placeholder="••••••"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
            />
          </div>
        )}

        {error && (
          <div className="aw-banner aw-banner--danger" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="aw-btn-primary" disabled={busy}>
          {busy
            ? "Encrypting Vault with Argon2id..."
            : mode === "restore_agvault"
              ? "Decrypt & Restore Vault"
              : "Encrypt & Unlock AstroWallet"}
        </button>
      </form>
    </section>
  );
}
