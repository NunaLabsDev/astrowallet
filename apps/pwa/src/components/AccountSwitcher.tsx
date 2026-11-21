import { useState, type FormEvent } from "react";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { computeNextDerivationIndex } from "./flow-validators.js";

export function AccountSwitcher() {
  const { hasEncryptedBackup, uploadEncryptedBackup } = useTelegram();
  const {
    accounts,
    activeAccount,
    setActiveIndex,
    addDerivedAccount,
    exportAgVaultJson,
    showToast,
  } = useWallet();

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextDerivationIndex = computeNextDerivationIndex(accounts);

  const handleAddAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addDerivedAccount(newLabel, pin);
      if (hasEncryptedBackup) {
        void exportAgVaultJson()
          .then((json) => uploadEncryptedBackup(json))
          .catch(() => {
            showToast(
              "Derived locally — tap Re-Sync in Vault tab to update Telegram backup",
              "info",
            );
          });
      }
      setNewLabel("");
      setPin("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to derive account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          paddingBottom: 4,
          alignItems: "center",
        }}
      >
        {accounts.map((acc) => {
          const isSelected = acc.address === activeAccount?.address;
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
          }}
          style={{ whiteSpace: "nowrap" }}
        >
          + Add Account
        </button>
      </div>

      {adding && (
        <form
          onSubmit={handleAddAccount}
          className="glass-card"
          style={{ display: "grid", gap: 10 }}
        >
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
          <div style={{ display: "flex", gap: 8 }}>
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
  );
}
