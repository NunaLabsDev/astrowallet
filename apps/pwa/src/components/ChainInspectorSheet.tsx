import { useEffect, useState } from "react";
import { partitionWalletBalances } from "./asset-classification.js";
import { IconCheck, IconCopy, IconSearch, IconSend, IconShield } from "./Icons.js";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, triggerTelegramHaptic } from "../telegram/webapp.js";

export type ChainInspectTarget =
  | { kind: "tx"; txHash: string }
  | { kind: "account"; address: string };

export interface ChainInspectorSheetProps {
  target: ChainInspectTarget;
  onSelectTarget: (next: ChainInspectTarget) => void;
  onSwitchOwnAccount?: (derivationIndex: number) => void;
  onSendToAddress?: (destination: string) => void;
}

interface HorizonTxRecord {
  hash: string;
  successful: boolean;
  ledger: number;
  created_at: string;
  fee_charged?: string;
  source_account: string;
  memo?: string;
  memo_type?: string;
  operation_count?: number;
}

interface HorizonOpRecord {
  id: string;
  type: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  starting_balance?: string;
  amount?: string;
  source_amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  buying_asset_code?: string;
  selling_asset_code?: string;
  limit?: string;
  function?: string;
}

interface HorizonAccountInspect {
  id: string;
  subentry_count: number;
  home_domain?: string;
  signers?: Array<{ key: string; weight: number; type: string }>;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
}

interface HorizonPaymentItem {
  id: string;
  transaction_hash: string;
  created_at: string;
  type: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
}

interface ScanApiResult {
  report?: {
    verdict?: "benign" | "warning" | "malicious";
    requiresMemoCheck?: boolean;
    directoryName?: string;
    directoryTags?: string[];
  };
}

async function fetchHorizonJson<T>(horizonUrls: readonly string[], path: string): Promise<T | null> {
  for (const base of horizonUrls) {
    const clean = base.replace(/\/+$/, "");
    try {
      const res = await fetch(`${clean}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      if (res.status === 404) return null;
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      continue;
    }
  }
  throw new Error("Unable to reach Stellar Horizon");
}

function shortStr(value: string, head = 6, tail = 5): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatStroopsToXlm(stroopsRaw?: string): string {
  const num = Number(stroopsRaw ?? "0");
  if (!Number.isFinite(num)) return "0";
  return (num / 10_000_000).toFixed(7).replace(/\.?0+$/, "");
}

export function ChainInspectorSheet({
  target,
  onSelectTarget,
  onSwitchOwnAccount,
  onSendToAddress,
}: ChainInspectorSheetProps) {
  const { config, accounts, activeAccount, showToast } = useWallet();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [txData, setTxData] = useState<HorizonTxRecord | null>(null);
  const [txOps, setTxOps] = useState<HorizonOpRecord[]>([]);

  const [acctData, setAcctData] = useState<HorizonAccountInspect | null>(null);
  const [acctPayments, setAcctPayments] = useState<HorizonPaymentItem[]>([]);
  const [scanVerdict, setScanVerdict] = useState<ScanApiResult["report"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setTxData(null);
      setTxOps([]);
      setAcctData(null);
      setAcctPayments([]);
      setScanVerdict(null);

      try {
        if (target.kind === "tx") {
          const [tx, opsRes] = await Promise.all([
            fetchHorizonJson<HorizonTxRecord>(
              config.horizonUrls,
              `/transactions/${encodeURIComponent(target.txHash)}`,
            ),
            fetchHorizonJson<{ _embedded?: { records?: HorizonOpRecord[] } }>(
              config.horizonUrls,
              `/transactions/${encodeURIComponent(target.txHash)}/operations?limit=25`,
            ).catch(() => null),
          ]);
          if (cancelled) return;
          if (!tx) {
            setError("Transaction not found on Stellar " + config.network.toUpperCase());
            return;
          }
          setTxData(tx);
          setTxOps(opsRes?._embedded?.records ?? []);
        } else {
          const baseApi = config.apiBaseUrl.replace(/\/+$/, "");
          const [acct, paysRes, scanRes] = await Promise.all([
            fetchHorizonJson<HorizonAccountInspect>(
              config.horizonUrls,
              `/accounts/${encodeURIComponent(target.address)}`,
            ),
            fetchHorizonJson<{ _embedded?: { records?: HorizonPaymentItem[] } }>(
              config.horizonUrls,
              `/accounts/${encodeURIComponent(target.address)}/payments?order=desc&limit=10`,
            ).catch(() => null),
            fetch(`${baseApi}/v1/proxy/scan`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Astro-Network": config.network,
              },
              body: JSON.stringify({ target: target.address }),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => (r.ok ? (r.json() as Promise<ScanApiResult>) : null))
              .catch(() => null),
          ]);
          if (cancelled) return;
          setAcctData(acct);
          setAcctPayments(paysRes?._embedded?.records ?? []);
          setScanVerdict(scanRes?.report ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load Stellar data");
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
  }, [target, config.horizonUrls, config.apiBaseUrl, config.network]);

  const handleCopy = async (label: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedKey(label);
      triggerTelegramHaptic("selection");
      showToast(`${label} copied`);
      setTimeout(() => setCopiedKey(null), 1500);
    }
  };

  if (loading) {
    return (
      <div className="glass-card" style={{ padding: 20, textAlign: "center", fontSize: 13 }}>
        Querying Stellar {config.network.toUpperCase()} ledger...
      </div>
    );
  }

  if (error) {
    return <div className="aw-banner aw-banner--danger">{error}</div>;
  }

  if (target.kind === "tx" && txData) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div className="glass-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`glass-pill ${txData.successful ? "glass-pill--trust" : "aw-pill-danger"}`}>
              {txData.successful ? "✓ Confirmed" : "✕ Failed"}
            </span>
            <span className="glass-pill glass-pill--gold">{config.network.toUpperCase()}</span>
          </div>

          <div className="aw-contract-seals" style={{ fontSize: 12 }}>
            <div className="aw-seal-row">
              <span>Tx Hash</span>
              <button
                type="button"
                className="aw-mini-chip"
                onClick={() => void handleCopy("Tx Hash", txData.hash)}
              >
                {copiedKey === "Tx Hash" ? <IconCheck size={12} /> : <IconCopy size={12} />}
                <code>{shortStr(txData.hash, 8, 8)}</code>
              </button>
            </div>
            <div className="aw-seal-row">
              <span>Ledger</span>
              <code className="tabular-nums">#{txData.ledger.toLocaleString()}</code>
            </div>
            <div className="aw-seal-row">
              <span>Timestamp</span>
              <code>{new Date(txData.created_at).toLocaleString()}</code>
            </div>
            <div className="aw-seal-row">
              <span>Source Account</span>
              <button
                type="button"
                className="aw-mini-chip"
                onClick={() => onSelectTarget({ kind: "account", address: txData.source_account })}
              >
                <IconSearch size={11} />
                <code>{shortStr(txData.source_account)}</code>
              </button>
            </div>
            <div className="aw-seal-row">
              <span>Fee Paid</span>
              <code className="tabular-nums">{formatStroopsToXlm(txData.fee_charged)} XLM</code>
            </div>
            {txData.memo && (
              <div className="aw-seal-row">
                <span>Memo ({txData.memo_type ?? "text"})</span>
                <code>{txData.memo}</code>
              </div>
            )}
          </div>
        </div>

        <div className="glass-card" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            Operations ({txOps.length})
          </div>
          {txOps.map((op) => {
            const asset = op.asset_type === "native" ? "XLM" : (op.asset_code ?? "ASSET");
            const fromAddr = op.from ?? op.funder;
            const toAddr = op.to ?? op.account;
            const amt = op.amount ?? op.starting_balance;
            return (
              <div key={op.id} className="aw-list-row" style={{ fontSize: 12 }}>
                <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                  <div style={{ fontWeight: 700 }}>
                    {op.type}
                    {amt ? ` · ${amt} ${asset}` : ""}
                    {op.function ? ` · ${op.function}()` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {fromAddr && (
                      <button
                        type="button"
                        className="aw-mini-chip"
                        onClick={() => onSelectTarget({ kind: "account", address: fromAddr })}
                      >
                        From: {shortStr(fromAddr, 4, 4)}
                      </button>
                    )}
                    {toAddr && (
                      <button
                        type="button"
                        className="aw-mini-chip"
                        onClick={() => onSelectTarget({ kind: "account", address: toAddr })}
                      >
                        To: {shortStr(toAddr, 4, 4)}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (target.kind === "account") {
    const ownAcc = accounts.find((a) => a.address === target.address);
    const normalizedBalances = (acctData?.balances ?? []).map((b) => ({
      assetCode: b.asset_type === "native" ? "XLM" : (b.asset_code ?? "ASSET"),
      assetIssuer: b.asset_issuer,
      balance: b.balance,
    }));
    const { fungible, classicNfts } = partitionWalletBalances(normalizedBalances);
    const xlmBal = fungible.find((b) => b.assetCode === "XLM" && !b.assetIssuer)?.balance ?? "0";

    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div className="glass-card" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="glass-pill glass-pill--gold">
              {ownAcc ? `★ Your Account (${ownAcc.label})` : "Stellar Account"}
            </span>
            {scanVerdict?.verdict && (
              <span
                className={`glass-pill ${
                  scanVerdict.verdict === "malicious"
                    ? "aw-pill-danger"
                    : scanVerdict.verdict === "warning"
                      ? "glass-pill--gold"
                      : "glass-pill--trust"
                }`}
              >
                <IconShield size={11} />
                <span>{scanVerdict.verdict.toUpperCase()}</span>
              </span>
            )}
          </div>

          <div className="aw-contract-seals" style={{ fontSize: 12 }}>
            <div className="aw-seal-row">
              <span>Address</span>
              <button
                type="button"
                className="aw-mini-chip"
                onClick={() => void handleCopy("Address", target.address)}
              >
                {copiedKey === "Address" ? <IconCheck size={12} /> : <IconCopy size={12} />}
                <code>{shortStr(target.address, 8, 8)}</code>
              </button>
            </div>
            {acctData ? (
              <>
                <div className="aw-seal-row">
                  <span>XLM Balance</span>
                  <code className="tabular-nums">{Number(xlmBal).toFixed(4)} XLM</code>
                </div>
                <div className="aw-seal-row">
                  <span>Holdings</span>
                  <code className="tabular-nums">
                    {fungible.length} token(s) · {classicNfts.length} Classic NFT(s) ·{" "}
                    {acctData.subentry_count} subentries
                  </code>
                </div>
                {acctData.home_domain && (
                  <div className="aw-seal-row">
                    <span>Home Domain</span>
                    <code>{acctData.home_domain}</code>
                  </div>
                )}
              </>
            ) : (
              <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                Account not yet activated on Stellar {config.network.toUpperCase()}.
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {ownAcc && onSwitchOwnAccount && activeAccount?.address !== ownAcc.address && (
              <button
                type="button"
                className="aw-btn-primary"
                onClick={() => onSwitchOwnAccount(ownAcc.derivationIndex ?? 0)}
              >
                Switch to {ownAcc.label}
              </button>
            )}
            {onSendToAddress && activeAccount?.address !== target.address && (
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => onSendToAddress(target.address)}
              >
                <IconSend size={14} />
                <span>Send to Account</span>
              </button>
            )}
          </div>
        </div>

        <div className="glass-card" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            Recent Payments ({acctPayments.length})
          </div>
          {acctPayments.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              No recent payments found.
            </div>
          ) : (
            acctPayments.map((p) => {
              const inbound = p.to === target.address || p.account === target.address;
              const counterparty = inbound ? (p.from ?? p.funder) : (p.to ?? p.account);
              const asset = p.asset_type === "native" ? "XLM" : (p.asset_code ?? "ASSET");
              const amt = p.amount ?? p.starting_balance ?? "0";
              return (
                <div key={p.id} className="aw-list-row" style={{ fontSize: 12 }}>
                  <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
                    <div style={{ fontWeight: 700, color: inbound ? "var(--aw-safe-emerald)" : "var(--aw-ink-primary)" }}>
                      {inbound ? "+" : "-"}
                      {amt} {asset}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      {new Date(p.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {counterparty && (
                      <button
                        type="button"
                        className="aw-mini-chip"
                        onClick={() => onSelectTarget({ kind: "account", address: counterparty })}
                      >
                        {inbound ? "From" : "To"}: {shortStr(counterparty, 4, 4)}
                      </button>
                    )}
                    <button
                      type="button"
                      className="aw-mini-chip"
                      onClick={() => onSelectTarget({ kind: "tx", txHash: p.transaction_hash })}
                    >
                      <IconSearch size={11} />
                      <span>Tx {shortStr(p.transaction_hash, 4, 4)}</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return null;
}
