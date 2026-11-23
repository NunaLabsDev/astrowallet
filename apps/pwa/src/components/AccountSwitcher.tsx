import { useMemo, useState, type FormEvent } from "react";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, triggerTelegramHaptic } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { computeNextDerivationIndex } from "./flow-validators.js";
import { IconCheck, IconCopy } from "./Icons.js";

type AccountDrawerMode = "seed_explorer" | "import_secret" | "derive_next";

export function AccountSwitcher() {
  const { hasEncryptedBackup, uploadEncryptedBackup } = useTelegram();
  const {
    accounts,
    activeAccount,
    setActiveIndex,
    addDerivedAccount,
    activateDerivedAccountAtIndex,
    importExternalSecretAccount,
    isImportedAccount,
    derivePublicKeyPreview,
    exportAgVaultJson,
    showToast,
  } = useWallet();

  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AccountDrawerMode>("seed_explorer");
  const [newLabel, setNewLabel] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [selectedSeedIdx, setSelectedSeedIdx] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const nextDerivationIndex = computeNextDerivationIndex(accounts);

  const seedPreviews = useMemo(() => {
    if (!adding || mode !== "seed_explorer") return [];
    try {
      return derivePublicKeyPreview(10);
    } catch {
      return [];
    }
  }, [adding, mode, derivePublicKeyPreview]);

  const syncBackupIfEnabled = () => {
    if (!hasEncryptedBackup) return;
    void exportAgVaultJson()
      .then((json) => uploadEncryptedBackup(json))
      .catch(() => {
        showToast(
          "Saved locally — tap Re-Sync in Vault tab to update Telegram backup",
          "info",
        );
      });
  };

  const handleAddAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addDerivedAccount(newLabel, pin);
      syncBackupIfEnabled();
      setNewLabel("");
      setPin("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to derive account");
    } finally {
      setBusy(false);
    }
  };

  const handleActivateSeedIndex = async (e: FormEvent) => {
    e.preventDefault();
    if (selectedSeedIdx === null) return;
    setBusy(true);
    setError(null);
    try {
      await activateDerivedAccountAtIndex(selectedSeedIdx, newLabel, pin);
      syncBackupIfEnabled();
      setNewLabel("");
      setPin("");
      setSelectedSeedIdx(null);
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate derived account");
    } finally {
      setBusy(false);
    }
  };

  const handleImportSecret = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await importExternalSecretAccount(secretInput, newLabel, pin);
      syncBackupIfEnabled();
      setSecretInput("");
      setNewLabel("");
      setPin("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import external Stellar key");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPreview = async (addr: string) => {
    const ok = await copyTextToClipboard(addr);
    if (ok) {
      setCopiedAddr(addr);
      triggerTelegramHaptic("selection");
      setTimeout(() => setCopiedAddr(null), 1400);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          paddingBottom: 4,
          alignItems: "center",
          maxWidth: "100%",
          minWidth: 0,
          scrollbarWidth: "none",
        }}
      >
        {accounts.map((acc) => {
          const isSelected = acc.address === activeAccount?.address;
          const imported = isImportedAccount(acc.address);
          return (
            <button
              key={acc.id}
              type="button"
              className="aw-chip-btn"
              aria-pressed={isSelected}
              onClick={() => setActiveIndex(acc.derivationIndex ?? 0)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap",
              }}
            >
              <AstroNavigatorAvatar
                seedKey={acc.address}
                kind={acc.kind}
                state="float"
                size={22}
              />
              <span>{acc.label}</span>
              {imported && (
                <span className="glass-pill glass-pill--gold" style={{ fontSize: 9, padding: "1px 5px" }}>
                  IMPORTED
                </span>
              )}
              <span style={{ opacity: 0.7, fontSize: 11 }}>
                ({acc.address.slice(0, 4)}…{acc.address.slice(-4)})
              </span>
            </button>
          );
        })}

        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={adding}
          onClick={() => {
            setAdding((v) => !v);
            setError(null);
            setSelectedSeedIdx(null);
          }}
          style={{ whiteSpace: "nowrap" }}
        >
          + Explore / Add Key
        </button>
      </div>

      {adding && (
        <div className="glass-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-chip-btn"
              aria-pressed={mode === "seed_explorer"}
              onClick={() => {
                setMode("seed_explorer");
                setError(null);
              }}
            >
              Seed Keys (0–9)
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              aria-pressed={mode === "import_secret"}
              onClick={() => {
                setMode("import_secret");
                setError(null);
              }}
            >
              Import Secret (S…)
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              aria-pressed={mode === "derive_next"}
              onClick={() => {
                setMode("derive_next");
                setError(null);
              }}
            >
              Next (#{nextDerivationIndex})
            </button>
          </div>

          {mode === "seed_explorer" && (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Public keys derived deterministically from your 12/24-word recovery phrase
                (<code>m/44&apos;/148&apos;/i&apos;</code>). Activate or switch to any key below.
              </div>
              <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                {seedPreviews.map((row) => {
                  const existingAcc = accounts.find((a) => a.address === row.publicKey);
                  const isActive = activeAccount?.address === row.publicKey;
                  const isActivatingThis = selectedSeedIdx === row.index;
                  return (
                    <div
                      key={row.index}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        padding: "8px 10px",
                        borderRadius: 12,
                        background: "rgba(255,255,255,0.04)",
                        border: isActive
                          ? "1px solid var(--aw-trust-emerald)"
                          : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>
                          #{row.index + 1} · <code>{row.derivationPath}</code>{" "}
                          {existingAcc ? `(${existingAcc.label})` : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                          <code>
                            {row.publicKey.slice(0, 8)}…{row.publicKey.slice(-6)}
                          </code>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                          type="button"
                          className="aw-mini-chip"
                          onClick={() => void handleCopyPreview(row.publicKey)}
                        >
                          {copiedAddr === row.publicKey ? (
                            <IconCheck size={12} />
                          ) : (
                            <IconCopy size={12} />
                          )}
                          <span>{copiedAddr === row.publicKey ? "Copied" : "Copy"}</span>
                        </button>
                        {existingAcc ? (
                          <button
                            type="button"
                            className="aw-chip-btn"
                            aria-pressed={isActive}
                            onClick={() => {
                              setActiveIndex(existingAcc.derivationIndex ?? row.index);
                              setAdding(false);
                            }}
                          >
                            {isActive ? "✓ Active" : "Use Key"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="aw-chip-btn"
                            aria-pressed={isActivatingThis}
                            onClick={() => {
                              setSelectedSeedIdx(isActivatingThis ? null : row.index);
                              setNewLabel(`Account #${row.index + 1}`);
                              setError(null);
                            }}
                          >
                            + Activate
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {selectedSeedIdx !== null && (
                <form
                  onSubmit={(e) => void handleActivateSeedIndex(e)}
                  style={{ display: "grid", gap: 8, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700 }}>
                    Activate Seed Account m/44&apos;/148&apos;/{selectedSeedIdx}&apos;
                  </div>
                  <input
                    type="text"
                    className="aw-input"
                    placeholder={`Label (e.g. Account #${selectedSeedIdx + 1})`}
                    maxLength={32}
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                  <input
                    type="password"
                    className="aw-input"
                    placeholder="Confirm Vault PIN to save"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                  />
                  {error && <div className="aw-banner aw-banner--danger">{error}</div>}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="submit"
                      className="aw-btn-primary"
                      disabled={busy || pin.length < 6}
                    >
                      {busy ? "Activating..." : "Activate & Switch"}
                    </button>
                    <button
                      type="button"
                      className="aw-btn-secondary"
                      onClick={() => setSelectedSeedIdx(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {mode === "import_secret" && (
            <form onSubmit={(e) => void handleImportSecret(e)} style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Import an existing external Stellar secret key (<code>S…</code>). Encrypted locally
                with Argon2id + AES-GCM-256 inside your vault.
              </div>
              <input
                type="password"
                className="aw-input"
                placeholder="Stellar Secret Key (S...)"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                autoComplete="off"
              />
              <input
                type="text"
                className="aw-input"
                placeholder="Label (e.g. External Trading)"
                maxLength={32}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <input
                type="password"
                className="aw-input"
                placeholder="Confirm Vault PIN to encrypt & save"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              {error && <div className="aw-banner aw-banner--danger">{error}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="submit"
                  className="aw-btn-primary"
                  disabled={busy || pin.length < 6 || !secretInput.trim()}
                >
                  {busy ? "Encrypting..." : "Import & Encrypt"}
                </button>
                <button
                  type="button"
                  className="aw-btn-secondary"
                  onClick={() => setAdding(false)}
                >
                  Close
                </button>
              </div>
            </form>
          )}

          {mode === "derive_next" && (
            <form onSubmit={(e) => void handleAddAccount(e)} style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                Derive Next SEP-0005 Account (m/44&apos;/148&apos;/{nextDerivationIndex}&apos;)
              </div>
              <input
                type="text"
                className="aw-input"
                placeholder="Label (e.g. Savings, Trading)"
                maxLength={32}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <input
                type="password"
                className="aw-input"
                placeholder="Confirm Vault PIN to save"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              {error && <div className="aw-banner aw-banner--danger">{error}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="submit"
                  className="aw-btn-primary"
                  disabled={busy || pin.length < 6}
                >
                  {busy ? "Deriving..." : "Derive & Save"}
                </button>
                <button
                  type="button"
                  className="aw-btn-secondary"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
