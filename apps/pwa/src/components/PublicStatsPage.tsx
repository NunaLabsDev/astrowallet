import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";
import { formatCompactNumber } from "./token-catalog.js";

interface VerifiedTxEntry {
  txHash: string;
  actionType: string;
  assetCode?: string;
  amountEst?: string;
  createdAt: number;
}

interface DailyPoint {
  day: string;
  dau: number;
  events: number;
}

interface WalletMetricsPayload {
  ok: boolean;
  service: string;
  network: "mainnet" | "testnet";
  generatedAt: string;
  ecosystem?: {
    astroDexApiBaseUrl?: string | null;
    tgBotUsername?: string;
  };
  metrics: {
    totalRegisteredUsers: number;
    totalLinkedWallets: number;
    classicWallets: number;
    smartWallets: number;
    encryptedVaultBackups: number;
    confirmedIntents: number;
    approvedConnectRequests: number;
    relayTxCount: number;
    verifiedTxCount: number;
    dau: number;
    wau: number;
    mau: number;
    dailySeries: DailyPoint[];
    platforms: Record<string, number>;
    eventBreakdown: Record<string, number>;
    recentVerifiedTxs: VerifiedTxEntry[];
  };
}

interface DexMetricsPayload {
  ok: boolean;
  service: string;
  network: "mainnet" | "testnet";
  generatedAt: string;
  metrics: {
    totalPairs: number;
    totalTokens: number;
    confirmedIntents: number;
    verifiedTxCount: number;
    dau: number;
    wau: number;
    mau: number;
    dailySeries: DailyPoint[];
    platforms: Record<string, number>;
    eventBreakdown: Record<string, number>;
    recentVerifiedTxs: VerifiedTxEntry[];
  };
}

type NetworkScope = "all" | "mainnet" | "testnet";

function mergeDailySeries(lists: DailyPoint[][]): DailyPoint[] {
  const map = new Map<string, DailyPoint>();
  for (const list of lists) {
    for (const p of list) {
      const prev = map.get(p.day) ?? { day: p.day, dau: 0, events: 0 };
      prev.dau += p.dau;
      prev.events += p.events;
      map.set(p.day, prev);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function ActivityTrendChart({ series }: { series: DailyPoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || series.length === 0) return undefined;

    const chart = createChart(el, {
      width: Math.max(240, el.clientWidth),
      height: 220,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(226, 232, 240, 0.78)",
        fontFamily: "inherit",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(165, 139, 224, 0.10)" },
        horzLines: { color: "rgba(165, 139, 224, 0.12)" },
      },
      timeScale: {
        borderColor: "rgba(165, 139, 224, 0.18)",
        minBarSpacing: 2,
      },
      rightPriceScale: {
        borderColor: "rgba(165, 139, 224, 0.18)",
        scaleMargins: { top: 0.12, bottom: 0.24 },
      },
    });

    const dauSeries = chart.addSeries(AreaSeries, {
      lineColor: "#10B981",
      topColor: "rgba(16, 185, 129, 0.34)",
      bottomColor: "rgba(11, 20, 51, 0.02)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    const evSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    evSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    const points = series.map((p) => {
      const sec = Math.floor(Date.parse(`${p.day}T00:00:00Z`) / 1000) as UTCTimestamp;
      return { sec, dau: p.dau, events: p.events };
    });

    dauSeries.setData(points.map((p) => ({ time: p.sec, value: p.dau })));
    evSeries.setData(
      points.map((p) => ({
        time: p.sec,
        value: p.events,
        color: "rgba(128, 80, 200, 0.42)",
      })),
    );
    chart.timeScale().fitContent();

    let hasSized = false;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) {
        chart.applyOptions({ width: Math.floor(w) });
        if (!hasSized) {
          chart.timeScale().fitContent();
          hasSized = true;
        }
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [series]);

  if (series.length === 0) {
    return (
      <div className="aw-empty-state" style={{ padding: "20px 12px" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Telemetry active — collecting daily snapshots</div>
        <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
          30-day DAU &amp; product activity bars populate automatically as users open and transact.
        </div>
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: "100%", height: 220 }} />;
}

export function PublicStatsPage() {
  const [scope, setScope] = useState<NetworkScope>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mainnetData, setMainnetData] = useState<WalletMetricsPayload | null>(null);
  const [testnetData, setTestnetData] = useState<WalletMetricsPayload | null>(null);
  const [dexMainnetData, setDexMainnetData] = useState<DexMetricsPayload | null>(null);
  const [dexTestnetData, setDexTestnetData] = useState<DexMetricsPayload | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const apiBase = (
      (import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin
    ).replace(/\/+$/, "");
    try {
      const [mainRes, testRes] = await Promise.all([
        fetch(`${apiBase}/v1/metrics/public`, { headers: { "X-Astro-Network": "mainnet" } }),
        fetch(`${apiBase}/v1/metrics/public`, { headers: { "X-Astro-Network": "testnet" } }),
      ]);
      const mainJson = mainRes.ok ? ((await mainRes.json()) as WalletMetricsPayload) : null;
      const testJson = testRes.ok ? ((await testRes.json()) as WalletMetricsPayload) : null;
      setMainnetData(mainJson);
      setTestnetData(testJson);

      const envDex = (import.meta.env.VITE_ASTRODEX_API_BASE_URL as string | undefined)?.trim();
      const mainDexBase = mainJson?.ecosystem?.astroDexApiBaseUrl || envDex || "";
      const testDexBase = testJson?.ecosystem?.astroDexApiBaseUrl || envDex || "";

      const [mainDexRes, testDexRes] = await Promise.all([
        mainDexBase
          ? fetch(`${mainDexBase.replace(/\/+$/, "")}/v1/metrics/public`, {
              headers: { "X-Astro-Network": "mainnet" },
            }).catch(() => null)
          : Promise.resolve(null),
        testDexBase
          ? fetch(`${testDexBase.replace(/\/+$/, "")}/v1/metrics/public`, {
              headers: { "X-Astro-Network": "testnet" },
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setDexMainnetData(
        mainDexRes?.ok ? ((await mainDexRes.json()) as DexMetricsPayload) : null,
      );
      setDexTestnetData(
        testDexRes?.ok ? ((await testDexRes.json()) as DexMetricsPayload) : null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load public metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeSources = useMemo(() => {
    const items: WalletMetricsPayload[] = [];
    if ((scope === "all" || scope === "mainnet") && mainnetData) items.push(mainnetData);
    if ((scope === "all" || scope === "testnet") && testnetData) items.push(testnetData);
    return items;
  }, [scope, mainnetData, testnetData]);

  const activeDexSources = useMemo(() => {
    const items: DexMetricsPayload[] = [];
    if ((scope === "all" || scope === "mainnet") && dexMainnetData) {
      items.push(dexMainnetData);
    }
    if ((scope === "all" || scope === "testnet") && dexTestnetData) {
      items.push(dexTestnetData);
    }
    return items;
  }, [scope, dexMainnetData, dexTestnetData]);

  const summary = useMemo(() => {
    const sum = (pick: (m: WalletMetricsPayload["metrics"]) => number) =>
      activeSources.reduce((acc, s) => acc + pick(s.metrics), 0);

    const platforms: Record<string, number> = {};
    const events: Record<string, number> = {};
    for (const s of activeSources) {
      for (const [k, v] of Object.entries(s.metrics.platforms)) {
        platforms[k] = (platforms[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(s.metrics.eventBreakdown)) {
        events[k] = (events[k] ?? 0) + v;
      }
    }

    const txs: Array<VerifiedTxEntry & { network: "mainnet" | "testnet"; source: string }> = [];
    for (const s of activeSources) {
      for (const tx of s.metrics.recentVerifiedTxs) {
        txs.push({ ...tx, network: s.network, source: "AstroWallet" });
      }
    }
    let dexVerifiedTxTotal = 0;
    for (const dex of activeDexSources) {
      dexVerifiedTxTotal += dex.metrics.verifiedTxCount ?? 0;
      for (const tx of dex.metrics.recentVerifiedTxs) {
        txs.push({ ...tx, network: dex.network, source: "AstroDex" });
      }
      for (const [k, v] of Object.entries(dex.metrics.eventBreakdown)) {
        events[`dex:${k}`] = (events[`dex:${k}`] ?? 0) + v;
      }
    }
    txs.sort((a, b) => b.createdAt - a.createdAt);

    return {
      registeredUsers: Math.max(0, ...activeSources.map((s) => s.metrics.totalRegisteredUsers)),
      linkedWallets: Math.max(0, ...activeSources.map((s) => s.metrics.totalLinkedWallets)),
      classicWallets: Math.max(0, ...activeSources.map((s) => s.metrics.classicWallets)),
      smartWallets: Math.max(0, ...activeSources.map((s) => s.metrics.smartWallets)),
      dau: sum((m) => m.dau),
      wau: sum((m) => m.wau),
      mau: sum((m) => m.mau),
      verifiedTxs: sum((m) => m.verifiedTxCount) + dexVerifiedTxTotal,
      connectApprovals: sum((m) => m.approvedConnectRequests),
      vaultBackups: sum((m) => m.encryptedVaultBackups),
      dailySeries: mergeDailySeries([
        ...activeSources.map((s) => s.metrics.dailySeries),
        ...activeDexSources.map((dex) => dex.metrics.dailySeries),
      ]),
      platforms: Object.entries(platforms).sort((a, b) => b[1] - a[1]),
      events: Object.entries(events).sort((a, b) => b[1] - a[1]),
      recentTxs: txs.slice(0, 15),
    };
  }, [activeSources, activeDexSources]);

  const handleExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      scope,
      summary,
      astrowalletMainnet: mainnetData,
      astrowalletTestnet: testnetData,
      astrodexMainnet: dexMainnetData,
      astrodexTestnet: dexTestnetData,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `astro-scf-metrics-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const lines = [
      "section,key,value",
      `summary,registered_telegram_users,${summary.registeredUsers}`,
      `summary,dau,${summary.dau}`,
      `summary,wau,${summary.wau}`,
      `summary,mau,${summary.mau}`,
      `summary,linked_wallets,${summary.linkedWallets}`,
      `summary,classic_wallets,${summary.classicWallets}`,
      `summary,smart_wallets,${summary.smartWallets}`,
      `summary,verified_onchain_txs,${summary.verifiedTxs}`,
      `summary,connect_approvals,${summary.connectApprovals}`,
      `summary,encrypted_vault_backups,${summary.vaultBackups}`,
      ...summary.platforms.map(([k, v]) => `platform,${k},${v}`),
      ...summary.events.map(([k, v]) => `event,${k},${v}`),
      ...summary.recentTxs.map(
        (t) => `verified_tx,${t.network}:${t.source}:${t.actionType},${t.txHash}`,
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `astro-scf-metrics-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="glass-canvas" style={{ minHeight: "100dvh", padding: "16px 12px 48px" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gap: 14 }}>
        <header className="glass-card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <span className="glass-pill glass-pill--gold" style={{ fontSize: 10 }}>
                SCF PROOF OF TRACTION · PRIVACY-FIRST
              </span>
              <h1 style={{ margin: "6px 0 2px", fontSize: 20, fontWeight: 800 }}>
                ASTRO Ecosystem · Live Telemetry
              </h1>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Public, auditable D1 &amp; on-chain metrics · Zero cookies · Monthly-salted SHA-256
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <a href="/" className="aw-btn-secondary" style={{ textDecoration: "none" }}>
                ← Open Wallet
              </a>
              <button type="button" className="aw-btn-secondary" onClick={() => void loadAll()} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
              <button type="button" className="aw-btn-secondary" onClick={handleExportCsv}>
                Export CSV
              </button>
              <button type="button" className="aw-btn-gold" onClick={handleExportJson}>
                Export JSON
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="glass-pill glass-pill--trust" style={{ fontSize: 11 }}>
              ✓ Zero-PII Salted Analytics
            </span>
            <span className="glass-pill glass-pill--gold" style={{ fontSize: 11, color: "#0B1433", fontWeight: 700 }}>
              Ethena USDe / sUSDe &amp; USDT0
            </span>
            <span className="glass-pill" style={{ fontSize: 11 }}>
              Zero-op_no_trust Auto-Escrow
            </span>
            <span className="glass-pill" style={{ fontSize: 11 }}>
              x402 Agentic Payments
            </span>
            <span className="glass-pill" style={{ fontSize: 11 }}>
              MoneyGram SEP-24 &amp; NEAR Intents
            </span>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(["all", "mainnet", "testnet"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className="aw-chip-btn"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
              >
                {s === "all" ? "All Networks" : s.toUpperCase()}
              </button>
            ))}
            {mainnetData?.generatedAt && (
              <span style={{ fontSize: 11, color: "var(--aw-ink-muted)", marginLeft: "auto" }}>
                Updated: {new Date(mainnetData.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </header>

        {error && <div className="aw-banner aw-banner--warn">{error}</div>}

        <section className="aw-token-stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))" }}>
          <div className="glass-card aw-stat-tile">
            <span className="aw-stat-label">Verified Telegram Users</span>
            <strong className="aw-stat-value tabular-nums" style={{ fontSize: 22 }}>
              {formatCompactNumber(summary.registeredUsers)}
            </strong>
            <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
              DAU {summary.dau} · WAU {summary.wau} · MAU {summary.mau}
            </span>
          </div>

          <div className="glass-card aw-stat-tile">
            <span className="aw-stat-label">Linked Stellar Wallets</span>
            <strong className="aw-stat-value tabular-nums" style={{ fontSize: 22 }}>
              {formatCompactNumber(summary.linkedWallets)}
            </strong>
            <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
              {summary.classicWallets} Classic G… · {summary.smartWallets} Smart C…
            </span>
          </div>

          <div className="glass-card aw-stat-tile">
            <span className="aw-stat-label">Verified On-Chain TXs</span>
            <strong className="aw-stat-value tabular-nums" style={{ fontSize: 22 }}>
              {formatCompactNumber(summary.verifiedTxs)}
            </strong>
            <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
              Connect Approvals: {summary.connectApprovals} · Vault Sync: {summary.vaultBackups}
            </span>
          </div>

          <div className="glass-card aw-stat-tile">
            <span className="aw-stat-label">AstroDex Markets</span>
            <strong className="aw-stat-value tabular-nums" style={{ fontSize: 22 }}>
              {activeDexSources[0] ? `${activeDexSources[0].metrics.totalPairs} Pairs` : "—"}
            </strong>
            <span style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }} className="tabular-nums">
              {activeDexSources[0]
                ? `${activeDexSources[0].metrics.totalTokens} Tokens · ${activeDexSources[0].metrics.mau} MAU`
                : "No DEX metrics for selected network scope"}
            </span>
          </div>
        </section>

        <section className="glass-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>30-Day Active Users (Line) &amp; Product Events (Bars)</strong>
            <span className="glass-pill" style={{ fontSize: 10 }}>
              {summary.dailySeries.length} days recorded
            </span>
          </div>
          <ActivityTrendChart series={summary.dailySeries} />
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          <div className="glass-card" style={{ display: "grid", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>Client Platforms (30D)</strong>
            {summary.platforms.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Waiting for first telemetry session ping.
              </div>
            ) : (
              summary.platforms.map(([plat, count]) => (
                <div key={plat} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} className="tabular-nums">
                  <span>{plat}</span>
                  <strong>{count}</strong>
                </div>
              ))
            )}
          </div>

          <div className="glass-card" style={{ display: "grid", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>Product Actions (30D)</strong>
            {summary.events.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                No product events logged in this window yet.
              </div>
            ) : (
              summary.events.slice(0, 10).map(([ev, count]) => (
                <div key={ev} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} className="tabular-nums">
                  <span>{ev}</span>
                  <strong>{count}</strong>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="glass-card" style={{ display: "grid", gap: 10 }}>
          <strong style={{ fontSize: 14 }}>Recent Verifiable On-Chain Transactions</strong>
          {summary.recentTxs.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              No verified transactions logged in this filter yet.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {summary.recentTxs.map((tx) => {
                const explorerBase =
                  tx.network === "mainnet"
                    ? "https://stellar.expert/explorer/public/tx"
                    : "https://stellar.expert/explorer/testnet/tx";
                return (
                  <div
                    key={`${tx.source}:${tx.txHash}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      fontSize: 12,
                      padding: "8px 10px",
                      borderRadius: 12,
                      background: "rgba(8, 17, 46, 0.55)",
                      border: "1px solid rgba(165, 139, 224, 0.16)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="glass-pill" style={{ fontSize: 10 }}>
                        {tx.network.toUpperCase()}
                      </span>
                      <span style={{ fontWeight: 600 }}>{tx.source}</span>
                      <span style={{ color: "var(--aw-ink-secondary)" }}>{tx.actionType}</span>
                      {tx.assetCode && (
                        <span className="tabular-nums">
                          {tx.amountEst ? `${tx.amountEst} ` : ""}
                          {tx.assetCode}
                        </span>
                      )}
                    </div>
                    <a
                      href={`${explorerBase}/${tx.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular-nums"
                      style={{ color: "#F5C928", textDecoration: "none", fontWeight: 600 }}
                    >
                      {tx.txHash.slice(0, 8)}…{tx.txHash.slice(-6)} ↗
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <footer className="glass-card" style={{ fontSize: 11, color: "var(--aw-ink-secondary)", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span>
            Official Telegram Bot MAU counters:{" "}
            <a href="https://t.me/AstroWalletAppBot" target="_blank" rel="noreferrer" style={{ color: "#A58BE0" }}>
              @AstroWalletAppBot
            </a>{" "}
            ·{" "}
            <a href="https://t.me/AstroDexBot" target="_blank" rel="noreferrer" style={{ color: "#A58BE0" }}>
              @AstroDexBot
            </a>
          </span>
          <span>API: /v1/metrics/public · Badge: /v1/metrics/badge.svg</span>
        </footer>
      </div>
    </main>
  );
}
