import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_DERIVATION_INDEX,
  createDefaultAgentBudgetPolicy,
  evaluateAgentSpendRequest,
  getEffectiveSpentTodayStroops,
  parseX402PaymentRequiredHeader,
  recordAgentSpend,
  type AgentBudgetPolicy,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

const STORAGE_KEY = "astrowallet_x402_agent_policy_v1";

function loadPolicy(
  network: "testnet" | "mainnet",
  configuredHost?: string,
): AgentBudgetPolicy {
  const defaultDomains = configuredHost
    ? Array.from(
        new Set([configuredHost, "astrodex.pages.dev", "astrodex-testnet.pages.dev"]),
      )
    : undefined;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${network}`);
    if (raw) {
      return JSON.parse(raw) as AgentBudgetPolicy;
    }
  } catch {
    // Fallback to default policy
  }
  return createDefaultAgentBudgetPolicy(network, Date.now(), {
    allowedDomains: defaultDomains,
  });
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
  const {
    config,
    activeAccount,
    accounts,
    vaultStatus,
    deriveAgentAccountAddress,
    signAgentX402Challenge,
  } = useWallet();

  const envDexUrl = config.astrodexApiBaseUrl?.trim();

  const configuredDexHost = useMemo(() => {
    try {
      return envDexUrl ? new URL(envDexUrl).hostname : undefined;
    } catch {
      return undefined;
    }
  }, [envDexUrl]);

  const [policy, setPolicy] = useState<AgentBudgetPolicy>(() =>
    loadPolicy(config.network, configuredDexHost),
  );
  const [domainsInput, setDomainsInput] = useState(() => policy.allowedDomains.join(", "));
  const [probeUrl, setProbeUrl] = useState(() => {
    const base = (
      envDexUrl ||
      (config.network === "mainnet"
        ? "https://astrodex.pages.dev"
        : "https://astrodex-testnet.pages.dev")
    ).replace(/\/+$/, "");
    return `${base}/v1/agent/forensic-alpha/XLM`;
  });
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    const next = loadPolicy(config.network, configuredDexHost);
    setPolicy(next);
    setDomainsInput(next.allowedDomains.join(", "));
    const base = (
      envDexUrl ||
      (config.network === "mainnet"
        ? "https://astrodex.pages.dev"
        : "https://astrodex-testnet.pages.dev")
    ).replace(/\/+$/, "");
    setProbeUrl(`${base}/v1/agent/forensic-alpha/XLM`);
  }, [config.network, envDexUrl, configuredDexHost]);

  const derivedAgentAddress = useMemo(
    () => (vaultStatus === "unlocked" ? deriveAgentAccountAddress() : null),
    [vaultStatus, deriveAgentAccountAddress],
  );
  const dedicatedAgentAccount = useMemo(
    () => accounts.find((a) => a.derivationIndex === AGENT_DERIVATION_INDEX) ?? null,
    [accounts],
  );
  const agentAddress = derivedAgentAddress ?? dedicatedAgentAccount?.address ?? null;

  const savePolicy = (next: AgentBudgetPolicy) => {
    setPolicy(next);
    try {
      localStorage.setItem(`${STORAGE_KEY}:${config.network}`, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  };

  if (!activeAccount) return null;

  const effectiveSpentTodayStroops = getEffectiveSpentTodayStroops(policy);
  const dailyPct = Math.min(
    100,
    Math.round(
      (Number(effectiveSpentTodayStroops) / Math.max(1, Number(policy.dailyCapStroops))) * 100,
    ),
  );

  const probingRef = useRef(false);
  const handleProbeX402 = async () => {
    if (probingRef.current) return;
    probingRef.current = true;
    setProbing(true);
    setProbeError(null);
    setProbeResult(null);
    try {
      const parsedUrl = new URL(probeUrl.trim());
      const isLocalHttp =
        parsedUrl.protocol === "http:" &&
        (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
      if (parsedUrl.protocol !== "https:" && !isLocalHttp) {
        throw new Error(
          "Agent endpoints must use https:// (or http://localhost for local development).",
        );
      }
      const timeoutOpt =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(10_000) }
          : {};
      const runProbe = async (
        extraHeaders?: Record<string, string>,
      ): Promise<{
        status: number;
        ok: boolean;
        paymentRequired: string | null;
        paymentResponse: string | null;
        bodyPreview: string;
      }> => {
        if (parsedUrl.protocol === "https:" && config.apiBaseUrl) {
          const proxyRes = await fetch(
            `${config.apiBaseUrl.replace(/\/+$/, "")}/v1/proxy/x402-probe`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Astro-Network": config.network,
              },
              body: JSON.stringify({
                url: parsedUrl.toString(),
                ...(extraHeaders ? { headers: extraHeaders } : {}),
              }),
              ...timeoutOpt,
            },
          );
          const payload = (await proxyRes.json().catch(() => ({}))) as {
            status?: number;
            ok?: boolean;
            paymentRequired?: string | null;
            paymentResponse?: string | null;
            bodyPreview?: string;
            error?: string;
          };
          if (!proxyRes.ok || typeof payload.status !== "number") {
            throw new Error(payload.error ?? `x402 proxy probe failed (${proxyRes.status})`);
          }
          return {
            status: payload.status,
            ok: Boolean(payload.ok),
            paymentRequired: payload.paymentRequired ?? null,
            paymentResponse: payload.paymentResponse ?? null,
            bodyPreview: payload.bodyPreview ?? "",
          };
        }
        const directRes = await fetch(parsedUrl.toString(), {
          method: "GET",
          ...(extraHeaders ? { headers: extraHeaders } : {}),
          ...timeoutOpt,
        });
        return {
          status: directRes.status,
          ok: directRes.ok,
          paymentRequired: directRes.headers.get("PAYMENT-REQUIRED"),
          paymentResponse: directRes.headers.get("PAYMENT-RESPONSE"),
          bodyPreview: await directRes.text().catch(() => ""),
        };
      };

      const res = await runProbe();
      if (res.status === 402) {
        const hdr = res.paymentRequired;
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
        if (!check.allowed) {
          setProbeResult(
            `HTTP 402 Terms: ${formatStroopsUsdc(first.amount)} USDC on ${first.network} -> ${first.payTo.slice(0, 6)}…${first.payTo.slice(-4)} · Policy Check: BLOCKED (${check.reason})`,
          );
          return;
        }
        if (vaultStatus !== "unlocked") {
          setProbeResult(
            `HTTP 402 Terms: ${formatStroopsUsdc(first.amount)} USDC on ${first.network} -> APPROVED by policy. Unlock vault to sign payment proof.`,
          );
          return;
        }
        const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const signed = signAgentX402Challenge({
          x402Version: terms.x402Version,
          network: first.network,
          asset: first.asset,
          amount: first.amount,
          payTo: first.payTo,
          nonce,
        });
        const paymentHeaderName =
          terms.x402Version >= 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
        const paidRes = await runProbe({
          [paymentHeaderName]: signed.paymentHeader,
          "X-PAYMENT": signed.paymentHeader,
        });
        if (paidRes.ok) {
          savePolicy(recordAgentSpend(policy, first.amount));
          const receiptHdr = paidRes.paymentResponse;
          const bodyPreview = paidRes.bodyPreview;
          setProbeResult(
            `HTTP 200 PAID via m/44'/148'/${AGENT_DERIVATION_INDEX}' (${signed.payer.slice(0, 6)}…${signed.payer.slice(-4)} · ${formatStroopsUsdc(first.amount)} USDC) · ${receiptHdr ? "PAYMENT-RESPONSE verified" : "settled"}${bodyPreview ? ` · ${bodyPreview.slice(0, 120)}` : ""}`,
          );
        } else {
          const errText = paidRes.bodyPreview;
          setProbeResult(
            `HTTP 402 Terms: ${formatStroopsUsdc(first.amount)} USDC · Signed by m/44'/148'/${AGENT_DERIVATION_INDEX}' (${signed.payer.slice(0, 6)}…${signed.payer.slice(-4)}) · Status ${paidRes.status}${errText ? ` (${errText.slice(0, 100)})` : ""}`,
          );
        }
      } else if (res.ok) {
        setProbeResult(`HTTP 200 OK (${parsedUrl.hostname})`);
      } else {
        throw new Error(`Endpoint returned HTTP ${res.status}`);
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "x402 probe failed");
    } finally {
      probingRef.current = false;
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

      {agentAddress ? (
        <div className="aw-list-row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
              Isolated Agent Address (m/44&apos;/148&apos;/{AGENT_DERIVATION_INDEX}&apos;)
            </div>
            <code style={{ fontSize: 12, wordBreak: "break-all" }}>
              {agentAddress}
            </code>
          </div>
          <button
            type="button"
            className="aw-chip-btn"
            style={{ minHeight: 34, padding: "4px 10px", fontSize: 11 }}
            onClick={async () => {
              const ok = await copyTextToClipboard(agentAddress);
              if (ok) {
                setCopiedKey(true);
                setTimeout(() => setCopiedKey(false), 1800);
              }
            }}
          >
            {copiedKey ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
          Unlock your vault to derive isolated sub-account m/44&apos;/148&apos;/
          {AGENT_DERIVATION_INDEX}&apos;.
        </div>
      )}

      <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Spent Today (UTC)</span>
          <strong className="tabular-nums">
            {formatStroopsUsdc(effectiveSpentTodayStroops)} /{" "}
            {formatStroopsUsdc(policy.dailyCapStroops)}
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

      <div>
        <label className="aw-label" htmlFor="x402-allowed-domains">
          Allowed Endpoint Domains (comma-separated)
        </label>
        <input
          id="x402-allowed-domains"
          type="text"
          className="aw-input"
          placeholder="astrodex.pages.dev, astrodex-testnet.pages.dev"
          value={domainsInput}
          onChange={(e) => {
            const raw = e.target.value;
            setDomainsInput(raw);
            const parsed = raw
              .split(",")
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean);
            savePolicy({ ...policy, allowedDomains: parsed });
          }}
        />
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
          {probing ? "Executing x402 Flow..." : "Test & Sign Live x402 Call"}
        </button>
      </div>

      {probeError && <div className="aw-banner aw-banner--danger">{probeError}</div>}
      {probeResult && <div className="aw-banner">{probeResult}</div>}
    </section>
  );
}
