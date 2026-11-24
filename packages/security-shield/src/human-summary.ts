import type { BalanceDiff, SecurityFinding, ThreatVerdict } from "@astrowallet/domain";
import type { DecodedOperation, DecodedTransactionSummary } from "./decoder.js";

export type ClearSignActionCategory =
  | "payment"
  | "swap"
  | "trustline"
  | "escrow"
  | "orderbook"
  | "soroban"
  | "danger";

export interface ClearSignNetChange {
  asset: string;
  delta: string;
  direction: "in" | "out";
}

export interface HumanClearSignSummary {
  headline: string;
  actionCategory: ClearSignActionCategory;
  plainSteps: readonly string[];
  netChanges: readonly ClearSignNetChange[];
  feeLabel: string;
}

function shortAddr(addr?: string): string {
  if (!addr) return "unknown";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatStroopsToXlmLabel(stroopsStr: string, isSponsored?: boolean): string {
  if (isSponsored) return "Network fee sponsored (0 XLM)";
  const n = Number(stroopsStr);
  if (!Number.isFinite(n) || n <= 0) return "Estimated fee: ~0.00001 XLM";
  const xlm = n / 10_000_000;
  return `Max network fee: ${xlm.toFixed(5).replace(/\.?0+$/, "")} XLM`;
}

function describeSingleOp(op: DecodedOperation): {
  headline: string;
  category: ClearSignActionCategory;
  step: string;
} {
  switch (op.type) {
    case "payment": {
      const code = op.asset?.code ?? "XLM";
      const amt = op.amount ?? "?";
      return {
        headline: `Send ${amt} ${code} to ${shortAddr(op.destination)}`,
        category: "payment",
        step: `Transfer ${amt} ${code} from your account to ${shortAddr(op.destination)}.`,
      };
    }
    case "createAccount": {
      const amt = op.amount ?? "?";
      return {
        headline: `Activate ${shortAddr(op.destination)} with ${amt} XLM`,
        category: "payment",
        step: `Create and fund new Stellar account ${shortAddr(op.destination)} with ${amt} XLM.`,
      };
    }
    case "pathPaymentStrictSend":
    case "pathPaymentStrictReceive": {
      const sendCode = op.sendAsset?.code ?? "XLM";
      const destCode = op.destAsset?.code ?? "XLM";
      return {
        headline: `Swap ${op.amount ?? ""} ${sendCode} → ${destCode}`.trim(),
        category: "swap",
        step: `Execute an atomic Stellar path swap from ${sendCode} into ${destCode}.`,
      };
    }
    case "changeTrust": {
      const code = op.asset?.code ?? "asset";
      const isRemove = op.amount === "0";
      return {
        headline: isRemove ? `Remove ${code} Trustline` : `Activate ${code} Trustline`,
        category: "trustline",
        step: isRemove
          ? `Close your ${code} trustline and reclaim its 0.5 XLM reserve.`
          : `Enable your account to hold and receive ${code} (0.5 XLM reserve).`,
      };
    }
    case "manageBuyOffer":
    case "manageSellOffer":
    case "createPassiveSellOffer":
      return {
        headline: "Place or Update SDEX Limit Order",
        category: "orderbook",
        step: "Submit a Classic Stellar DEX orderbook instruction.",
      };
    case "invokeHostFunction": {
      const fn = op.soroban?.functionName ?? "contract_call";
      const lower = fn.toLowerCase();
      if (lower.includes("swap")) {
        return {
          headline: `Soroban DEX Swap (${fn})`,
          category: "swap",
          step: `Invoke Soroban swap function "${fn}" on ${shortAddr(op.soroban?.contractId)}.`,
        };
      }
      if (lower.includes("claim") || lower.includes("escrow")) {
        return {
          headline: `Claim Escrow (${fn})`,
          category: "escrow",
          step: `Execute "${fn}" on Claim Escrow contract ${shortAddr(op.soroban?.contractId)}.`,
        };
      }
      if (lower === "transfer") {
        return {
          headline: "Soroban Token Transfer",
          category: "payment",
          step: `Transfer tokens via Soroban contract ${shortAddr(op.soroban?.contractId)}.`,
        };
      }
      return {
        headline: `Invoke Soroban Contract (${fn})`,
        category: "soroban",
        step: `Call "${fn}" on Soroban contract ${shortAddr(op.soroban?.contractId)}.`,
      };
    }
    case "extendFootprintTtl":
      return {
        headline: "Extend Soroban State TTL",
        category: "soroban",
        step: "Renew Protocol 23 archival storage lifetime for the target contract.",
      };
    case "restoreFootprint":
      return {
        headline: "Restore Archived Soroban State",
        category: "soroban",
        step: "Restore expired Soroban contract state back to active ledger storage.",
      };
    case "claimClaimableBalance":
      return {
        headline: "Claim Pending Balance",
        category: "escrow",
        step: "Claim a claimable Stellar balance into your account.",
      };
    case "manageData":
      return {
        headline: "Update Account Data Entry",
        category: "soroban",
        step: `Attach or remove a key/value data entry on ${shortAddr(op.source)}.`,
      };
    case "setTrustLineFlags":
      return {
        headline: "Modify Asset Authorization Flags",
        category: "trustline",
        step: "Update issuer trustline authorization or clawback flags.",
      };
    case "setOptions":
    case "accountMerge":
      return {
        headline: `Critical Account Mutation (${op.type})`,
        category: "danger",
        step: `Modifies account signers, thresholds, or merges account balance (${op.type}).`,
      };
    default:
      return {
        headline: `Stellar Operation (${op.type})`,
        category: "soroban",
        step: `Execute ${op.type} on ${shortAddr(op.source)}.`,
      };
  }
}

/**
 * Generates a plain-English Clear-Sign summary for human review before signing.
 */
export function buildHumanClearSignSummary(input: {
  decoded: DecodedTransactionSummary;
  balanceDiffs?: readonly BalanceDiff[] | undefined;
  findings: readonly SecurityFinding[];
  verdict: ThreatVerdict;
  isSponsored?: boolean | undefined;
  overrideSummary?: string | undefined;
}): HumanClearSignSummary {
  const ops = input.decoded.operations;
  const netChanges: ClearSignNetChange[] = (input.balanceDiffs ?? []).map((diff) => {
    const trimmed = diff.delta.trim();
    const direction: "in" | "out" = trimmed.startsWith("-") ? "out" : "in";
    const normalizedDelta =
      direction === "in" && !trimmed.startsWith("+") ? `+${trimmed}` : trimmed;
    return {
      asset: diff.assetCode,
      delta: normalizedDelta,
      direction,
    };
  });

  if (input.verdict === "malicious") {
    const firstBlock =
      input.findings.find((f) => f.blocksSigning || f.severity === "malicious")?.title ??
      "High-risk transaction blocked";
    return {
      headline: `Blocked: ${firstBlock}`,
      actionCategory: "danger",
      plainSteps: [
        "Scan & Shield detected a dangerous operation or spoofed asset.",
        "Signing is disabled to protect your wallet.",
      ],
      netChanges,
      feeLabel: formatStroopsToXlmLabel(input.decoded.feeStroops, input.isSponsored),
    };
  }

  const described = ops.map(describeSingleOp);
  const primary = described.find((d) => d.category !== "trustline") ?? described[0];
  const hasTrustlineAndAction =
    ops.length > 1 && described.some((d) => d.category === "trustline") && primary;

  const plainSteps = described.slice(0, 3).map((d) => d.step);
  if (input.decoded.memo.type !== "none" && input.decoded.memo.value) {
    plainSteps.push(`Memo attached (${input.decoded.memo.type}): "${input.decoded.memo.value}"`);
  }

  const headline = input.overrideSummary?.trim()
    ? input.overrideSummary.trim()
    : hasTrustlineAndAction && primary.category !== "trustline"
      ? `${primary.headline} (+ Trustline)`
      : primary?.headline ?? "Review Stellar Transaction";

  return {
    headline,
    actionCategory: primary?.category ?? "soroban",
    plainSteps:
      plainSteps.length > 0 ? plainSteps : ["Review the simulated balance changes below."],
    netChanges,
    feeLabel: formatStroopsToXlmLabel(input.decoded.feeStroops, input.isSponsored),
  };
}
