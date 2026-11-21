import { useMemo, useState, type FormEvent } from "react";
import { ClassicAddressSchema, MuxedAddressSchema, type ClassicAddress } from "@astrowallet/domain";
import {
  filterSpamClaimableBalances,
  sanitizeMemoPhishing,
} from "@astrowallet/security-shield";
import { decodeMuxedAddress, encodeMuxedAddress } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function ClassicToolsSheet() {
  const {
    activeAccount,
    accountState,
    claimableBalances,
    openOffers,
    verifiedAssets,
    addOrRemoveTrustline,
    reclaimZeroBalanceReserves,
    claimBalanceById,
    placeSdexOffer,
  } = useWallet();

  const [muxedIdInput, setMuxedIdInput] = useState("1001");
  const [muxedDecodeInput, setMuxedDecodeInput] = useState("");
  const [muxedResult, setMuxedResult] = useState<string | null>(null);

  const [trustCode, setTrustCode] = useState("USDC");
  const [trustIssuer, setTrustIssuer] = useState("");
  const [trustLimit, setTrustLimit] = useState("");

  const [sellCode, setSellCode] = useState("XLM");
  const [sellIssuer, setSellIssuer] = useState("");
  const [buyCode, setBuyCode] = useState("USDC");
  const [buyIssuer, setBuyIssuer] = useState("");
  const [sdexAmount, setSdexAmount] = useState("");
  const [sdexPrice, setSdexPrice] = useState("");

  const [busy, setBusy] = useState(false);
  const [zenithSuccess, setZenithSuccess] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSpamClaimables, setShowSpamClaimables] = useState(false);

  const safeClaimableIds = useMemo(() => {
    const filtered = filterSpamClaimableBalances(claimableBalances, { verifiedAssets });
    return new Set(filtered.map((c) => c.id));
  }, [claimableBalances, verifiedAssets]);

  const hiddenSpamCount = Math.max(0, claimableBalances.length - safeClaimableIds.size);
  const visibleClaimables = showSpamClaimables
    ? claimableBalances
    : claimableBalances.filter((c) => safeClaimableIds.has(c.id));

  if (!activeAccount) return null;

  const isClassic = activeAccount.capabilities.canSignClassicSdex;

  const handleEncodeMuxed = () => {
    setErrorMsg(null);
    try {
      const baseParsed = ClassicAddressSchema.safeParse(activeAccount.address);
      if (!baseParsed.success) {
        throw new Error("Active account must be a Classic G... address to encode M...");
      }
      const encoded = encodeMuxedAddress(baseParsed.data, muxedIdInput);
      setMuxedDecodeInput(encoded);
      setMuxedResult(`Encoded M...: ${encoded}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to encode muxed address");
    }
  };

  const handleDecodeMuxed = () => {
    setErrorMsg(null);
    try {
      const parsed = MuxedAddressSchema.safeParse(muxedDecodeInput.trim());
      if (!parsed.success) {
        throw new Error("Enter a valid 69-char M... muxed address");
      }
      const decoded = decodeMuxedAddress(parsed.data);
      setMuxedResult(`Base G...: ${decoded.baseAddress} · Memo ID: ${decoded.muxedId}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to decode muxed address");
    }
  };

  const handleReclaimReserves = async () => {
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    setZenithSuccess(false);
    try {
      const res = await reclaimZeroBalanceReserves();
      setZenithSuccess(true);
      setStatusMsg(
        `LumenWipe reclaimed +${res.reclaimedXlm} XLM in tx ${res.hash.slice(0, 8)}…${res.hash.slice(-6)}`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Reserve reclaim failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitTrustline = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    const parsedIssuer = ClassicAddressSchema.safeParse(trustIssuer.trim());
    if (!parsedIssuer.success) {
      setErrorMsg("Enter a valid Classic G... asset issuer address.");
      return;
    }
    setBusy(true);
    try {
      const res = await addOrRemoveTrustline(
        trustCode.trim(),
        parsedIssuer.data,
        trustLimit.trim() || undefined,
      );
      setStatusMsg(
        `Trustline updated for ${trustCode.trim()} (tx ${res.hash.slice(0, 8)}…${res.hash.slice(-6)})`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "changeTrust failed");
    } finally {
      setBusy(false);
    }
  };

  const handleClaimBalance = async (balanceId: string) => {
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    setZenithSuccess(false);
    try {
      const res = await claimBalanceById(balanceId);
      setZenithSuccess(true);
      setStatusMsg(`Claimed balance in tx ${res.hash.slice(0, 8)}…${res.hash.slice(-6)}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to claim balance");
    } finally {
      setBusy(false);
    }
  };

  const handlePlaceSdexOffer = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);

    let parsedSellIssuer: ClassicAddress | undefined;
    if (!(sellCode.trim().toUpperCase() === "XLM" && !sellIssuer.trim())) {
      const checkSell = ClassicAddressSchema.safeParse(sellIssuer.trim());
      if (!checkSell.success) {
        setErrorMsg("Enter a valid Classic G... selling asset issuer.");
        return;
      }
      parsedSellIssuer = checkSell.data;
    }

    let parsedBuyIssuer: ClassicAddress | undefined;
    if (!(buyCode.trim().toUpperCase() === "XLM" && !buyIssuer.trim())) {
      const checkBuy = ClassicAddressSchema.safeParse(buyIssuer.trim());
      if (!checkBuy.success) {
        setErrorMsg("Enter a valid Classic G... buying asset issuer.");
        return;
      }
      parsedBuyIssuer = checkBuy.data;
    }

    setBusy(true);
    try {
      const res = await placeSdexOffer({
        sellingCode: sellCode.trim(),
        sellingIssuer: parsedSellIssuer,
        buyingCode: buyCode.trim(),
        buyingIssuer: parsedBuyIssuer,
        amount: sdexAmount.trim(),
        price: sdexPrice.trim(),
      });
      setStatusMsg(`SDEX offer submitted (${res.hash.slice(0, 8)}…${res.hash.slice(-6)})`);
      setSdexAmount("");
      setSdexPrice("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "SDEX offer submission failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelOffer = async (offer: (typeof openOffers)[number]) => {
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await placeSdexOffer({
        sellingCode: offer.sellingAssetCode,
        sellingIssuer: offer.sellingAssetIssuer as ClassicAddress | undefined,
        buyingCode: offer.buyingAssetCode,
        buyingIssuer: offer.buyingAssetIssuer as ClassicAddress | undefined,
        amount: "0",
        price: offer.price,
        offerId: offer.id,
      });
      setStatusMsg(`Cancelled SDEX offer #${offer.id} (${res.hash.slice(0, 8)}…)`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to cancel offer");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Classic Stellar Power Tools"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, minWidth: 0 }}>
        <AstroNavigatorAvatar
          seedKey={activeAccount.address}
          kind={activeAccount.kind}
          state={zenithSuccess ? "zenith" : busy ? "warp" : "vault"}
          size={54}
        />
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Classic Stellar Tools &amp; Reserves
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            LumenWipe Reclaimer • M... Muxed • Trustlines • Claimables • SDEX
          </div>
        </div>
      </div>

      {/* 1. Reserve Calculator & LumenWipe Reclaimer */}
      <div className="aw-list-row" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>XLM Reserve &amp; LumenWipe</span>
          <span className="glass-pill tabular-nums">
            Min {accountState?.minReserveXlm ?? "0.0"} XLM
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
          Spendable: <strong>{accountState?.spendableXlm ?? "0.0000000"} XLM</strong> · Subentries:{" "}
          {accountState?.subentryCount ?? 0} (+{accountState?.numSponsoring ?? 0} sponsoring / -
          {accountState?.numSponsored ?? 0} sponsored)
        </div>
        {(accountState?.reclaimableTrustlines.length ?? 0) > 0 ? (
          <button
            type="button"
            className="aw-btn-gold"
            disabled={busy}
            onClick={() => void handleReclaimReserves()}
          >
            {busy
              ? "Reclaiming Trustline Reserves..."
              : `Reclaim +${accountState?.reclaimableXlm} XLM (${accountState?.reclaimableTrustlines.length} unused trustline(s))`}
          </button>
        ) : (
          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
            Zero unused trustlines detected (every active trustline holds balance &gt; 0).
          </div>
        )}
      </div>

      {/* 2. M... Muxed Address Encoder / Decoder */}
      <div style={{ display: "grid", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(165, 139, 224, 0.2)" }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>M... Muxed Address Encoder / Decoder</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            className="aw-input tabular-nums"
            style={{ flex: "1 1 160px", minWidth: 0 }}
            placeholder="64-bit Muxed ID"
            value={muxedIdInput}
            onChange={(e) => setMuxedIdInput(e.target.value)}
          />
          <button type="button" className="aw-btn-secondary" onClick={handleEncodeMuxed}>
            Encode M...
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            className="aw-input"
            style={{ flex: "1 1 180px", minWidth: 0 }}
            placeholder="Paste M... address to decode"
            value={muxedDecodeInput}
            onChange={(e) => setMuxedDecodeInput(e.target.value)}
          />
          <button type="button" className="aw-chip-btn" onClick={handleDecodeMuxed}>
            Decode
          </button>
        </div>
        {muxedResult && (
          <div className="aw-banner" style={{ wordBreak: "break-all", fontSize: 12 }}>
            {muxedResult}
          </div>
        )}
      </div>

      {/* 3. Trustline Manager (changeTrust) */}
      <form
        onSubmit={handleSubmitTrustline}
        style={{ display: "grid", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(165, 139, 224, 0.2)" }}
      >
        <div style={{ fontWeight: 700, fontSize: 13 }}>Trustline Manager (changeTrust)</div>
        {verifiedAssets.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {verifiedAssets.slice(0, 6).map((v) => (
              <button
                key={`${v.code}:${v.issuer}`}
                type="button"
                className="aw-mini-chip"
                onClick={() => {
                  setTrustCode(v.code);
                  setTrustIssuer(v.issuer);
                }}
              >
                {v.code} ({v.issuer.slice(0, 4)}…{v.issuer.slice(-4)})
              </button>
            ))}
          </div>
        )}
        <div className="aw-two-col-inputs">
          <input
            type="text"
            className="aw-input"
            placeholder="Asset Code (e.g. USDC)"
            value={trustCode}
            onChange={(e) => setTrustCode(e.target.value)}
          />
          <input
            type="text"
            className="aw-input"
            placeholder="Limit (empty=max, 0=remove)"
            value={trustLimit}
            onChange={(e) => setTrustLimit(e.target.value)}
          />
        </div>
        <input
          type="text"
          className="aw-input"
          placeholder="Asset Issuer G..."
          value={trustIssuer}
          onChange={(e) => setTrustIssuer(e.target.value)}
        />
        <button type="submit" className="aw-btn-secondary" disabled={busy || !isClassic}>
          {isClassic ? "Update Trustline (0.5 XLM reserve)" : "Classic G... Required"}
        </button>
      </form>

      {/* 4. Claimable Balances */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 8,
          minWidth: 0,
          paddingTop: 8,
          borderTop: "1px solid rgba(165, 139, 224, 0.2)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Claimable Balances ({visibleClaimables.length})
          </div>
          {hiddenSpamCount > 0 && (
            <button
              type="button"
              className="aw-chip-btn"
              onClick={() => setShowSpamClaimables((v) => !v)}
            >
              {showSpamClaimables ? "Hide spam" : `Show hidden spam (${hiddenSpamCount})`}
            </button>
          )}
        </div>
        {!isClassic ? (
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Smart Accounts (C...) cannot claim Classic Claimable Balances directly; route to your linked G... account.
          </div>
        ) : visibleClaimables.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            {hiddenSpamCount > 0
              ? `${hiddenSpamCount} dust/unverified claimable balance(s) hidden by Scan & Shield spam filter.`
              : "No pending Claimable Balances for this account."}
          </div>
        ) : (
          visibleClaimables.map((cb) => (
            <div key={cb.id} className="aw-list-row">
              <div style={{ minWidth: 0, flex: "1 1 160px" }}>
                <div className="tabular-nums" style={{ fontWeight: 700, fontSize: 13 }}>
                  {cb.amount} {sanitizeMemoPhishing(cb.assetCode)}
                </div>
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", overflowWrap: "anywhere" }}>
                  ID {cb.id.slice(0, 10)}…{cb.id.slice(-6)}
                  {cb.sponsor ? ` · Sponsor: ${sanitizeMemoPhishing(cb.sponsor.slice(0, 8))}…` : ""}
                </div>
              </div>
              <button
                type="button"
                className="aw-btn-primary"
                disabled={busy}
                onClick={() => void handleClaimBalance(cb.id)}
              >
                Claim
              </button>
            </div>
          ))
        )}
      </div>

      {/* 5. Classic SDEX Orderbook Offers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 8,
          minWidth: 0,
          paddingTop: 8,
          borderTop: "1px solid rgba(165, 139, 224, 0.2)",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          Classic SDEX Orderbook ({openOffers.length} open)
        </div>
        {!isClassic ? (
          <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
            Classic SDEX orderbook offers are only supported on Classic (G...) accounts. Use 1-tap SAC transfers to move funds from C... to G... first.
          </div>
        ) : (
          <form onSubmit={handlePlaceSdexOffer} style={{ display: "grid", gap: 8 }}>
            <div className="aw-two-col-inputs">
              <input
                type="text"
                className="aw-input"
                placeholder="Sell Code (XLM)"
                value={sellCode}
                onChange={(e) => setSellCode(e.target.value)}
              />
              <input
                type="text"
                className="aw-input"
                placeholder="Buy Code (USDC)"
                value={buyCode}
                onChange={(e) => setBuyCode(e.target.value)}
              />
            </div>
            {sellCode.trim().toUpperCase() !== "XLM" && (
              <input
                type="text"
                className="aw-input"
                placeholder="Selling Asset Issuer G..."
                value={sellIssuer}
                onChange={(e) => setSellIssuer(e.target.value)}
              />
            )}
            {buyCode.trim().toUpperCase() !== "XLM" && (
              <input
                type="text"
                className="aw-input"
                placeholder="Buying Asset Issuer G..."
                value={buyIssuer}
                onChange={(e) => setBuyIssuer(e.target.value)}
              />
            )}
            <div className="aw-two-col-inputs">
              <input
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                placeholder="Sell Amount"
                value={sdexAmount}
                onChange={(e) => setSdexAmount(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                placeholder="Price (Buy/Sell)"
                value={sdexPrice}
                onChange={(e) => setSdexPrice(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="aw-btn-secondary"
              disabled={busy || !sdexAmount.trim() || !sdexPrice.trim()}
            >
              Place Classic SDEX Offer
            </button>
          </form>
        )}

        {openOffers.map((offer) => (
          <div key={offer.id} className="aw-list-row">
            <div className="tabular-nums" style={{ fontSize: 12 }}>
              <strong>
                Sell {offer.amount} {offer.sellingAssetCode}
              </strong>{" "}
              for {offer.buyingAssetCode} @ {offer.price}
            </div>
            <button
              type="button"
              className="aw-chip-btn"
              disabled={busy}
              onClick={() => void handleCancelOffer(offer)}
            >
              Cancel #{offer.id}
            </button>
          </div>
        ))}
      </div>

      {statusMsg && <div className="aw-banner">{statusMsg}</div>}
      {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
    </section>
  );
}
