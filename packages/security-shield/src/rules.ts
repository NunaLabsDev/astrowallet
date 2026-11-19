import type {
  BalanceDiff,
  ScanReport,
  SecurityFinding,
  StellarAddress,
  ThreatVerdict,
} from "@astrowallet/domain";
import {
  decodeTransactionEnvelope,
  type DecodedSorobanInvocation,
  type DecodedTransactionSummary,
} from "./decoder.js";

export interface DirectoryTagEntry {
  address: string;
  name?: string | undefined;
  tags: readonly string[];
  memoRequired?: boolean | undefined;
}

export interface VerifiedAssetEntry {
  code: string;
  issuer: string;
}

export interface SecurityRuleContext {
  networkPassphrase: string;
  directoryEntries?: ReadonlyMap<string, DirectoryTagEntry> | undefined;
  verifiedAssets?: readonly VerifiedAssetEntry[] | undefined;
  memoRequiredDestinations?: ReadonlySet<string> | undefined;
  simulatedBalanceDiffs?: readonly BalanceDiff[] | undefined;
}

const PROTECTED_ASSET_SYMBOLS = new Set(["USDC", "EURC", "PYUSD", "AQUA", "BTC", "ETH"]);
const PHISHING_URL_REGEX = /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|io|org|net|xyz|app|gg|me|link|claim|airdrop)\b)/i;

/**
 * Aggregates security findings deterministically into a fail-closed verdict.
 */
export function classifyVerdict(findings: readonly SecurityFinding[]): ThreatVerdict {
  if (findings.some((f) => f.severity === "malicious" || f.blocksSigning)) {
    return "malicious";
  }
  if (findings.some((f) => f.severity === "warning")) {
    return "warning";
  }
  return "benign";
}

function checkSorobanInvocation(
  inv: DecodedSorobanInvocation,
  depth: number,
  directory: ReadonlyMap<string, DirectoryTagEntry> | undefined,
  findings: SecurityFinding[],
): void {
  if (inv.contractId && directory) {
    const entry = directory.get(inv.contractId);
    if (entry?.tags.some((t) => t === "malicious" || t === "unsafe")) {
      findings.push({
        code: "DIRECTORY_MALICIOUS_CONTRACT",
        severity: "malicious",
        title: "Malicious Soroban Contract Flagged",
        description: `Contract ${inv.contractId} is tagged as malicious/unsafe in StellarExpert Directory.`,
        blocksSigning: true,
      });
    }
  }

  const fnLower = inv.functionName.toLowerCase();
  if (fnLower === "approve" || fnLower === "transfer_from") {
    findings.push({
      code: depth > 0 ? "SOROBAN_NESTED_TOKEN_APPROVAL" : "SOROBAN_TOKEN_APPROVAL",
      severity: depth > 0 ? "malicious" : "warning",
      title:
        depth > 0
          ? "Hidden Nested Soroban Token Approval"
          : "Soroban Token Allowance Approval",
      description:
        depth > 0
          ? `A nested sub-invocation attempts to call "${inv.functionName}" on ${inv.contractId ?? "a token contract"}.`
          : `Contract requests "${inv.functionName}" permission. Verify the spender and allowance limit.`,
      blocksSigning: depth > 0,
    });
  }

  for (const sub of inv.subInvocations) {
    checkSorobanInvocation(sub, depth + 1, directory, findings);
  }
}

/**
 * Evaluates a decoded transaction against AstroWallet's deterministic Scan & Shield rules.
 */
export function evaluateDecodedTransaction(
  decoded: DecodedTransactionSummary,
  context: SecurityRuleContext,
): ScanReport {
  const findings: SecurityFinding[] = [];
  const balanceDiffs: BalanceDiff[] = [...(context.simulatedBalanceDiffs ?? [])];
  let requiresMemoCheck = false;

  // Check memo for phishing domains
  if (decoded.memo.value && PHISHING_URL_REGEX.test(decoded.memo.value)) {
    findings.push({
      code: "PHISHING_MEMO_URL",
      severity: "warning",
      title: "Suspicious URL in Transaction Memo",
      description: "Memo contains a web link. Never visit airdrop or claim links found in memos.",
      blocksSigning: false,
    });
  }

  for (const op of decoded.operations) {
    // 1. Malicious setOptions (signer hijack or master key lockout)
    if (op.type === "setOptions") {
      if (op.signerKey && (op.signerWeight ?? 0) > 0) {
        findings.push({
          code: "MALICIOUS_SET_OPTIONS_SIGNER",
          severity: "malicious",
          title: "Account Ownership Takeover Blocked (setOptions)",
          description: `Transaction adds a new co-signer (${op.signerKey}) with weight ${op.signerWeight}. This can surrender control of your account.`,
          blocksSigning: true,
        });
      }
      if (op.masterWeight === 0) {
        findings.push({
          code: "MALICIOUS_SET_OPTIONS_MASTER_LOCKOUT",
          severity: "malicious",
          title: "Master Key Lockout Blocked (masterWeight = 0)",
          description: "Transaction sets your master key weight to 0, permanently locking you out.",
          blocksSigning: true,
        });
      }
      if (
        op.lowThreshold !== undefined ||
        op.medThreshold !== undefined ||
        op.highThreshold !== undefined
      ) {
        findings.push({
          code: "SET_OPTIONS_THRESHOLD_CHANGE",
          severity: "warning",
          title: "Account Multisig Threshold Modification",
          description: "Transaction alters your account signing thresholds.",
          blocksSigning: false,
        });
      }
    }

    // 2. Account Merge drain trap
    if (op.type === "accountMerge") {
      findings.push({
        code: "DANGEROUS_ACCOUNT_MERGE",
        severity: "malicious",
        title: "Account Destruction & Full Balance Drain (accountMerge)",
        description: `Transaction permanently closes your account and sweeps 100% of remaining XLM to ${op.destination ?? "destination"}.`,
        blocksSigning: true,
      });
    }

    // 3. Directory & SEP-29 Exchange Memo checks on destination
    if (op.destination) {
      const dirEntry = context.directoryEntries?.get(op.destination);
      if (dirEntry?.tags.some((t) => t === "malicious" || t === "unsafe")) {
        findings.push({
          code: "DIRECTORY_MALICIOUS_DESTINATION",
          severity: "malicious",
          title: "Known Malicious Destination Blocked",
          description: `Destination ${op.destination} is flagged as ${dirEntry.tags.join(", ")} in StellarExpert Open Directory.`,
          blocksSigning: true,
        });
      }

      const needsMemo =
        Boolean(dirEntry?.memoRequired) ||
        Boolean(dirEntry?.tags.includes("exchange")) ||
        Boolean(context.memoRequiredDestinations?.has(op.destination));

      if (needsMemo) {
        requiresMemoCheck = true;
        const isMuxedDestination = op.destination.startsWith("M");
        const hasMemo = decoded.memo.type !== "none" && Boolean(decoded.memo.value?.trim());
        if (!isMuxedDestination && !hasMemo) {
          findings.push({
            code: "MISSING_SEP29_EXCHANGE_MEMO",
            severity: "malicious",
            title: "Missing Mandatory Exchange Memo (SEP-29)",
            description: `Destination ${dirEntry?.name ?? op.destination} requires a deposit Memo (or M... muxed address). Sending without a memo risks losing funds.`,
            blocksSigning: true,
          });
        }
      }
    }

    // 4. Fake / Spoofed Protected Assets (e.g. fake USDC)
    const assetsToCheck = [op.asset, op.sendAsset, op.destAsset].filter(
      (a): a is NonNullable<typeof a> => a !== undefined,
    );
    for (const asset of assetsToCheck) {
      if (
        asset.code !== "XLM" &&
        asset.issuer &&
        PROTECTED_ASSET_SYMBOLS.has(asset.code.toUpperCase())
      ) {
        const verifiedList = context.verifiedAssets ?? [];
        const isVerified = verifiedList.some(
          (v) =>
            v.code.toUpperCase() === asset.code.toUpperCase() &&
            v.issuer === asset.issuer,
        );
        if (!isVerified) {
          findings.push({
            code: "SPOOFED_PROTECTED_ASSET",
            severity: "malicious",
            title: `Unverified / Fake ${asset.code} Issuer Blocked`,
            description: `Asset ${asset.code} (${asset.issuer}) does not match the verified SEP-42 issuer registry.`,
            blocksSigning: true,
          });
        }
      }
    }

    // 5. Soroban invocation inspection
    if (op.soroban) {
      checkSorobanInvocation(op.soroban, 0, context.directoryEntries, findings);
    }

    // Populate baseline balance diff preview if simulation diffs were not provided
    if (
      context.simulatedBalanceDiffs === undefined &&
      (op.type === "payment" || op.type === "createAccount") &&
      op.amount &&
      op.destination
    ) {
      balanceDiffs.push({
        address: decoded.sourceAccount as StellarAddress,
        assetCode: op.asset?.code ?? "XLM",
        assetIssuer: op.asset?.issuer as StellarAddress | undefined,
        delta: `-${op.amount}`,
      });
    }
  }

  return {
    verdict: classifyVerdict(findings),
    operationsCount: decoded.operations.length,
    findings,
    balanceDiffs,
    requiresMemoCheck,
    estimatedFeeStroops: decoded.feeStroops,
  };
}

/**
 * Decodes and evaluates a raw Base64 XDR transaction envelope in a single step.
 */
export function scanTransactionEnvelopeXdr(
  xdrBase64: string,
  context: SecurityRuleContext,
): { decoded: DecodedTransactionSummary; report: ScanReport } {
  const decoded = decodeTransactionEnvelope(xdrBase64, context.networkPassphrase);
  const report = evaluateDecodedTransaction(decoded, context);
  return { decoded, report };
}

export interface ClaimableBalanceCandidate {
  id: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  amount: string;
  sponsor?: string | undefined;
  memoText?: string | undefined;
}

/**
 * Claimable Balance Spam Shield: hides dust/phishing claimable balances and strips URLs from memos.
 */
export function filterSpamClaimableBalances(
  items: readonly ClaimableBalanceCandidate[],
  options: {
    verifiedAssets?: readonly VerifiedAssetEntry[] | undefined;
    maliciousAddresses?: ReadonlySet<string> | undefined;
    minNativeXlmThreshold?: number | undefined;
  } = {},
): ClaimableBalanceCandidate[] {
  const minXlm = options.minNativeXlmThreshold ?? 0.05;
  const verified = options.verifiedAssets ?? [];
  const malicious = options.maliciousAddresses;

  return items.filter((item) => {
    if (item.sponsor && malicious?.has(item.sponsor)) return false;
    if (item.assetIssuer && malicious?.has(item.assetIssuer)) return false;
    if (item.memoText && PHISHING_URL_REGEX.test(item.memoText)) return false;

    const numAmount = Number(item.amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) return false;

    if (item.assetCode === "XLM" && !item.assetIssuer) {
      return numAmount >= minXlm;
    }

    if (PROTECTED_ASSET_SYMBOLS.has(item.assetCode.toUpperCase())) {
      const ok = verified.some(
        (v) =>
          v.code.toUpperCase() === item.assetCode.toUpperCase() &&
          v.issuer === item.assetIssuer,
      );
      if (!ok) return false;
    }

    return true;
  });
}

export function sanitizeMemoPhishing(memoText: string): string {
  return memoText.replace(PHISHING_URL_REGEX, "[redacted-link]");
}
