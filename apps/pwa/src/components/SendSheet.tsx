import { useState, type FormEvent } from "react";
import { StellarAddressSchema } from "@astrowallet/domain";
import type { TypedMemoInput } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

type MemoKind = TypedMemoInput["kind"];

export function SendSheet({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  embedded?: boolean | undefined;
}) {
  const { activeAccount, sendPayment, config } = useWallet();

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memoKind, setMemoKind] = useState<MemoKind>("text");
  const [memoValue, setMemoValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedTxHash, setConfirmedTxHash] = useState<string | null>(null);

  if (!activeAccount) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedDest = StellarAddressSchema.safeParse(destination.trim());
    if (!parsedDest.success) {
      setError("Enter a valid Stellar G..., C..., or M... destination address.");
      return;
    }

    if (!/^\d+(\.\d{1,7})?$/.test(amount.trim()) || Number(amount) <= 0) {
      setError("Enter a valid positive XLM amount (up to 7 decimals).");
      return;
    }

    let typedMemo: TypedMemoInput | undefined;
    const cleanMemo = memoValue.trim();
    if (memoKind !== "none" && cleanMemo.length > 0) {
      if (memoKind === "text") {
        typedMemo = { kind: "text", value: cleanMemo };
      } else if (memoKind === "id") {
        typedMemo = { kind: "id", value: cleanMemo };
      } else if (memoKind === "hash") {
        typedMemo = { kind: "hash", valueHex: cleanMemo };
      } else if (memoKind === "return") {
        typedMemo = { kind: "return", valueHex: cleanMemo };
      }
    }

    setBusy(true);
    try {
      const res = await sendPayment({
        destination: parsedDest.data,
        amount: amount.trim(),
        assetCode: "XLM",
        typedMemo,
      });
      setConfirmedTxHash(res.hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-sheet" aria-label="Send Stellar payment">
      {!embedded && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AstroNavigatorAvatar
              seedKey={activeAccount.address}
              kind={activeAccount.kind}
              state={confirmedTxHash ? "zenith" : busy ? "warp" : "shield"}
              size={52}
            />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {confirmedTxHash ? "Transaction Confirmed" : `Send from ${activeAccount.label}`}
              </div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Network: {config.network.toUpperCase()} • Supports G..., M... muxed &amp; typed Memos
              </div>
            </div>
          </div>
          <button type="button" className="aw-chip-btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}

      {confirmedTxHash ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="aw-banner">
            <div style={{ fontWeight: 700, color: "var(--aw-stellar-gold)", marginBottom: 4 }}>
              Confirmed on Stellar {config.network.toUpperCase()}
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>
              Tx Hash: <code>{confirmedTxHash}</code>
            </div>
          </div>
          <button type="button" className="aw-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="aw-label" htmlFor="send-dest-input">
              Destination Address (G..., M..., or C...)
            </label>
            <input
              id="send-dest-input"
              type="text"
              className="aw-input"
              placeholder="G... or M..."
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>

          <div>
            <label className="aw-label" htmlFor="send-amount-input">
              Amount (XLM)
            </label>
            <input
              id="send-amount-input"
              type="text"
              inputMode="decimal"
              className="aw-input tabular-nums"
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8 }}>
            <div>
              <label className="aw-label" htmlFor="send-memo-kind">
                Memo Type
              </label>
              <select
                id="send-memo-kind"
                className="aw-input"
                value={memoKind}
                onChange={(e) => setMemoKind(e.target.value as MemoKind)}
              >
                <option value="text">Text</option>
                <option value="id">ID (u64)</option>
                <option value="hash">Hash (Hex)</option>
                <option value="return">Return (Hex)</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="send-memo-input">
                Memo Value (Optional)
              </label>
              <input
                id="send-memo-input"
                type="text"
                className="aw-input"
                disabled={memoKind === "none"}
                placeholder={
                  memoKind === "id"
                    ? "Numeric uint64 memo"
                    : memoKind === "hash" || memoKind === "return"
                      ? "64-char hex digest"
                      : "Max 28 UTF-8 bytes"
                }
                value={memoValue}
                onChange={(e) => setMemoValue(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="aw-banner aw-banner--danger" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="aw-btn-primary" disabled={busy}>
            {busy ? "Signing & Broadcasting..." : "Sign & Send XLM"}
          </button>
        </form>
      )}
    </section>
  );
}
