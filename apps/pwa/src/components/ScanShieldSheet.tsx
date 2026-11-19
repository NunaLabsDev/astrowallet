import { useState, type FormEvent } from "react";
import type { ScanReport } from "@astrowallet/domain";
import { scanTransactionEnvelopeXdr } from "@astrowallet/security-shield";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function ScanShieldSheet() {
  const { config } = useWallet();

  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [rawDecodedJson, setRawDecodedJson] = useState<string | null>(null);
  const [showRawInspector, setShowRawInspector] = useState(false);

  const handleAnalyze = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = target.trim();
    if (!cleaned) return;

    setBusy(true);
    setError(null);
    setReport(null);
    setRawDecodedJson(null);

    try {
      // 1. Try server-assisted directory + SEP-29 + XDR scan first
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/proxy/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: cleaned }),
      }).catch(() => null);

      if (res && res.ok) {
        const body = (await res.json()) as {
          report: ScanReport;
          decoded?: unknown;
        };
        setReport(body.report);
        if (body.decoded) {
          setRawDecodedJson(JSON.stringify(body.decoded, null, 2));
        }
        return;
      }

      // 2. Offline / local zero-WASM fallback for XDR envelopes
      const local = scanTransactionEnvelopeXdr(cleaned, {
        networkPassphrase: config.networkPassphrase,
      });
      setReport(local.report);
      setRawDecodedJson(JSON.stringify(local.decoded, null, 2));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Enter a valid Stellar G.../C... address or Base64 XDR envelope",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card" aria-label="Scan and Shield Analyzer" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey="scan-shield-engine"
          kind="smart"
          state="shield"
          size={56}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Scan &amp; Shield Pre-Sign Analyzer
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Zero-WASM XDR decoder • SEP-29 memo guard • Anti-drainer AST rules
          </div>
        </div>
      </div>

      <form onSubmit={handleAnalyze} style={{ display: "grid", gap: 10 }}>
        <textarea
          className="aw-textarea"
          rows={3}
          placeholder="Paste a Stellar G.../C... address or Base64 Transaction XDR..."
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <button
          type="submit"
          className="aw-btn-primary"
          disabled={busy || target.trim().length < 10}
        >
          {busy ? "Analyzing with Scan & Shield..." : "Inspect Target"}
        </button>
      </form>

      {error && <div className="aw-banner aw-banner--danger">{error}</div>}

      {report && (
        <div style={{ display: "grid", gap: 10 }}>
          <div
            className={
              report.verdict === "malicious"
                ? "aw-banner aw-banner--danger"
                : report.verdict === "warning"
                  ? "aw-banner aw-banner--warn"
                  : "aw-banner"
            }
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              Verdict: {report.verdict.toUpperCase()} ({report.operationsCount} op(s))
            </div>
            {report.requiresMemoCheck && (
              <div style={{ fontSize: 12, color: "var(--aw-stellar-gold)" }}>
                SEP-29 Deposit Memo Required for this destination.
              </div>
            )}
            {report.findings.length === 0 ? (
              <div style={{ fontSize: 12 }}>
                No malicious setOptions, accountMerge drainers, spoofed assets, or directory threats
                found.
              </div>
            ) : (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {report.findings.map((f) => (
                  <li key={f.code}>
                    <strong>{f.title}:</strong> {f.description}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {rawDecodedJson && (
            <div>
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => setShowRawInspector((v) => !v)}
              >
                {showRawInspector ? "Hide Raw XDR Inspector" : "Open Raw XDR Inspector"}
              </button>
              {showRawInspector && (
                <pre
                  style={{
                    marginTop: 8,
                    padding: 10,
                    borderRadius: 12,
                    background: "rgba(11, 20, 51, 0.78)",
                    fontSize: 11,
                    overflowX: "auto",
                    maxHeight: 220,
                  }}
                >
                  {rawDecodedJson}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
