import { useMemo, useState } from "react";
import {
  AGENT_DERIVATION_INDEX,
  createDefaultAgentBudgetPolicy,
  evaluateAgentSpendRequest,
  parseX402PaymentRequiredHeader,
  type AgentBudgetPolicy,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

const STORAGE_KEY = "astrowallet_x402_agent_policy_v1";

function loadPolicy(network: "testnet" | "mainnet"): AgentBudgetPolicy {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${network}`);
    if (raw) {
      return JSON.parse(raw) as AgentBudgetPolicy;
    }
  } catch {
    // Fallback to default policy
  }
  return createDefaultAgentBudgetPolicy(network);
}

function formatStroopsUsdc(stroops: string): string {
  const n = Number(stroops) / 10_000_000;
  return Number.isFinite(n) ? `$${n.toFixed(4).replace(/\.?0+$/, "")}` : "$0";
}

/**
 * x402 AI Agent Allowance Sheet:
 * Lets users configure daily USDC spending caps, per-call limits, and an instant kill-switch
 * for isolated sub-account m/44'/148'/99' + test live HTTP 402 endpoints (AstroDex Forensic Alpha).
 */
export function AgentBudgetSheet() {
  const { config, activeAccount, accounts } = useWallet();

  const [policy, setPolicy] = useState<AgentBudgetPolicy>(() =>
    loadPolicy(config.network),
  );
  const [probeUrl, setProbeUrl] = useState(() =>
    config.network === "mainnet"
      ? "https://astrodex.pages.dev/v1/agent/forensic-alpha/XLM"
      : "https://astrodex-testnet.pages.dev/v1/agent/forensic-alpha/XLM",
  );
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const agentAccount = useMemo(
    () => accounts.find((a) => a.derivationIndex === AGENT_DERIVATION_INDEX) ?? activeAccount,
    [accounts, activeAccount],
  );

  const savePolicy = (next: AgentBudgetPolicy) => {
    setPolicy(next);
    try {
      localStorage.setItem(`${STORAGE_KEY}:${config.network}`, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  };

  if (!activeAccount) return null;

  const dailyPct = Math.min(
    100,
    Math.round(
      (Number(policy.spentTodayStroops) / Math.max(1, Number(policy.dailyCapStroops))) * 100,
    ),
  );

  const handleProbeX402 = async () => {
    setProbing(true);
    setProbeError(null);
    setProbeResult(null);
    try {
      const parsedUrl = new URL(probeUrl.trim());
      const res = await fetch(parsedUrl.toString(), { method: "GET" });
      if (res.status === 402) {
        const hdr = res.headers.get("PAYMENT-REQUIRED");
        if (!hdr) {
          throw new Error("Server returned HTTP 402 without a PAYMENT-REQUIRED header");
        }
        const terms = parseX402PaymentRequiredHeader(hdr);
        const first = terms.accepts[0];
        if (!first) {
          throw new Error("No payment option in PAYMENT-REQUIRED header");
        }
        const check = evaluateAgentSpendRequest(policy, {
          domain: parsedUrl.hostname,
          network: first.network,
          amountStroops: first.amount,
        });
        setProbeResult(
          `HTTP 402 Terms: ${formatStroopsUsdc(first.amount)} USDC on ${first.network} -> ${first.payTo.slice(0, 6)}…${first.payTo.slice(-4)} · Policy Check: ${check.allowed ? "APPROVED (within cap)" : `BLOCKED (${check.reason})`}`,
        );
      } else if (res.ok) {
        setProbeResult(`HTTP 200 OK (${parsedUrl.hostname})`);
      } else {
        throw new Error(`Endpoint returned HTTP ${res.status}`);
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "x402 probe failed");
    } finally {
      setProbing(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="x402 AI Agent Allowance"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <AstroNavigatorAvatar
            seedKey={`${activeAccount.address}:x402`}
            kind={activeAccount.kind}
            state={policy.enabled ? "zenith" : "shield"}
            size={50}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              AI Agent Budget (x402)
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Zero-XLM Soroban Auth Entries · Isolated Sub-Account #{AGENT_DERIVATION_INDEX}
            </div>
          </div>
        </div>
        <button
          type="button"
          className={policy.enabled ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 38, padding: "6px 12px", fontSize: 12 }}
          onClick={() => savePolicy({ ...policy, enabled: !policy.enabled })}
        >
          {policy.enabled ? "Active" : "Paused"}
        </button>
      </div>

      {agentAccount && (
        <div className="aw-list-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
              Agent Allowance Address (m/44&apos;/148&apos;/{AGENT_DERIVATION_INDEX}&apos;)
            </div>
            <code style={{ fontSize: 12, wordBreak: "break-all" }}>
              {agentAccount.address}
            </code>
          </div>
          <button
            type="button"
            className="aw-chip-btn"
            style={{ minHeight: 34, padding: "4px 10px", fontSize: 11 }}
            onClick={async () => {
              const ok = await copyTextToClipboard(agentAccount.address);
              if (ok) {
                setCopiedKey(true);
                setTimeout(() => setCopiedKey(false), 1800);
              }
            }}
          >
            {copiedKey ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Spent Today (UTC)</span>
          <strong className="tabular-nums">
            {formatStroopsUsdc(policy.spentTodayStroops)} / {formatStroopsUsdc(policy.dailyCapStroops)}
          </strong>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: "rgba(165, 139, 224, 0.18)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${dailyPct}%`,
              background: "linear-gradient(90deg, #8050C8, #F5C928)",
            }}
          />
        </div>
      </div>

      <div className="aw-two-col-inputs">
        <div>
          <label className="aw-label" htmlFor="x402-daily-cap">
            Daily Cap (USDC)
          </label>
          <select
            id="x402-daily-cap"
            className="aw-input tabular-nums"
            value={policy.dailyCapStroops}
            onChange={(e) => savePolicy({ ...policy, dailyCapStroops: e.target.value })}
          >
            <option value="5000000">$0.50 / day</option>
            <option value="20000000">$2.00 / day</option>
            <option value="50000000">$5.00 / day</option>
            <option value="100000000">$10.00 / day</option>
          </select>
        </div>
        <div>
          <label className="aw-label" htmlFor="x402-per-req">
            Max Per Call (USDC)
          </label>
          <select
            id="x402-per-req"
            className="aw-input tabular-nums"
            value={policy.maxPerRequestStroops}
            onChange={(e) => savePolicy({ ...policy, maxPerRequestStroops: e.target.value })}
          >
            <option value="100000">$0.01 max</option>
            <option value="500000">$0.05 max</option>
            <option value="1000000">$0.10 max</option>
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <label className="aw-label" htmlFor="x402-probe-url">
          Test Live x402 Paid Endpoint (AstroDex Forensic Alpha)
        </label>
        <input
          id="x402-probe-url"
          type="url"
          className="aw-input"
          value={probeUrl}
          onChange={(e) => setProbeUrl(e.target.value)}
        />
        <button
          type="button"
          className="aw-btn-secondary"
          disabled={probing}
          onClick={handleProbeX402}
        >
          {probing ? "Inspecting HTTP 402..." : "Inspect x402 Payment Terms"}
        </button>
      </div>

      {probeError && <div className="aw-banner aw-banner--danger">{probeError}</div>}
      {probeResult && <div className="aw-banner">{probeResult}</div>}
    </section>
  );
}
