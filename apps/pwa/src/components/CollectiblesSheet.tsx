import { useEffect, useMemo, useState } from "react";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { fetchOwnerSorobits, type SorobitCollectible } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import {
  AstroNavigatorAvatar,
  deriveNavigatorTraits,
  type NavigatorState,
} from "./AstroNavigatorAvatar.js";

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
  const [showcaseGenesis, setShowcaseGenesis] = useState<SorobitCollectible | null>(null);

  const traits = useMemo(() => {
    if (!activeAccount) return null;
    return deriveNavigatorTraits(activeAccount.address, activeAccount.kind);
  }, [activeAccount]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (
        !activeAccount ||
        !config.sorobitsContractId ||
        !activeAccount.address.startsWith("G")
      ) {
        setOwnedSorobits([]);
        setShowcaseGenesis(null);
        return;
      }

      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await fetchOwnerSorobits({
          rpcUrls: config.rpcUrls,
          networkPassphrase: config.networkPassphrase,
          contractId: config.sorobitsContractId as ContractAddress,
          ownerAddress: activeAccount.address as ClassicAddress,
          includeShowcaseGenesis: true,
        });
        if (!cancelled) {
          setOwnedSorobits(res.owned);
          setShowcaseGenesis(res.showcaseGenesis);
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
    <div style={{ display: "grid", gap: 14 }}>
      {/* Astro Navigator Guardian Card */}
      <section className="glass-card glass-card--vault" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="aw-pixel-frame">
            <AstroNavigatorAvatar
              seedKey={activeAccount.address}
              kind={activeAccount.kind}
              state={navState}
              size={84}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              Astro Navigator · {activeAccount.label}
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
              Deterministic 32&times;32 Pixel Guardian derived from your public key
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
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

      {/* Live On-Chain Sorobits (SEP-50) Vault */}
      <section className="glass-card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              NunaLabs Sorobits (SEP-50 On-Chain NFTs)
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              100% on-chain 32&times;32 genomic pixel art via Soroban RPC
            </div>
          </div>
          <span className="glass-pill glass-pill--trust">
            {ownedSorobits.length} Owned
          </span>
        </div>

        {!config.sorobitsContractId ? (
          <div className="aw-banner" style={{ fontSize: 12 }}>
            Set <code>VITE_SOROBITS_CONTRACT_ID</code> in environment config to inspect your
            on-chain Sorobits NFTs on {config.network.toUpperCase()}.
          </div>
        ) : loading ? (
          <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
            Querying Sorobits SEP-50 contract on {config.network.toUpperCase()}...
          </div>
        ) : errorMsg ? (
          <div className="aw-banner aw-banner--warn">{errorMsg}</div>
        ) : ownedSorobits.length > 0 ? (
          <div style={{ display: "grid", gap: 10 }}>
            {ownedSorobits.map((item) => (
              <div key={item.tokenId} className="aw-list-row">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="aw-pixel-frame">
                    <img
                      src={item.animatedDataUrl}
                      alt={item.name}
                      width={60}
                      height={60}
                    />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{item.name}</div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      {item.realmName} · Tier {item.rankTier} · {item.xpScore} XP
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      <span className="glass-pill">
                        {item.soulbound ? "Soulbound Pioneer" : `Gen ${item.generation}`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              No Sorobits owned by <code>{activeAccount.address.slice(0, 6)}…{activeAccount.address.slice(-6)}</code> yet.
              Below is Genesis #0 fetched live from the Sorobits contract:
            </div>
            {showcaseGenesis && (
              <div className="aw-list-row">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="aw-pixel-frame">
                    <img
                      src={showcaseGenesis.animatedDataUrl}
                      alt={showcaseGenesis.name}
                      width={64}
                      height={64}
                    />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{showcaseGenesis.name}</div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      {showcaseGenesis.realmName} · Ledger #{showcaseGenesis.bornLedger} ·{" "}
                      {showcaseGenesis.xpScore} XP
                    </div>
                    <span className="glass-pill glass-pill--gold" style={{ marginTop: 4 }}>
                      Live On-Chain Genesis Showcase
                    </span>
                  </div>
                </div>
              </div>
            )}
            <a
              href="https://astrogate.pages.dev/sorobits"
              target="_blank"
              rel="noreferrer"
              className="aw-btn-secondary"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                textDecoration: "none",
              }}
            >
              Explore &amp; Mint Sorobits on AstroGate
            </a>
          </div>
        )}
      </section>
    </div>
  );
}
