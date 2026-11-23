import { useEffect, useMemo, useState } from "react";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import {
  fetchOwnerSorobits,
  fetchSorobitShowcase,
  type SorobitCollectible,
} from "@astrowallet/stellar-core";
import { readCachedEntry, writeCachedEntry } from "../state/market-cache.js";
import { useWallet } from "../state/wallet-context.js";
import { partitionWalletBalances } from "./asset-classification.js";
import {
  AstroNavigatorAvatar,
  deriveNavigatorTraits,
  type NavigatorState,
} from "./AstroNavigatorAvatar.js";
import { IconExternalLink, IconNft, IconSearch, IconSparkles } from "./Icons.js";

const NAVIGATOR_STATES: ReadonlyArray<{ id: NavigatorState; label: string }> = [
  { id: "float", label: "Float" },
  { id: "shield", label: "Shield" },
  { id: "warp", label: "Warp" },
  { id: "vault", label: "Vault" },
  { id: "comms", label: "Comms" },
  { id: "zenith", label: "Zenith" },
];

interface ClassicNftMeta {
  code: string;
  issuer: string;
  homeDomain?: string | undefined;
  ipfsHash?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  image?: string | undefined;
  resolved: boolean;
}

export interface CollectiblesSheetProps {
  onInspectAsset?: (target: {
    assetCode: string;
    assetIssuer?: string | undefined;
    name?: string | undefined;
    domain?: string | undefined;
    icon?: string | undefined;
  }) => void;
  onSendAsset?: (prefill: {
    assetCode: string;
    assetIssuer?: string | undefined;
  }) => void;
}

const NFT_PAGE_SIZE = 12;
const NFT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function CollectiblesSheet({
  onInspectAsset,
  onSendAsset,
}: CollectiblesSheetProps = {}) {
  const { config, activeAccount, accountState } = useWallet();

  const classicNfts = useMemo(
    () => partitionWalletBalances(accountState?.balances ?? []).classicNfts,
    [accountState?.balances],
  );

  const [galleryTab, setGalleryTab] = useState<"classic" | "sorobits">(() =>
    classicNfts.length > 0 ? "classic" : "sorobits",
  );
  const [nftSearch, setNftSearch] = useState("");
  const [nftPage, setNftPage] = useState(0);
  const [nftMetaMap, setNftMetaMap] = useState<Record<string, ClassicNftMeta>>({});

  useEffect(() => {
    if (classicNfts.length > 0) {
      setGalleryTab("classic");
    }
    setNftPage(0);
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

  const totalNftPages = Math.max(1, Math.ceil(filteredClassicNfts.length / NFT_PAGE_SIZE));
  const safeNftPage = Math.min(nftPage, totalNftPages - 1);
  const visibleClassicNfts = useMemo(
    () =>
      filteredClassicNfts.slice(
        safeNftPage * NFT_PAGE_SIZE,
        (safeNftPage + 1) * NFT_PAGE_SIZE,
      ),
    [filteredClassicNfts, safeNftPage],
  );

  // Lazy-resolve real IPFS/TOML metadata for the currently visible Classic NFT page (concurrency 4)
  useEffect(() => {
    if (galleryTab !== "classic" || visibleClassicNfts.length === 0) return undefined;
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
    galleryTab,
    visibleClassicNfts,
    nftMetaMap,
    config.apiBaseUrl,
    config.network,
  ]);

  const [navState, setNavState] = useState<NavigatorState>("float");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [ownedSorobits, setOwnedSorobits] = useState<SorobitCollectible[]>([]);
  const [showcaseSorobits, setShowcaseSorobits] = useState<SorobitCollectible[]>([]);
  const [totalSupply, setTotalSupply] = useState<number>(0);

  const traits = useMemo(() => {
    if (!activeAccount) return null;
    return deriveNavigatorTraits(activeAccount.address, activeAccount.kind);
  }, [activeAccount]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!activeAccount || !config.sorobitsContractId) {
        setOwnedSorobits([]);
        setShowcaseSorobits([]);
        setTotalSupply(0);
        return;
      }

      setLoading(true);
      setErrorMsg(null);
      try {
        const contractId = config.sorobitsContractId as ContractAddress;
        const owned = activeAccount.address.startsWith("G")
          ? (
              await fetchOwnerSorobits({
                rpcUrls: config.rpcUrls,
                networkPassphrase: config.networkPassphrase,
                contractId,
                ownerAddress: activeAccount.address as ClassicAddress,
                includeShowcaseGenesis: false,
              })
            ).owned
          : [];

        if (cancelled) return;
        setOwnedSorobits(owned);

        if (owned.length === 0) {
          const showcase = await fetchSorobitShowcase({
            rpcUrls: config.rpcUrls,
            networkPassphrase: config.networkPassphrase,
            contractId,
            maxTokens: 6,
          });
          if (!cancelled) {
            setShowcaseSorobits(showcase.tokens);
            setTotalSupply(showcase.totalSupply);
          }
        } else {
          setShowcaseSorobits([]);
          setTotalSupply(owned.length);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error ? err.message : "Unable to load on-chain Sorobits",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activeAccount,
    config.sorobitsContractId,
    config.rpcUrls,
    config.networkPassphrase,
  ]);

  if (!activeAccount || !traits) return null;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Gallery Sub-Tabs */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={galleryTab === "classic"}
          onClick={() => setGalleryTab("classic")}
        >
          <IconNft size={14} />
          <span>Classic Stellar NFTs ({classicNfts.length})</span>
        </button>
        <button
          type="button"
          className="aw-chip-btn"
          aria-pressed={galleryTab === "sorobits"}
          onClick={() => setGalleryTab("sorobits")}
        >
          <IconSparkles size={14} />
          <span>Sorobits SEP-50 ({ownedSorobits.length})</span>
        </button>
      </div>

      {/* Classic Stellar NFTs (0.0000001 / Litemint & SEP-1) */}
      {galleryTab === "classic" && (
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
                <span>Classic Stellar NFTs ({classicNfts.length})</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                1-stroop collectibles resolved live from issuer IPFS &amp; stellar.toml
              </div>
            </div>
            {classicNfts.length > 0 && (
              <span className="glass-pill glass-pill--gold">
                Page {safeNftPage + 1} / {totalNftPages}
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
                placeholder="Filter NFTs by code, name, or domain..."
                value={nftSearch}
                onChange={(e) => {
                  setNftSearch(e.target.value);
                  setNftPage(0);
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
                    <article key={key} className="aw-nft-card">
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

                      <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
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

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {onInspectAsset && (
                          <button
                            type="button"
                            className="aw-mini-chip"
                            style={{ flex: 1 }}
                            onClick={() =>
                              onInspectAsset({
                                assetCode: item.assetCode,
                                assetIssuer: item.assetIssuer,
                                name: meta?.name,
                                domain: meta?.homeDomain,
                                icon: meta?.image,
                              })
                            }
                          >
                            Inspect
                          </button>
                        )}
                        {onSendAsset && (
                          <button
                            type="button"
                            className="aw-mini-chip"
                            style={{ flex: 1 }}
                            onClick={() =>
                              onSendAsset({
                                assetCode: item.assetCode,
                                assetIssuer: item.assetIssuer,
                              })
                            }
                          >
                            Send
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              {totalNftPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="aw-btn-secondary"
                    disabled={safeNftPage === 0}
                    onClick={() => setNftPage((p) => Math.max(0, p - 1))}
                  >
                    ← Prev
                  </button>
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                    Showing {safeNftPage * NFT_PAGE_SIZE + 1}–
                    {Math.min((safeNftPage + 1) * NFT_PAGE_SIZE, filteredClassicNfts.length)} of{" "}
                    {filteredClassicNfts.length}
                  </span>
                  <button
                    type="button"
                    className="aw-btn-secondary"
                    disabled={safeNftPage >= totalNftPages - 1}
                    onClick={() => setNftPage((p) => Math.min(totalNftPages - 1, p + 1))}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {galleryTab === "sorobits" && (
        <>
          {/* Astro Navigator Guardian Card */}
          <section className="glass-card glass-card--vault" style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div className="aw-pixel-frame">
                <AstroNavigatorAvatar
                  seedKey={activeAccount.address}
                  kind={activeAccount.kind}
                  state={navState}
                  size={88}
                />
              </div>
              <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span className="glass-pill glass-pill--gold">
                    <IconSparkles size={12} />
                    <span>Guardian Telemetry</span>
                  </span>
                </div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  Astro Navigator · {activeAccount.label}
                </div>
                <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                  Deterministic 32&times;32 Pixel Guardian derived from your public key
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                  <span className="glass-pill glass-pill--gold">{traits.visorName}</span>
                  <span className="glass-pill">{traits.armorName}</span>
                  <span className="glass-pill">{traits.haloName}</span>
                </div>
              </div>
            </div>

            <div>
              <div className="aw-label">Interactive Navigator Telemetry State</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {NAVIGATOR_STATES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="aw-chip-btn"
                    aria-pressed={navState === item.id}
                    onClick={() => setNavState(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Live On-Chain Sorobits (SEP-50) Gallery */}
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
                  <span>NunaLabs Sorobits (SEP-50 On-Chain NFTs)</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                  100% on-chain 32&times;32 genomic pixel art via Stellar Soroban RPC
                </div>
              </div>
              {config.sorobitsContractId && (
                <span className="glass-pill glass-pill--trust">
                  {ownedSorobits.length > 0
                    ? `${ownedSorobits.length} Owned`
                    : `${showcaseSorobits.length} Showcase · ${totalSupply} Supply`}
                </span>
              )}
            </div>

            {!config.sorobitsContractId ? (
              <div className="aw-banner" style={{ fontSize: 12 }}>
                On-chain Sorobits (SEP-50) collectibles are not yet deployed on{" "}
                {config.network.toUpperCase()}. Your deterministic Astro Navigator Guardian above is
                active for this account.
              </div>
            ) : loading ? (
              <div className="aw-sorobit-grid">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="glass-card aw-sorobit-skeleton">
                    <div className="aw-skeleton-art" />
                    <div className="aw-skeleton-line" />
                    <div className="aw-skeleton-line aw-skeleton-line--short" />
                  </div>
                ))}
              </div>
            ) : errorMsg ? (
              <div className="aw-banner aw-banner--warn">{errorMsg}</div>
            ) : ownedSorobits.length > 0 ? (
              <div className="aw-sorobit-grid">
                {ownedSorobits.map((item) => (
                  <article key={item.tokenId} className="glass-card glass-card--vault aw-sorobit-card">
                    <div className="aw-sorobit-media">
                      <img
                        src={item.animatedDataUrl}
                        alt={item.name}
                        width={144}
                        height={144}
                        className="aw-pixel-img"
                      />
                      <span className="glass-pill glass-pill--gold aw-sorobit-badge">
                        {item.soulbound ? `Soulbound #${item.tokenId}` : `Token #${item.tokenId}`}
                      </span>
                    </div>
                    <div className="aw-sorobit-info">
                      <div className="aw-sorobit-title">{item.name}</div>
                      <div className="aw-sorobit-meta">
                        <span>{item.realmName}</span>
                        <span>Ledger #{item.bornLedger.toLocaleString()}</span>
                      </div>
                      <div className="aw-sorobit-traits">
                        <span className="glass-pill">Tier {item.rankTier}</span>
                        <span className="glass-pill">XP {item.xpScore}</span>
                        <span className="glass-pill">Gen {item.generation}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  No Sorobits owned by{" "}
                  <code>
                    {activeAccount.address.slice(0, 6)}…{activeAccount.address.slice(-6)}
                  </code>{" "}
                  yet. Live {config.network.toUpperCase()} Sorobits SEP-50 Showcase:
                </div>

                {showcaseSorobits.length > 0 && (
                  <div className="aw-sorobit-grid">
                    {showcaseSorobits.map((nft) => (
                      <article key={nft.tokenId} className="glass-card glass-card--vault aw-sorobit-card">
                        <div className="aw-sorobit-media">
                          <img
                            src={nft.animatedDataUrl}
                            alt={nft.name}
                            width={144}
                            height={144}
                            className="aw-pixel-img"
                          />
                          <span className="glass-pill glass-pill--gold aw-sorobit-badge">
                            {nft.soulbound ? `Soulbound #${nft.tokenId}` : `#${nft.tokenId}`}
                          </span>
                        </div>
                        <div className="aw-sorobit-info">
                          <div className="aw-sorobit-title">{nft.name}</div>
                          <div className="aw-sorobit-meta">
                            <span>{nft.realmName}</span>
                            <span>Ledger #{nft.bornLedger.toLocaleString()}</span>
                          </div>
                          <div className="aw-sorobit-traits">
                            <span className="glass-pill">Gen {nft.generation}</span>
                            <span className="glass-pill">Tier {nft.rankTier}</span>
                            <span className="glass-pill">XP {nft.xpScore}</span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {config.sorobitsExplorerUrl && (
                  <a
                    href={config.sorobitsExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="aw-btn-secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      textDecoration: "none",
                    }}
                  >
                    <span>Explore &amp; Mint Sorobits on AstroGate</span>
                    <IconExternalLink size={15} />
                  </a>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
