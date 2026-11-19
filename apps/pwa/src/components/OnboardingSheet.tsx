import { useState, type FormEvent } from "react";
import { generateMnemonicPhrase, validateMnemonicPhrase } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import {
  IconCheck,
  IconCopy,
  IconKey,
  IconLock,
  IconRefresh,
  IconShield,
  IconSparkles,
} from "./Icons.js";

type OnboardingMode = "create" | "import" | "restore_agvault";

export function OnboardingSheet() {
  const { config, createOrImportVault, restoreAgVaultJson } = useWallet();

  const [mode, setMode] = useState<OnboardingMode>("create");
  const [createStep, setCreateStep] = useState<1 | 2>(1);
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

  const handleAdvanceToPin = () => {
    setError(null);
    if (!confirmedBackup) {
      setError("Please confirm that you saved your 12-word recovery phrase offline.");
      return;
    }
    setCreateStep(2);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "create" && createStep === 1) {
      handleAdvanceToPin();
      return;
    }

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

  const words = generatedMnemonic.split(" ");

  return (
    <section
      className="glass-sheet glass-card--vault aw-onboarding-card"
      aria-label="Setup non-custodial wallet"
    >
      <div className="aw-onboarding-head">
        <div className="aw-pixel-frame">
          <AstroNavigatorAvatar
            seedKey="onboarding-vault"
            kind="classic"
            state={mode === "create" && createStep === 2 ? "shield" : "vault"}
            size={64}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
            <span className="glass-pill glass-pill--trust">0 Server Keys</span>
            <span className="glass-pill">{config.network.toUpperCase()} Vault</span>
          </div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Create Sovereign Stellar Vault
          </h1>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
            SEP-0005 Multi-Account Seed · Argon2id + AES-GCM-256 IndexedDB
          </div>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="aw-mode-tabs" role="tablist" aria-label="Vault initialization mode">
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={mode === "create"}
          onClick={() => {
            setMode("create");
            setCreateStep(1);
            setError(null);
          }}
        >
          <IconSparkles size={14} />
          <span>Create Vault</span>
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
          <IconKey size={14} />
          <span>Import Seed</span>
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
          <IconShield size={14} />
          <span>Restore .agvault</span>
        </button>
      </div>

      {/* Guided 2-Step Bar for New Vault */}
      {mode === "create" && (
        <div className="aw-steps" aria-label="Vault creation progress">
          <div className={`aw-step-pill ${createStep === 1 ? "is-active" : "is-done"}`}>
            <span>1</span>
            <span>Backup Recovery Phrase</span>
          </div>
          <div className={`aw-step-pill ${createStep === 2 ? "is-active" : ""}`}>
            <span>2</span>
            <span>Protect with PIN</span>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
        {mode === "create" && createStep === 1 && (
          <>
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                  gap: 8,
                }}
              >
                <span className="aw-label" style={{ marginBottom: 0 }}>
                  12-Word SEP-0005 Recovery Phrase
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="aw-chip-btn" onClick={handleCopySeed}>
                    {copiedSeed ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    <span>{copiedSeed ? "Copied" : "Copy"}</span>
                  </button>
                  <button type="button" className="aw-chip-btn" onClick={handleRegenerate}>
                    <IconRefresh size={13} />
                    <span>New Phrase</span>
                  </button>
                </div>
              </div>

              <div className="aw-seed-grid">
                {words.map((word, idx) => (
                  <div key={`${idx}-${word}`} className="aw-seed-word">
                    <span className="aw-seed-index">{String(idx + 1).padStart(2, "0")}</span>
                    <span className="aw-seed-text">{word}</span>
                  </div>
                ))}
              </div>

              <label className="aw-checkbox-row">
                <input
                  type="checkbox"
                  checked={confirmedBackup}
                  onChange={(e) => {
                    setConfirmedBackup(e.target.checked);
                    setError(null);
                  }}
                />
                <span>
                  I wrote down these 12 words offline. AstroWallet never stores seeds on any server.
                </span>
              </label>
            </div>

            {error && (
              <div className="aw-banner aw-banner--danger" role="alert">
                {error}
              </div>
            )}

            <button
              type="button"
              className="aw-btn-primary"
              disabled={!confirmedBackup}
              onClick={handleAdvanceToPin}
            >
              Continue to PIN Setup →
            </button>
          </>
        )}

        {mode === "create" && createStep === 2 && (
          <>
            <div className="aw-list-row" style={{ padding: "10px 12px" }}>
              <span style={{ fontSize: 12, color: "var(--aw-trust-emerald)", fontWeight: 600 }}>
                12-word recovery phrase backed up
              </span>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setCreateStep(1);
                  setError(null);
                }}
              >
                Review Phrase
              </button>
            </div>

            <div>
              <label className="aw-label" htmlFor="account-label-input">
                Primary Account Label (m/44&apos;/148&apos;/0&apos;)
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

            <div className="aw-two-col-inputs">
              <div>
                <label className="aw-label" htmlFor="vault-pin-input">
                  Vault PIN / Passphrase (min 6 chars)
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
            </div>

            {error && (
              <div className="aw-banner aw-banner--danger" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="aw-btn-primary" disabled={busy}>
              <IconLock size={16} />
              <span>
                {busy
                  ? "Encrypting Vault with Argon2id..."
                  : "Encrypt & Create Sovereign Vault"}
              </span>
            </button>
          </>
        )}

        {mode === "import" && (
          <>
            <div>
              <label className="aw-label" htmlFor="import-seed-input">
                Enter 12 or 24-Word SEP-0005 Seed Phrase (LOBSTR / Ledger compatible)
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

            <div>
              <label className="aw-label" htmlFor="import-account-label-input">
                First Account Label (m/44&apos;/148&apos;/0&apos;)
              </label>
              <input
                id="import-account-label-input"
                type="text"
                className="aw-input"
                maxLength={32}
                value={accountLabel}
                onChange={(e) => setAccountLabel(e.target.value)}
              />
            </div>

            <div className="aw-two-col-inputs">
              <div>
                <label className="aw-label" htmlFor="import-pin-input">
                  Create Local PIN / Passphrase
                </label>
                <input
                  id="import-pin-input"
                  type="password"
                  className="aw-input"
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
              </div>
              <div>
                <label className="aw-label" htmlFor="import-pin-confirm">
                  Confirm PIN / Passphrase
                </label>
                <input
                  id="import-pin-confirm"
                  type="password"
                  className="aw-input"
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                />
              </div>
            </div>

            {error && (
              <div className="aw-banner aw-banner--danger" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="aw-btn-primary" disabled={busy}>
              <IconLock size={16} />
              <span>
                {busy
                  ? "Encrypting Vault with Argon2id..."
                  : "Import Seed & Encrypt Vault"}
              </span>
            </button>
          </>
        )}

        {mode === "restore_agvault" && (
          <>
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

            <div>
              <label className="aw-label" htmlFor="restore-pin-input">
                Vault PIN / Passphrase
              </label>
              <input
                id="restore-pin-input"
                type="password"
                className="aw-input"
                autoComplete="current-password"
                placeholder="Enter backup PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>

            {error && (
              <div className="aw-banner aw-banner--danger" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="aw-btn-primary" disabled={busy}>
              <IconShield size={16} />
              <span>{busy ? "Decrypting..." : "Decrypt & Restore Vault"}</span>
            </button>
          </>
        )}
      </form>
    </section>
  );
}
