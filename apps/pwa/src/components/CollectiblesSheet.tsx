import { useEffect, useMemo, useState } from "react";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import {
  fetchOwnerSorobits,
  fetchSorobitShowcase,
  type SorobitCollectible,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import {
  AstroNavigatorAvatar,
  deriveNavigatorTraits,
  type NavigatorState,
} from "./AstroNavigatorAvatar.js";
import { IconExternalLink, IconNft, IconSparkles } from "./Icons.js";

const NAVIGATOR_STATES: ReadonlyArray<{ id: NavigatorState; label: string }> = [
  { id: "float", label: "Float" },
  { id: "shield", label: "Shield" },
  { id: "warp", label: "Warp" },
  { id: "vault", label: "Vault" },
  { id: "comms", label: "Comms" },
  { id: "zenith", label: "Zenith" },
];

export function CollectiblesSheet() {
  const { config, activeAccount } = useWallet();

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
          <span className="glass-pill glass-pill--trust">
            {ownedSorobits.length > 0
              ? `${ownedSorobits.length} Owned`
              : `${showcaseSorobits.length} Showcase · ${totalSupply} Supply`}
          </span>
        </div>

        {!config.sorobitsContractId ? (
          <div className="aw-banner" style={{ fontSize: 12 }}>
            Set <code>VITE_SOROBITS_CONTRACT_ID</code> in environment config to inspect your
            on-chain Sorobits NFTs on {config.network.toUpperCase()}.
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
    </div>
  );
}
