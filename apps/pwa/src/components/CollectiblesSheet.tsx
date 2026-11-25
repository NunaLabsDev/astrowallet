import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ContractAddressSchema, type ClassicAddress, type ContractAddress } from "@astrowallet/domain";
import {
  buildSep50TransferXdr,
  fetchSep50Holdings,
  type Sep50CollectibleItem,
  type Sep50HoldingsSnapshot,
} from "@astrowallet/stellar-core";
import { readCachedEntry, writeCachedEntry } from "../state/market-cache.js";
import { useWallet } from "../state/wallet-context.js";
import { partitionWalletBalances } from "./asset-classification.js";
import { IconNft, IconRefresh, IconSearch } from "./Icons.js";

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
const SEP50_CACHE_TTL_MS = 120_000;

export function CollectiblesSheet({
  onBack,
  onSelectClassicNft,
}: CollectiblesSheetProps = {}) {
  const { config, activeAccount, accountState, signAndSubmitRawXdrWithShield, showToast } =
    useWallet();

  const [sep50ContractInput, setSep50ContractInput] = useState(
    () => config.sorobitsContractId ?? "",
  );
  const [sep50ActiveContractId, setSep50ActiveContractId] = useState<ContractAddress | undefined>(
    () => config.sorobitsContractId,
  );
  const [sep50Loading, setSep50Loading] = useState(false);
  const [sep50Error, setSep50Error] = useState<string | null>(null);
  const [sep50Snapshot, setSep50Snapshot] = useState<Sep50HoldingsSnapshot | null>(null);
  const [sep50RefreshNonce, setSep50RefreshNonce] = useState(0);
  const [selectedSep50, setSelectedSep50] = useState<Sep50CollectibleItem | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferTxHash, setTransferTxHash] = useState<string | null>(null);

  useEffect(() => {
    setSep50ContractInput(config.sorobitsContractId ?? "");
    setSep50ActiveContractId(config.sorobitsContractId);
    setSelectedSep50(null);
    setSep50Snapshot(null);
    setSep50Error(null);
    setTransferTo("");
    setTransferError(null);
    setTransferTxHash(null);
  }, [config.sorobitsContractId, config.network, activeAccount?.address]);

  useEffect(() => {
    if (!activeAccount || !sep50ActiveContractId) {
      setSep50Snapshot(null);
      setSep50Loading(false);
      return undefined;
    }

    let cancelled = false;
    const cacheKey = `sep50:${config.network}:${sep50ActiveContractId}:${activeAccount.address}`;
    let hasWarmCache = false;
    if (sep50RefreshNonce === 0) {
      void readCachedEntry<Sep50HoldingsSnapshot>(cacheKey, SEP50_CACHE_TTL_MS).then((hit) => {
        if (!cancelled && hit?.data) {
          hasWarmCache = true;
          setSep50Snapshot(hit.data);
          setSep50Loading(false);
        }
      });
    }

    setSep50Loading(!hasWarmCache);
    setSep50Error(null);

    void fetchSep50Holdings({
      contractId: sep50ActiveContractId,
      ownerAddress: activeAccount.address,
      rpcUrls: config.rpcUrls,
      networkPassphrase: config.networkPassphrase,
      maxItems: 12,
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
    })
      .then((snap) => {
        if (cancelled) return;
        writeCachedEntry(cacheKey, snap, SEP50_CACHE_TTL_MS);
        setSep50Snapshot(snap);
      })
      .catch((err) => {
        if (cancelled) return;
        setSep50Error(
          err instanceof Error ? err.message : "Failed to query Soroban SEP-50 collectibles",
        );
      })
      .finally(() => {
        if (!cancelled) setSep50Loading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeAccount,
    sep50ActiveContractId,
    config.apiBaseUrl,
    config.network,
    config.rpcUrls,
    config.networkPassphrase,
    sep50RefreshNonce,
  ]);

  const handleLoadCustomSep50Contract = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = sep50ContractInput.trim();
    if (!trimmed) {
      setSep50ActiveContractId(undefined);
      setSep50Snapshot(null);
      setSep50Error(null);
      return;
    }
    const parsed = ContractAddressSchema.safeParse(trimmed);
    if (!parsed.success) {
      setSep50Error("Enter a valid 56-character C... Soroban SEP-50 contract ID");
      return;
    }
    setSep50Error(null);
    setSelectedSep50(null);
    setSep50ActiveContractId(parsed.data);
    setSep50RefreshNonce((n) => n + 1);
  };

  const handleTransferSep50 = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedSep50 || !activeAccount) return;
    if (activeAccount.kind !== "classic" || !activeAccount.address.startsWith("G")) {
      setTransferError("Direct SEP-50 transfer requires an active Classic G... signer account.");
      return;
    }
    setTransferBusy(true);
    setTransferError(null);
    setTransferTxHash(null);
    try {
      const built = await buildSep50TransferXdr({
        contractId: selectedSep50.contractId,
        from: activeAccount.address as ClassicAddress,
        to: transferTo.trim(),
        tokenId: selectedSep50.tokenId,
        rpcUrls: config.rpcUrls,
        networkPassphrase: config.networkPassphrase,
      });
      const res = await signAndSubmitRawXdrWithShield(built.unsignedXdr, false);
      setTransferTxHash(res.hash);
      setTransferTo("");
      showToast(`Transferred ${selectedSep50.name} on-chain`);
      setSep50RefreshNonce((n) => n + 1);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "SEP-50 transfer failed");
    } finally {
      setTransferBusy(false);
    }
  };

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

  const fetchedMetaKeysRef = useRef<Set<string>>(new Set());

  // Lazy-resolve real IPFS/TOML metadata for visible Classic NFTs (concurrency 4)
  useEffect(() => {
    if (visibleClassicNfts.length === 0) return undefined;
    let cancelled = false;
    const targets = visibleClassicNfts.filter((item) => {
      if (!item.assetIssuer) return false;
      const key = `${item.assetCode}:${item.assetIssuer}`;
      return !fetchedMetaKeysRef.current.has(key);
    });
    if (targets.length === 0) return undefined;

    for (const t of targets) {
      if (t.assetIssuer) {
        fetchedMetaKeysRef.current.add(`${t.assetCode}:${t.assetIssuer}`);
      }
    }

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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="glass-pill glass-pill--trust tabular-nums">
              {sep50Snapshot?.totalOwned ?? 0} Soroban SEP-50
            </span>
            <span className="glass-pill glass-pill--gold tabular-nums">
              {classicNfts.length} Classic NFTs
            </span>
          </div>
        </div>
      )}

      {/* Sorobits / Soroban SEP-50 NFTs */}
      <section className="glass-card" style={{ display: "grid", gap: 12 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {sep50Snapshot?.collectionName ?? "Soroban SEP-50 Collectibles"}
              {sep50Snapshot?.collectionSymbol ? ` (${sep50Snapshot.collectionSymbol})` : ""}
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
              On-chain Sorobits &amp; SEP-50 Enumerable NFTs ({config.network.toUpperCase()})
            </div>
          </div>
          {sep50ActiveContractId && (
            <button
              type="button"
              className="aw-chip-btn"
              disabled={sep50Loading}
              onClick={() => setSep50RefreshNonce((n) => n + 1)}
            >
              <IconRefresh size={13} />
              <span>{sep50Loading ? "Syncing..." : "Refresh"}</span>
            </button>
          )}
        </div>

        <form
          onSubmit={handleLoadCustomSep50Contract}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            type="text"
            className="aw-input"
            style={{ flex: "1 1 220px", fontFamily: "monospace" }}
            placeholder="SEP-50 Contract ID C... (VITE_SOROBITS_CONTRACT_ID)"
            value={sep50ContractInput}
            onChange={(e) => setSep50ContractInput(e.target.value)}
          />
          <button type="submit" className="aw-btn-secondary" disabled={sep50Loading}>
            Load Collection
          </button>
        </form>

        {sep50Error && (
          <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
            {sep50Error}
          </div>
        )}

        {!sep50ActiveContractId ? (
          <div className="aw-banner" style={{ fontSize: 12 }}>
            No default Sorobits SEP-50 contract configured on this build. Enter any deployed SEP-50{" "}
            <code>C...</code> contract address above to load on-chain NFTs.
          </div>
        ) : sep50Loading && !sep50Snapshot ? (
          <div className="aw-sorobit-grid">
            {[0, 1].map((idx) => (
              <div key={idx} className="aw-sorobit-skeleton">
                <div className="aw-skeleton-art" />
                <div className="aw-skeleton-line" />
                <div className="aw-skeleton-line aw-skeleton-line--short" />
              </div>
            ))}
          </div>
        ) : !sep50Snapshot || sep50Snapshot.items.length === 0 ? (
          <div className="aw-banner" style={{ fontSize: 12 }}>
            No SEP-50 collectibles owned by <code>{activeAccount.label}</code> in contract{" "}
            <code>
              {sep50ActiveContractId.slice(0, 6)}…{sep50ActiveContractId.slice(-4)}
            </code>
            .
          </div>
        ) : (
          <div className="aw-sorobit-grid">
            {sep50Snapshot.items.map((item) => (
              <button
                key={`${item.contractId}:${item.tokenId}`}
                type="button"
                className="aw-sorobit-card aw-sorobit-card--interactive"
                aria-pressed={selectedSep50?.tokenId === item.tokenId}
                onClick={() => {
                  setSelectedSep50(item);
                  setTransferError(null);
                  setTransferTxHash(null);
                }}
              >
                <div className="aw-sorobit-media">
                  {item.image ? (
                    <img src={item.image} alt={item.name} loading="lazy" />
                  ) : (
                    <div className="aw-nft-fallback">
                      <IconNft size={26} />
                      <span>#{item.tokenId}</span>
                    </div>
                  )}
                  <span className="aw-sorobit-badge">
                    {item.soulbound ? "Soulbound" : `#${item.tokenId}`}
                  </span>
                </div>
                <div className="aw-sorobit-info">
                  <div className="aw-sorobit-title">{item.name}</div>
                  <div className="aw-sorobit-meta">
                    <span>{sep50Snapshot.collectionSymbol ?? "SEP-50"}</span>
                    <span>Token #{item.tokenId}</span>
                  </div>
                  {item.traits.length > 0 && (
                    <div className="aw-sorobit-traits">
                      {item.traits.slice(0, 3).map((tr) => (
                        <span key={`${tr.traitType}:${tr.value}`} className="glass-pill">
                          {tr.traitType}: {tr.value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {selectedSep50 && (
          <div
            className="glass-card glass-card--vault"
            style={{ display: "grid", gap: 10, padding: 12 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>
                {selectedSep50.name} (Token #{selectedSep50.tokenId})
              </strong>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => setSelectedSep50(null)}
              >
                Close
              </button>
            </div>

            {selectedSep50.description && (
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                {selectedSep50.description}
              </div>
            )}

            {selectedSep50.traits.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {selectedSep50.traits.map((tr) => (
                  <span key={`${tr.traitType}:${tr.value}`} className="glass-pill">
                    {tr.traitType}: {tr.value}
                  </span>
                ))}
              </div>
            )}

            {selectedSep50.soulbound ? (
              <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                This SEP-50 token is soulbound (`soulbound = true`) and cannot be transferred.
              </div>
            ) : (
              <form onSubmit={handleTransferSep50} style={{ display: "grid", gap: 8 }}>
                <label className="aw-label" htmlFor="sep50-transfer-to">
                  Transfer To Stellar Recipient (G... or C...)
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    id="sep50-transfer-to"
                    type="text"
                    className="aw-input"
                    style={{ flex: "1 1 200px", fontFamily: "monospace" }}
                    placeholder="G... or C..."
                    value={transferTo}
                    onChange={(e) => setTransferTo(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="aw-btn-primary"
                    disabled={transferBusy || !transferTo.trim()}
                  >
                    {transferBusy ? "Signing Transfer..." : "Transfer SEP-50"}
                  </button>
                </div>
                {transferError && (
                  <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
                    {transferError}
                  </div>
                )}
                {transferTxHash && (
                  <div className="aw-banner aw-banner--trust" style={{ fontSize: 12 }}>
                    Transferred! Tx: <code>{transferTxHash}</code>
                  </div>
                )}
              </form>
            )}
          </div>
        )}
      </section>

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
