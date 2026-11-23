import { useEffect, useMemo, useRef, useState } from "react";
import { readCachedEntry, writeCachedEntry } from "../state/market-cache.js";
import { useWallet } from "../state/wallet-context.js";
import { partitionWalletBalances } from "./asset-classification.js";
import { IconNft, IconSearch } from "./Icons.js";

export interface ClassicNftMeta {
  code: string;
  issuer: string;
  homeDomain?: string | undefined;
  ipfsHash?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  image?: string | undefined;
  resolved: boolean;
}

export interface ClassicNftSelection {
  assetCode: string;
  assetIssuer: string;
  meta?: ClassicNftMeta | undefined;
}

export interface CollectiblesSheetProps {
  onBack?: () => void;
  onSelectClassicNft?: (nft: ClassicNftSelection) => void;
}

const NFT_BATCH_SIZE = 12;
const NFT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function CollectiblesSheet({
  onBack,
  onSelectClassicNft,
}: CollectiblesSheetProps = {}) {
  const { config, activeAccount, accountState } = useWallet();

  const classicNfts = useMemo(
    () => partitionWalletBalances(accountState?.balances ?? []).classicNfts,
    [accountState?.balances],
  );

  const [nftSearch, setNftSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(NFT_BATCH_SIZE);
  const [nftMetaMap, setNftMetaMap] = useState<Record<string, ClassicNftMeta>>({});
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(NFT_BATCH_SIZE);
  }, [activeAccount?.address, classicNfts.length]);

  const filteredClassicNfts = useMemo(() => {
    const q = nftSearch.trim().toLowerCase();
    if (!q) return classicNfts;
    return classicNfts.filter((item) => {
      const key = `${item.assetCode}:${item.assetIssuer ?? ""}`;
      const meta = nftMetaMap[key];
      return (
        item.assetCode.toLowerCase().includes(q) ||
        (item.assetIssuer ?? "").toLowerCase().includes(q) ||
        (meta?.name ?? "").toLowerCase().includes(q) ||
        (meta?.homeDomain ?? "").toLowerCase().includes(q)
      );
    });
  }, [classicNfts, nftSearch, nftMetaMap]);

  const visibleClassicNfts = useMemo(
    () => filteredClassicNfts.slice(0, visibleCount),
    [filteredClassicNfts, visibleCount],
  );

  const hasMoreNfts = visibleCount < filteredClassicNfts.length;

  // Smooth infinite scroll as the user scrolls down
  useEffect(() => {
    if (!hasMoreNfts) return undefined;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) => Math.min(prev + NFT_BATCH_SIZE, filteredClassicNfts.length));
        }
      },
      { rootMargin: "260px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreNfts, filteredClassicNfts.length]);

  // Lazy-resolve real IPFS/TOML metadata for visible Classic NFTs (concurrency 4)
  useEffect(() => {
    if (visibleClassicNfts.length === 0) return undefined;
    let cancelled = false;
    const targets = visibleClassicNfts.filter((item) => {
      if (!item.assetIssuer) return false;
      const key = `${item.assetCode}:${item.assetIssuer}`;
      return !nftMetaMap[key];
    });
    if (targets.length === 0) return undefined;

    const base = config.apiBaseUrl.replace(/\/+$/, "");
    let cursor = 0;
    const workers = Math.min(4, targets.length);

    void Promise.all(
      Array.from({ length: workers }, async () => {
        while (!cancelled && cursor < targets.length) {
          const item = targets[cursor++];
          if (!item?.assetIssuer) break;
          const key = `${item.assetCode}:${item.assetIssuer}`;
          const cacheKey = `nftmeta:${config.network}:${key}`;
          const cached = await readCachedEntry<ClassicNftMeta>(cacheKey, NFT_CACHE_TTL_MS);
          if (cached?.data) {
            if (!cancelled) {
              setNftMetaMap((prev) => ({ ...prev, [key]: cached.data }));
            }
            continue;
          }
          try {
            const res = await fetch(
              `${base}/v1/proxy/nft-meta?issuer=${encodeURIComponent(item.assetIssuer)}&code=${encodeURIComponent(item.assetCode)}`,
              {
                headers: { "X-Astro-Network": config.network },
                signal: AbortSignal.timeout(8000),
              },
            );
            if (!res.ok) continue;
            const data = (await res.json()) as ClassicNftMeta;
            writeCachedEntry(cacheKey, data, NFT_CACHE_TTL_MS);
            if (!cancelled) {
              setNftMetaMap((prev) => ({ ...prev, [key]: data }));
            }
          } catch {
            // Keep clean fallback card when issuer metadata is unreachable
          }
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [
    visibleClassicNfts,
    nftMetaMap,
    config.apiBaseUrl,
    config.network,
  ]);

  if (!activeAccount) return null;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Top Back Bar */}
      {onBack && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="aw-chip-btn" onClick={onBack}>
            ← Back to Wallet
          </button>
          <span className="glass-pill glass-pill--gold tabular-nums">
            {classicNfts.length} Classic NFTs
          </span>
        </div>
      )}

      {/* Classic Stellar NFTs (0.0000001 / Litemint & SEP-1) */}
      <section className="glass-card" style={{ display: "grid", gap: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <IconNft size={18} />
                <span>Collectible Gallery ({classicNfts.length})</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                Tap any artwork to inspect provenance, edition &amp; collection
              </div>
            </div>
            {filteredClassicNfts.length > 0 && (
              <span className="glass-pill glass-pill--gold tabular-nums">
                {visibleClassicNfts.length} / {filteredClassicNfts.length}
              </span>
            )}
          </div>

          {classicNfts.length > 6 && (
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <span
                style={{
                  position: "absolute",
                  left: 12,
                  display: "inline-flex",
                  color: "var(--aw-ink-secondary)",
                  pointerEvents: "none",
                }}
              >
                <IconSearch size={15} />
              </span>
              <input
                type="search"
                className="aw-input"
                style={{ paddingLeft: 36 }}
                placeholder="Filter collectibles by name, code, or creator..."
                value={nftSearch}
                onChange={(e) => {
                  setNftSearch(e.target.value);
                  setVisibleCount(NFT_BATCH_SIZE);
                }}
              />
            </div>
          )}

          {filteredClassicNfts.length === 0 ? (
            <div className="aw-banner" style={{ fontSize: 12 }}>
              {classicNfts.length === 0
                ? `No Classic 1-stroop Stellar NFTs held by ${activeAccount.label}.`
                : "No Classic NFTs match that search filter."}
            </div>
          ) : (
            <>
              <div className="aw-nft-grid">
                {visibleClassicNfts.map((item) => {
                  const key = `${item.assetCode}:${item.assetIssuer ?? ""}`;
                  const meta = nftMetaMap[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      className="aw-nft-card aw-nft-card--interactive"
                      onClick={() => {
                        if (item.assetIssuer && onSelectClassicNft) {
                          onSelectClassicNft({
                            assetCode: item.assetCode,
                            assetIssuer: item.assetIssuer,
                            meta,
                          });
                        }
                      }}
                    >
                      <div className="aw-nft-media">
                        {meta?.image ? (
                          <img
                            src={meta.image}
                            alt={meta.name ?? item.assetCode}
                            loading="lazy"
                          />
                        ) : (
                          <div className="aw-nft-fallback">
                            <IconNft size={22} />
                            <span>{item.assetCode}</span>
                          </div>
                        )}
                      </div>

                      <div style={{ minWidth: 0, display: "grid", gap: 2, textAlign: "left" }}>
                        <div className="aw-nft-title" title={meta?.name ?? item.assetCode}>
                          {meta?.name ?? item.assetCode}
                        </div>
                        <div className="aw-nft-sub">
                          {meta?.homeDomain ??
                            (item.assetIssuer
                              ? `${item.assetIssuer.slice(0, 6)}…${item.assetIssuer.slice(-4)}`
                              : "Stellar Asset")}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {hasMoreNfts && (
                <div
                  ref={sentinelRef}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    gap: 8,
                    padding: "10px 0",
                    fontSize: 12,
                    color: "var(--aw-ink-secondary)",
                  }}
                >
                  <span>
                    Loading more collectibles… ({visibleClassicNfts.length} / {filteredClassicNfts.length})
                  </span>
                  {typeof IntersectionObserver === "undefined" && (
                    <button
                      type="button"
                      className="aw-btn-secondary"
                      onClick={() =>
                        setVisibleCount((prev) =>
                          Math.min(prev + NFT_BATCH_SIZE, filteredClassicNfts.length),
                        )
                      }
                    >
                      Load More
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
    </div>
  );
}
