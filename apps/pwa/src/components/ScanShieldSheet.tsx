import { useState, type FormEvent } from "react";
import { StellarAddressSchema, type ScanReport } from "@astrowallet/domain";
import {
  inspectRawXdrInWorker,
  scanTransactionEnvelopeXdr,
} from "@astrowallet/security-shield";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";

export function ScanShieldSheet() {
  const { config, verifiedAssets } = useWallet();

  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [analyzedXdr, setAnalyzedXdr] = useState<string | null>(null);
  const [rawDecodedJson, setRawDecodedJson] = useState<string | null>(null);
  const [showRawInspector, setShowRawInspector] = useState(false);

  const handleAnalyze = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = target.trim();
    if (!cleaned) return;

    setBusy(true);
    setError(null);
    setReport(null);
    setAnalyzedXdr(null);
    setRawDecodedJson(null);
    setShowRawInspector(false);

    const isAddress = StellarAddressSchema.safeParse(cleaned).success;

    try {
      // 1. Try server-assisted directory + SEP-29 + XDR scan first
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/proxy/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": config.network,
        },
        body: JSON.stringify({ target: cleaned }),
      }).catch(() => null);

      if (res && res.ok) {
        const body = (await res.json()) as {
          report: ScanReport;
        };
        setReport(body.report);
        if (!isAddress) {
          setAnalyzedXdr(cleaned);
        }
        return;
      }

      if (isAddress) {
        throw new Error(
          "Directory & SEP-29 address lookup requires server connection (/v1/proxy/scan unreachable).",
        );
      }

      // 2. Offline / local zero-WASM fallback for XDR envelopes
      const local = scanTransactionEnvelopeXdr(cleaned, {
        networkPassphrase: config.networkPassphrase,
        verifiedAssets,
      });
      setReport(local.report);
      if (!isAddress) {
        setAnalyzedXdr(cleaned);
      }
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

  const handleToggleRawInspector = async () => {
    if (showRawInspector) {
      setShowRawInspector(false);
      return;
    }
    setShowRawInspector(true);
    if (!rawDecodedJson && analyzedXdr) {
      setWorkerBusy(true);
      try {
        const pretty = await inspectRawXdrInWorker(analyzedXdr, config.networkPassphrase);
        setRawDecodedJson(pretty);
      } catch (err) {
        setRawDecodedJson(
          `Worker inspection failed: ${err instanceof Error ? err.message : "Invalid XDR"}`,
        );
      } finally {
        setWorkerBusy(false);
      }
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Scan and Shield Analyzer"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, minWidth: 0 }}>
        <AstroNavigatorAvatar
          seedKey="scan-shield-engine"
          kind="smart"
          state="shield"
          size={56}
        />
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Scan &amp; Shield Pre-Sign Analyzer
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            Zero-WASM XDR decoder • SEP-29 memo guard • Anti-drainer AST rules
          </div>
        </div>
      </div>

      <form
        onSubmit={handleAnalyze}
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10, minWidth: 0 }}
      >
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
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10, minWidth: 0 }}>
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
            {report.balanceDiffs.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Simulated Balance Diffs:</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {report.balanceDiffs.map((diff, idx) => (
                    <li key={`${diff.address}-${diff.assetCode}-${idx}`}>
                      <code>
                        {diff.address.slice(0, 6)}…{diff.address.slice(-4)}
                      </code>
                      : <strong className="tabular-nums">{diff.delta} {diff.assetCode}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {analyzedXdr && (
            <div>
              <button
                type="button"
                className="aw-chip-btn"
                disabled={workerBusy}
                onClick={() => void handleToggleRawInspector()}
              >
                {workerBusy
                  ? "Inspecting in Web Worker..."
                  : showRawInspector
                    ? "Hide Raw XDR Inspector"
                    : "Open Raw XDR Inspector"}
              </button>
              {showRawInspector && rawDecodedJson && (
                <pre className="aw-code-block" style={{ marginTop: 8 }}>
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
