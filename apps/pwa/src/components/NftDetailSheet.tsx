import { useEffect, useMemo, useState } from "react";
import { readCachedEntry, writeCachedEntry } from "../state/market-cache.js";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, triggerTelegramHaptic } from "../telegram/webapp.js";
import { partitionWalletBalances } from "./asset-classification.js";
import type { ClassicNftMeta } from "./CollectiblesSheet.js";
import { IconCheck, IconCopy, IconExternalLink, IconNft, IconSearch, IconSend } from "./Icons.js";

export interface ClassicNftDetailTarget {
  assetCode: string;
  assetIssuer: string;
  meta?: ClassicNftMeta | undefined;
}

export interface NftDetailSheetProps {
  target: ClassicNftDetailTarget;
  onSelectNft: (next: ClassicNftDetailTarget) => void;
  onInspectAddress?: (address: string) => void;
  onSendNft?: (prefill: { assetCode: string; assetIssuer: string; amount: string }) => void;
}

interface HorizonAssetSupplyRecord {
  amount?: string;
  num_accounts?: number;
  accounts?: { authorized?: number };
  flags?: {
    auth_immutable?: boolean;
    auth_revocable?: boolean;
    auth_clawback_enabled?: boolean;
  };
}

/**
 * Decodes numeric/named HTML entities and strips markup tags safely into plain text.
 */
export function formatNftDescription(raw?: string): string {
  if (!raw) return "";
  const noTags = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:center|p|div|span|strong|b|i|em)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

function extractCollectionPrefix(assetCode: string): string | null {
  const stripped = assetCode.replace(/\d+$/, "");
  return stripped.length >= 3 ? stripped.toLowerCase() : null;
}

export function NftDetailSheet({
  target,
  onSelectNft,
  onInspectAddress,
  onSendNft,
}: NftDetailSheetProps) {
  const { config, accountState, showToast } = useWallet();
  const [meta, setMeta] = useState<ClassicNftMeta | null>(target.meta ?? null);
  const [supplyInfo, setSupplyInfo] = useState<HorizonAssetSupplyRecord | null>(null);
  const [loading, setLoading] = useState(!target.meta);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [siblingMetaMap, setSiblingMetaMap] = useState<Record<string, ClassicNftMeta>>({});

  useEffect(() => {
    let cancelled = false;
    setMeta(target.meta ?? null);
    setLightboxOpen(false);
    setLoading(!target.meta);

    const cacheKey = `nftmeta:${config.network}:${target.assetCode}:${target.assetIssuer}`;
    const base = config.apiBaseUrl.replace(/\/+$/, "");

    async function loadAll() {
      if (!target.meta) {
        const cached = await readCachedEntry<ClassicNftMeta>(cacheKey, 24 * 60 * 60 * 1000);
        if (cached?.data && !cancelled) {
          setMeta(cached.data);
          setLoading(false);
        } else {
          try {
            const res = await fetch(
              `${base}/v1/proxy/nft-meta?issuer=${encodeURIComponent(target.assetIssuer)}&code=${encodeURIComponent(target.assetCode)}`,
              { headers: { "X-Astro-Network": config.network }, signal: AbortSignal.timeout(8000) },
            );
            if (res.ok && !cancelled) {
              const data = (await res.json()) as ClassicNftMeta;
              writeCachedEntry(cacheKey, data, 24 * 60 * 60 * 1000);
              setMeta(data);
            }
          } catch {
            // Keep graceful fallback
          } finally {
            if (!cancelled) setLoading(false);
          }
        }
      }

      for (const hBase of config.horizonUrls) {
        const clean = hBase.replace(/\/+$/, "");
        try {
          const res = await fetch(
            `${clean}/assets?asset_code=${encodeURIComponent(target.assetCode)}&asset_issuer=${encodeURIComponent(target.assetIssuer)}&limit=1`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok) continue;
          const body = (await res.json()) as { _embedded?: { records?: HorizonAssetSupplyRecord[] } };
          const rec = body._embedded?.records?.[0] ?? null;
          if (!cancelled && rec) {
            setSupplyInfo(rec);
          }
          break;
        } catch {
          continue;
        }
      }
    }

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [target, config.apiBaseUrl, config.horizonUrls, config.network]);

  // Discover sibling collectibles in the user's wallet sharing collection prefix or homeDomain
  const collectionSiblings = useMemo(() => {
    const allNfts = partitionWalletBalances(accountState?.balances ?? []).classicNfts;
    const prefix = extractCollectionPrefix(target.assetCode);
    return allNfts
      .filter(
        (b) =>
          b.assetIssuer &&
          !(b.assetCode === target.assetCode && b.assetIssuer === target.assetIssuer) &&
          (prefix !== null
            ? extractCollectionPrefix(b.assetCode) === prefix
            : b.assetCode.toLowerCase() === target.assetCode.toLowerCase()),
      )
      .slice(0, 10);
  }, [accountState?.balances, target.assetCode, target.assetIssuer]);

  useEffect(() => {
    if (collectionSiblings.length === 0) return undefined;
    let cancelled = false;
    void Promise.all(
      collectionSiblings.slice(0, 6).map(async (sib) => {
        if (!sib.assetIssuer) return;
        const key = `${sib.assetCode}:${sib.assetIssuer}`;
        const cached = await readCachedEntry<ClassicNftMeta>(
          `nftmeta:${config.network}:${key}`,
          24 * 60 * 60 * 1000,
        );
        if (cached?.data && !cancelled) {
          setSiblingMetaMap((prev) => ({ ...prev, [key]: cached.data }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [collectionSiblings, config.network]);

  const handleCopy = async (key: string, val: string) => {
    const ok = await copyTextToClipboard(val);
    if (ok) {
      setCopiedKey(key);
      triggerTelegramHaptic("selection");
      showToast(`${key} copied`);
      setTimeout(() => setCopiedKey(null), 1500);
    }
  };

  const cleanDesc = useMemo(() => formatNftDescription(meta?.description), [meta?.description]);
  const editionsCount = useMemo(() => {
    const rawAmt = Number(supplyInfo?.amount ?? "0.0000001");
    if (!Number.isFinite(rawAmt) || rawAmt <= 0) return 1;
    return Math.max(1, Math.round(rawAmt * 10_000_000));
  }, [supplyInfo?.amount]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Hero Artwork */}
      <div className="aw-nft-detail-hero">
        {meta?.image ? (
          <button
            type="button"
            className="aw-nft-detail-img-btn"
            onClick={() => setLightboxOpen((v) => !v)}
            title="Tap to zoom artwork"
          >
            <img src={meta.image} alt={meta.name ?? target.assetCode} />
          </button>
        ) : (
          <div className="aw-nft-fallback" style={{ padding: 36 }}>
            <IconNft size={36} />
            <span>{loading ? "Loading artwork..." : target.assetCode}</span>
          </div>
        )}
      </div>

      {lightboxOpen && meta?.image && (
        <div
          className="aw-nft-lightbox"
          role="dialog"
          aria-label="Artwork Zoom"
          onClick={() => setLightboxOpen(false)}
        >
          <img src={meta.image} alt={meta.name ?? target.assetCode} />
        </div>
      )}

      {/* Collector Title, Badges & Description */}
      <div className="glass-card" style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="glass-pill glass-pill--gold">
            {editionsCount === 1 ? "1 / 1 Unique" : `${editionsCount} Editions`}
          </span>
          {meta?.homeDomain && <span className="glass-pill glass-pill--trust">{meta.homeDomain}</span>}
          <span className="glass-pill">{target.assetCode}</span>
        </div>

        <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
          {meta?.name ?? target.assetCode}
        </div>

        {cleanDesc && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--aw-ink-secondary)" }}>
            {cleanDesc}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {onSendNft && (
            <button
              type="button"
              className="aw-btn-primary"
              onClick={() =>
                onSendNft({
                  assetCode: target.assetCode,
                  assetIssuer: target.assetIssuer,
                  amount: "0.0000001",
                })
              }
            >
              <IconSend size={14} />
              <span>Send NFT</span>
            </button>
          )}
          {meta?.homeDomain && (
            <a
              href={`https://${meta.homeDomain}`}
              target="_blank"
              rel="noreferrer"
              className="aw-btn-secondary"
              style={{ textDecoration: "none" }}
            >
              <span>Creator Store</span>
              <IconExternalLink size={14} />
            </a>
          )}
          <button
            type="button"
            className="aw-btn-secondary"
            onClick={() => void handleCopy("Asset", `${target.assetCode}:${target.assetIssuer}`)}
          >
            {copiedKey === "Asset" ? <IconCheck size={14} /> : <IconCopy size={14} />}
            <span>{copiedKey === "Asset" ? "Copied" : "Copy Asset"}</span>
          </button>
        </div>
      </div>

      {/* Collection Discovery Strip */}
      {collectionSiblings.length > 0 && (
        <div className="glass-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>
              More in This Collection ({collectionSiblings.length})
            </span>
            <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>In your wallet</span>
          </div>
          <div className="aw-account-strip">
            {collectionSiblings.map((sib) => {
              const sibKey = `${sib.assetCode}:${sib.assetIssuer ?? ""}`;
              const sibMeta = siblingMetaMap[sibKey];
              return (
                <button
                  key={sibKey}
                  type="button"
                  className="aw-collection-thumb"
                  onClick={() => {
                    if (sib.assetIssuer) {
                      onSelectNft({
                        assetCode: sib.assetCode,
                        assetIssuer: sib.assetIssuer,
                        meta: sibMeta,
                      });
                    }
                  }}
                >
                  <div className="aw-collection-thumb-img">
                    {sibMeta?.image ? (
                      <img src={sibMeta.image} alt={sibMeta.name ?? sib.assetCode} />
                    ) : (
                      <IconNft size={18} />
                    )}
                  </div>
                  <span className="aw-collection-thumb-label">
                    {sibMeta?.name ?? sib.assetCode}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Provenance & On-Chain Authenticity */}
      <div className="glass-card" style={{ display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>On-Chain Provenance</div>
        <div className="aw-contract-seals" style={{ fontSize: 12 }}>
          <div className="aw-seal-row">
            <span>Creator / Issuer</span>
            {onInspectAddress ? (
              <button
                type="button"
                className="aw-mini-chip"
                onClick={() => onInspectAddress(target.assetIssuer)}
              >
                <IconSearch size={11} />
                <code>
                  {target.assetIssuer.slice(0, 6)}…{target.assetIssuer.slice(-5)}
                </code>
              </button>
            ) : (
              <code>
                {target.assetIssuer.slice(0, 6)}…{target.assetIssuer.slice(-5)}
              </code>
            )}
          </div>

          {meta?.ipfsHash && (
            <div className="aw-seal-row">
              <span>IPFS Content</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <code>
                  {meta.ipfsHash.slice(0, 8)}…{meta.ipfsHash.slice(-6)}
                </code>
                <button
                  type="button"
                  className="aw-mini-chip"
                  onClick={() => void handleCopy("IPFS CID", meta.ipfsHash!)}
                >
                  {copiedKey === "IPFS CID" ? <IconCheck size={11} /> : <IconCopy size={11} />}
                </button>
              </div>
            </div>
          )}

          <div className="aw-seal-row">
            <span>Editions &amp; Holders</span>
            <code className="tabular-nums">
              {editionsCount === 1 ? "1 / 1 Unique" : `${editionsCount} Editions`} ·{" "}
              {supplyInfo?.accounts?.authorized ?? supplyInfo?.num_accounts ?? 1} holder(s)
            </code>
          </div>

          <div className="aw-seal-row">
            <span>Issuer Flags</span>
            <code>
              {supplyInfo?.flags?.auth_immutable ? "Immutable" : "Mutable"} ·{" "}
              {supplyInfo?.flags?.auth_clawback_enabled ? "Clawback On" : "No Clawback"}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}
