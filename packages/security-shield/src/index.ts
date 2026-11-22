import type {
  BalanceDiff,
  ScanReport,
  ScannerPort,
  SecurityFinding,
  StellarAddress,
} from "@astrowallet/domain";
import {
  decodeTransactionEnvelope,
  type DecodedSorobanInvocation,
} from "./decoder.js";
import type { RawXdrInspectRequest, RawXdrInspectResponse } from "./raw-xdr.worker.js";
import {
  classifyVerdict,
  evaluateDecodedTransaction,
  extractBaseDestination,
  type DirectoryTagEntry,
  type VerifiedAssetEntry,
} from "./rules.js";
import { fetchSep42VerifiedAssets } from "./sep42.js";
import { simulateSorobanTransaction } from "./simulator.js";

export * from "./decoder.js";
export * from "./rules.js";
export * from "./sep42.js";
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
  fetchFn?: typeof fetch | undefined;
}

export interface SecurityShieldHandle {
  readonly config: SecurityShieldConfig;
  createScanner(): ScannerPort;
}

function collectSorobanContractIds(
  inv: DecodedSorobanInvocation,
  out: Set<string>,
): void {
  if (inv.contractId) {
    out.add(inv.contractId);
  }
  for (const sub of inv.subInvocations) {
    collectSorobanContractIds(sub, out);
  }
}

let workerReqSeq = 1;

/**
 * Inspects a raw transaction XDR inside a lazy-loaded Web Worker (falling back to inline decode
 * in non-Worker environments).
 */
export async function inspectRawXdrInWorker(
  xdrBase64: string,
  networkPassphrase: string,
): Promise<string> {
  if (typeof Worker === "undefined") {
    const decoded = decodeTransactionEnvelope(xdrBase64, networkPassphrase);
    return JSON.stringify(decoded, null, 2);
  }

  try {
    const worker = new Worker(new URL("./raw-xdr.worker.js", import.meta.url), {
      type: "module",
    });
    const id = workerReqSeq;
    workerReqSeq += 1;

    return await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        worker.terminate();
      };

      worker.onmessage = (event: MessageEvent<RawXdrInspectResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          reject(new Error(event.data.error));
          return;
        }
        resolve(event.data.jsonPretty);
      };

      worker.onerror = () => {
        cleanup();
        try {
          const decoded = decodeTransactionEnvelope(xdrBase64, networkPassphrase);
          resolve(JSON.stringify(decoded, null, 2));
        } catch (err) {
          reject(err);
        }
      };

      const req: RawXdrInspectRequest = { id, xdrBase64, networkPassphrase };
      worker.postMessage(req);
    });
  } catch {
    const decoded = decodeTransactionEnvelope(xdrBase64, networkPassphrase);
    return JSON.stringify(decoded, null, 2);
  }
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
    fetchFn: config.fetchFn,
  });

  return {
    config: frozenConfig,
    createScanner(): ScannerPort {
      return {
        async scanTransactionXdr(
          xdrBase64: string,
          sourceAddress?: StellarAddress,
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

          let hasSorobanOp = false;
          for (const op of decoded.operations) {
            if (op.destination) {
              addressesToInspect.add(op.destination);
              addressesToInspect.add(extractBaseDestination(op.destination));
            }
            if (op.soroban) {
              collectSorobanContractIds(op.soroban, addressesToInspect);
            }
            if (op.type === "invokeHostFunction" || op.type === "extendFootprintTtl") {
              hasSorobanOp = true;
            }
          }

          const fetchFn = frozenConfig.fetchFn ?? fetch;

          const [resolvedVerifiedAssets, sorobanSim] = await Promise.all([
            frozenConfig.verifiedAssets !== undefined
              ? Promise.resolve(frozenConfig.verifiedAssets)
              : frozenConfig.sep42AssetListUrls.length > 0
                ? fetchSep42VerifiedAssets(frozenConfig.sep42AssetListUrls, { fetchFn })
                : Promise.resolve(undefined),
            hasSorobanOp && frozenConfig.rpcUrls.length > 0
              ? simulateSorobanTransaction(
                  frozenConfig.rpcUrls,
                  xdrBase64,
                  fetchFn,
                  frozenConfig.networkPassphrase,
                )
              : Promise.resolve(null),
            Promise.all(
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
            ),
          ]);

          const simulatedBalanceDiffs: BalanceDiff[] | undefined =
            sorobanSim && sorobanSim.balanceDiffs.length > 0
              ? sorobanSim.balanceDiffs
              : undefined;

          const baseReport = evaluateDecodedTransaction(decoded, {
            networkPassphrase: frozenConfig.networkPassphrase,
            directoryEntries: directoryMap,
            verifiedAssets: resolvedVerifiedAssets,
            memoRequiredDestinations: memoRequiredSet,
            simulatedBalanceDiffs,
          });

          const extraFindings: SecurityFinding[] = [...baseReport.findings];
          if (
            sourceAddress &&
            decoded.sourceAccount !== sourceAddress &&
            decoded.feeSource !== sourceAddress
          ) {
            extraFindings.push({
              code: "SOURCE_ACCOUNT_MISMATCH",
              severity: "malicious",
              title: "Source Account Mismatch Blocked",
              description: `Transaction source (${decoded.sourceAccount}) does not match expected signer (${sourceAddress}).`,
              blocksSigning: true,
            });
          }

          if (!sorobanSim) {
            return {
              ...baseReport,
              verdict: classifyVerdict(extraFindings),
              findings: extraFindings,
            };
          }

          if (!sorobanSim.ok) {
            const failClosed = /\bpublic\b/i.test(frozenConfig.networkPassphrase);
            extraFindings.push({
              code: "SOROBAN_SIMULATION_FAILED",
              severity: failClosed ? "malicious" : "warning",
              title: "Soroban RPC Simulation Warning",
              description: sorobanSim.error ?? "Unable to simulate Soroban invocation",
              blocksSigning: failClosed,
            });
          } else if (sorobanSim.requiresProtocol23Restore) {
            extraFindings.push({
              code: "SOROBAN_TTL_RESTORE_REQUIRED",
              severity: "warning",
              title: "Soroban State Restore Required",
              description:
                "Contract storage entry expired and requires Protocol 23 auto-restore before execution.",
              blocksSigning: false,
            });
          }

          let estimatedFeeStroops = baseReport.estimatedFeeStroops;
          if (/^\d+$/.test(sorobanSim.minResourceFeeStroops)) {
            estimatedFeeStroops = (
              BigInt(baseReport.estimatedFeeStroops) +
              BigInt(sorobanSim.minResourceFeeStroops)
            ).toString();
          }

          return {
            ...baseReport,
            verdict: classifyVerdict(extraFindings),
            findings: extraFindings,
            estimatedFeeStroops,
            ...(sorobanSim.assembledXdr ? { assembledXdr: sorobanSim.assembledXdr } : {}),
          };
        },

        async scanAddress(address: StellarAddress): Promise<ScanReport> {
          const findings: SecurityFinding[] = [];
          let requiresMemoCheck = false;
          const lookupAddr = extractBaseDestination(address);

          if (frozenConfig.directoryLookup) {
            const entry =
              (await frozenConfig.directoryLookup(lookupAddr).catch(() => null)) ??
              (lookupAddr !== address
                ? await frozenConfig.directoryLookup(address).catch(() => null)
                : null);

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
                  description:
                    "Always include a deposit Memo or M... muxed address when sending to this exchange.",
                  blocksSigning: false,
                });
              }
            }
          }

          if (frozenConfig.memoRequiredLookup) {
            const sep29 = await frozenConfig
              .memoRequiredLookup(lookupAddr)
              .catch(() => false);
            if (sep29 && !requiresMemoCheck) {
              requiresMemoCheck = true;
              findings.push({
                code: "SEP29_MEMO_REQUIRED",
                severity: "warning",
                title: "SEP-29 config.memo_required Enabled",
                description:
                  "This account enforces SEP-29 memo_required on incoming transfers.",
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
