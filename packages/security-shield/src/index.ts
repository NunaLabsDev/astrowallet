import type {
  ScanReport,
  ScannerPort,
  SecurityFinding,
  StellarAddress,
} from "@astrowallet/domain";
import { decodeTransactionEnvelope } from "./decoder.js";
import {
  classifyVerdict,
  evaluateDecodedTransaction,
  type DirectoryTagEntry,
  type VerifiedAssetEntry,
} from "./rules.js";

export * from "./decoder.js";
export * from "./rules.js";
export * from "./simulator.js";

export interface SecurityShieldConfig {
  networkPassphrase?: string | undefined;
  rpcUrls: readonly string[];
  horizonUrls: readonly string[];
  stellarExpertApiBase?: string | undefined;
  sep42AssetListUrls: readonly string[];
  verifiedAssets?: readonly VerifiedAssetEntry[] | undefined;
  directoryLookup?:
    | ((address: string) => Promise<DirectoryTagEntry | null>)
    | undefined;
  memoRequiredLookup?: ((address: string) => Promise<boolean>) | undefined;
}

export interface SecurityShieldHandle {
  readonly config: SecurityShieldConfig;
  createScanner(): ScannerPort;
}

/**
 * Creates a full Scan & Shield engine wired from validated environment configuration.
 */
export function createSecurityShield(config: SecurityShieldConfig): SecurityShieldHandle {
  const frozenConfig: SecurityShieldConfig = Object.freeze({
    networkPassphrase: config.networkPassphrase,
    rpcUrls: [...config.rpcUrls],
    horizonUrls: [...config.horizonUrls],
    stellarExpertApiBase: config.stellarExpertApiBase,
    sep42AssetListUrls: [...config.sep42AssetListUrls],
    verifiedAssets: config.verifiedAssets ? [...config.verifiedAssets] : undefined,
    directoryLookup: config.directoryLookup,
    memoRequiredLookup: config.memoRequiredLookup,
  });

  return {
    config: frozenConfig,
    createScanner(): ScannerPort {
      return {
        async scanTransactionXdr(
          xdrBase64: string,
          _sourceAddress?: StellarAddress,
        ): Promise<ScanReport> {
          if (!frozenConfig.networkPassphrase) {
            throw new Error("networkPassphrase is required to decode transaction XDR");
          }
          const decoded = decodeTransactionEnvelope(
            xdrBase64,
            frozenConfig.networkPassphrase,
          );

          const directoryMap = new Map<string, DirectoryTagEntry>();
          const memoRequiredSet = new Set<string>();

          const addressesToInspect = new Set<string>();
          for (const op of decoded.operations) {
            if (op.destination) addressesToInspect.add(op.destination);
            if (op.soroban?.contractId) addressesToInspect.add(op.soroban.contractId);
          }

          await Promise.all(
            [...addressesToInspect].map(async (addr) => {
              if (frozenConfig.directoryLookup) {
                const entry = await frozenConfig.directoryLookup(addr).catch(() => null);
                if (entry) directoryMap.set(addr, entry);
              }
              if (frozenConfig.memoRequiredLookup) {
                const req = await frozenConfig.memoRequiredLookup(addr).catch(() => false);
                if (req) memoRequiredSet.add(addr);
              }
            }),
          );

          return evaluateDecodedTransaction(decoded, {
            networkPassphrase: frozenConfig.networkPassphrase,
            directoryEntries: directoryMap,
            verifiedAssets: frozenConfig.verifiedAssets,
            memoRequiredDestinations: memoRequiredSet,
          });
        },

        async scanAddress(address: StellarAddress): Promise<ScanReport> {
          const findings: SecurityFinding[] = [];
          let requiresMemoCheck = false;

          if (frozenConfig.directoryLookup) {
            const entry = await frozenConfig.directoryLookup(address).catch(() => null);
            if (entry) {
              if (entry.tags.some((t) => t === "malicious" || t === "unsafe")) {
                findings.push({
                  code: "DIRECTORY_MALICIOUS_ADDRESS",
                  severity: "malicious",
                  title: "Malicious Address Flagged",
                  description: `${address} (${entry.name ?? "Unknown"}) is tagged as ${entry.tags.join(", ")} in StellarExpert Open Directory.`,
                  blocksSigning: true,
                });
              }
              if (entry.tags.includes("exchange") || entry.memoRequired) {
                requiresMemoCheck = true;
                findings.push({
                  code: "EXCHANGE_MEMO_REQUIRED",
                  severity: "warning",
                  title: `Exchange Account (${entry.name ?? "CEX"}) — Memo Required`,
                  description: "Always include a deposit Memo or M... muxed address when sending to this exchange.",
                  blocksSigning: false,
                });
              }
            }
          }

          if (frozenConfig.memoRequiredLookup) {
            const sep29 = await frozenConfig.memoRequiredLookup(address).catch(() => false);
            if (sep29 && !requiresMemoCheck) {
              requiresMemoCheck = true;
              findings.push({
                code: "SEP29_MEMO_REQUIRED",
                severity: "warning",
                title: "SEP-29 config.memo_required Enabled",
                description: "This account enforces SEP-29 memo_required on incoming transfers.",
                blocksSigning: false,
              });
            }
          }

          return {
            verdict: classifyVerdict(findings),
            operationsCount: 0,
            findings,
            balanceDiffs: [],
            requiresMemoCheck,
            estimatedFeeStroops: "0",
          };
        },
      };
    },
  };
}
