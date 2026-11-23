import { useMemo, useState } from "react";
import type { ScanReport } from "@astrowallet/domain";
import {
  buildHumanClearSignSummary,
  decodeTransactionEnvelope,
} from "@astrowallet/security-shield";

/**
 * Plain-English Clear-Sign Action Card with net balance delta chips
 * and a collapsible Pro Raw XDR / Operation Inspector.
 */
export function ClearSignSummaryCard({
  unsignedXdr,
  networkPassphrase,
  scanReport,
  overrideSummary,
  isSponsored,
}: {
  unsignedXdr: string;
  networkPassphrase: string;
  scanReport: ScanReport | null;
  overrideSummary?: string | undefined;
  isSponsored?: boolean | undefined;
}) {
  const [showInspector, setShowInspector] = useState(false);

  const summary = useMemo(() => {
    try {
      const decoded = decodeTransactionEnvelope(unsignedXdr, networkPassphrase);
      return {
        decoded,
        human: buildHumanClearSignSummary({
          decoded,
          balanceDiffs: scanReport?.balanceDiffs,
          findings: scanReport?.findings ?? [],
          verdict: scanReport?.verdict ?? "benign",
          isSponsored,
          overrideSummary,
        }),
      };
    } catch {
      return null;
    }
  }, [unsignedXdr, networkPassphrase, scanReport, isSponsored, overrideSummary]);

  if (!summary) return null;

  const { decoded, human } = summary;
  const isDanger = human.actionCategory === "danger";

  return (
    <div
      className="glass-card"
      style={{
        display: "grid",
        gap: 10,
        padding: 12,
        borderColor: isDanger
          ? "rgba(241, 90, 36, 0.55)"
          : "rgba(165, 139, 224, 0.30)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aw-nebula-lavender)", fontWeight: 700 }}>
            Human Clear-Sign Summary
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2, overflowWrap: "anywhere" }}>
            {human.headline}
          </div>
        </div>
        <span
          className={
            isDanger
              ? "glass-pill glass-pill--danger"
              : "glass-pill glass-pill--trust"
          }
          style={{ fontSize: 11, flexShrink: 0 }}
        >
          {human.actionCategory.toUpperCase()}
        </span>
      </div>

      {human.netChanges.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {human.netChanges.map((chg, idx) => (
            <span
              key={`${chg.asset}-${idx}`}
              className="glass-pill tabular-nums"
              style={{
                fontSize: 12,
                fontWeight: 700,
                borderColor:
                  chg.direction === "in"
                    ? "rgba(16, 185, 129, 0.45)"
                    : "rgba(241, 90, 36, 0.45)",
                color: chg.direction === "in" ? "#6EE7B7" : "#FDBA74",
              }}
            >
              {chg.delta} {chg.asset}
            </span>
          ))}
        </div>
      )}

      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 12, color: "var(--aw-ink-secondary)" }}>
        {human.plainSteps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ul>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 11, color: "var(--aw-ink-secondary)" }}>
        <span className="tabular-nums">{human.feeLabel}</span>
        <button
          type="button"
          className="aw-chip-btn"
          style={{ fontSize: 11, minHeight: 32, padding: "4px 10px" }}
          onClick={() => setShowInspector((prev) => !prev)}
        >
          {showInspector ? "Hide Raw XDR" : "Pro Inspector · Raw XDR"}
        </button>
      </div>

      {showInspector && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            borderRadius: 10,
            background: "rgba(11, 20, 51, 0.85)",
            border: "1px solid rgba(165, 139, 224, 0.22)",
            fontSize: 11,
            overflowX: "auto",
            maxHeight: 180,
          }}
        >
          {JSON.stringify(
            {
              sourceAccount: decoded.sourceAccount,
              operations: decoded.operations.map((o) => ({
                type: o.type,
                sorobanFn: o.soroban?.functionName,
                contractId: o.soroban?.contractId,
              })),
            },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}
