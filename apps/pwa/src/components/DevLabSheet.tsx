import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ClassicAddressSchema,
  ContractAddressSchema,
  type ClassicAddress,
  type ContractAddress,
  type ScanReport,
} from "@astrowallet/domain";
import { scanTransactionEnvelopeXdr } from "@astrowallet/security-shield";
import {
  deriveCounterfactualSmartAccount,
  expectedCaip2ChainId,
  publicKeyToRawHex,
  verifyChallengeMessage,
  type DevTemplateKind,
  type SorobanInvokeResult,
  type SorobanSimulationSummary,
  type SorobanTelemetry,
} from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { TonConnectSheet } from "./TonConnectSheet.js";
import {
  IconCheck,
  IconCode,
  IconCopy,
  IconExternalLink,
  IconKey,
  IconPlug,
  IconRefresh,
  IconShield,
  IconTerminal,
  IconZap,
} from "./Icons.js";

type DevSubTab = "network" | "contracts" | "xdr" | "crypto" | "tonconnect";

export function DevLabSheet() {
  const {
    config,
    activeAccount,
    fetchDevTelemetry,
    simulateSorobanCall,
    invokeSorobanWrite,
    simulateRawXdr,
    buildDevTemplateXdr,
    signRawXdrWithShield,
    signAndSubmitRawXdrWithShield,
    submitAccountDataEntry,
    fundAnyTestnetAddress,
    derivePublicKeyPreview,
    signActiveSep53Message,
    showToast,
  } = useWallet();

  const [subTab, setSubTab] = useState<DevSubTab>("network");

  // Network telemetry & Testnet faucet
  const [telemetry, setTelemetry] = useState<SorobanTelemetry | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [faucetTarget, setFaucetTarget] = useState(() => activeAccount?.address ?? "");
  const [faucetBusy, setFaucetBusy] = useState(false);

  // Soroban Contract Caller
  const [contractId, setContractId] = useState(
    () => config.sorobitsContractId ?? config.claimEscrowContractId ?? "",
  );
  const [fnName, setFnName] = useState("total_supply");
  const [argsJson, setArgsJson] = useState("[]");
  const [contractBusy, setContractBusy] = useState(false);
  const [contractSimRes, setContractSimRes] = useState<SorobanSimulationSummary | null>(null);
  const [contractInvokeRes, setContractInvokeRes] = useState<SorobanInvokeResult | null>(null);
  const [contractError, setContractError] = useState<string | null>(null);

  // XDR Lab
  const [rawXdr, setRawXdr] = useState("");
  const [xdrBusy, setXdrBusy] = useState(false);
  const [allowWarnings, setAllowWarnings] = useState(false);
  const [xdrScanReport, setXdrScanReport] = useState<ScanReport | null>(null);
  const [xdrDecodedJson, setXdrDecodedJson] = useState<string | null>(null);
  const [xdrSimRes, setXdrSimRes] = useState<SorobanSimulationSummary | null>(null);
  const [signedXdrOut, setSignedXdrOut] = useState<string | null>(null);
  const [submittedXdrOut, setSubmittedXdrOut] = useState<{
    hash: string;
    ledger: number;
    channel: string;
  } | null>(null);
  const [xdrError, setXdrError] = useState<string | null>(null);

  // Crypto, SEP-53, Derivation & ManageData
  const [sep53Message, setSep53Message] = useState("AstroWallet SEP-53 Verification");
  const [sep53Signature, setSep53Signature] = useState("");
  const [verifyPubkey, setVerifyPubkey] = useState(() => activeAccount?.address ?? "");
  const [verifyMsg, setVerifyMsg] = useState("AstroWallet SEP-53 Verification");
  const [verifySig, setVerifySig] = useState("");
  const [verifyVerdict, setVerifyVerdict] = useState<boolean | null>(null);
  const [derivationCount, setDerivationCount] = useState(5);
  const [dataKeyName, setDataKeyName] = useState("astrowallet.role");
  const [dataKeyValue, setDataKeyValue] = useState("developer");
  const [dataBusy, setDataBusy] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const caip2 = expectedCaip2ChainId(config.network);

  const loadTelemetry = async () => {
    setTelemetryLoading(true);
    setTelemetryError(null);
    try {
      const data = await fetchDevTelemetry();
      setTelemetry(data);
    } catch (err) {
      setTelemetryError(err instanceof Error ? err.message : "Failed to query Soroban RPC");
    } finally {
      setTelemetryLoading(false);
    }
  };

  useEffect(() => {
    void loadTelemetry();
  }, [fetchDevTelemetry]);

  useEffect(() => {
    if (activeAccount && !faucetTarget) {
      setFaucetTarget(activeAccount.address);
    }
    if (activeAccount) {
      setVerifyPubkey(activeAccount.address);
    }
  }, [activeAccount, faucetTarget]);

  const activeRawHex = useMemo(() => {
    if (!activeAccount || !activeAccount.address.startsWith("G")) return null;
    try {
      return publicKeyToRawHex(activeAccount.address as ClassicAddress);
    } catch {
      return null;
    }
  }, [activeAccount]);

  const pairedSmartAddress = useMemo(() => {
    if (!activeAccount || !config.smartAccountWasmHash) return null;
    try {
      return deriveCounterfactualSmartAccount({
        guardianAddress: activeAccount.address as ClassicAddress,
        wasmHashHex: config.smartAccountWasmHash,
        networkPassphrase: config.networkPassphrase,
      }).contractAddress;
    } catch {
      return null;
    }
  }, [activeAccount, config.smartAccountWasmHash, config.networkPassphrase]);

  const derivationPreview = useMemo(() => {
    if (subTab !== "crypto") return [];
    try {
      return derivePublicKeyPreview(derivationCount);
    } catch {
      return [];
    }
  }, [subTab, derivePublicKeyPreview, derivationCount]);

  if (!activeAccount) return null;

  const copyValue = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleFaucetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = ClassicAddressSchema.safeParse(faucetTarget.trim());
    if (!parsed.success) {
      showToast("Enter a valid G... Classic address for Testnet Faucet", "error");
      return;
    }
    setFaucetBusy(true);
    try {
      await fundAnyTestnetAddress(parsed.data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Friendbot funding failed", "error");
    } finally {
      setFaucetBusy(false);
    }
  };

  const handleSimulateContract = async () => {
    const parsedId = ContractAddressSchema.safeParse(contractId.trim());
    if (!parsedId.success) {
      setContractError("Enter a valid 56-character Soroban C... Contract ID.");
      return;
    }
    setContractBusy(true);
    setContractError(null);
    setContractSimRes(null);
    setContractInvokeRes(null);
    try {
      const res = await simulateSorobanCall({
        contractId: parsedId.data as ContractAddress,
        fnName: fnName.trim(),
        argsJson,
      });
      setContractSimRes(res);
    } catch (err) {
      setContractError(err instanceof Error ? err.message : "Soroban RPC simulation failed");
    } finally {
      setContractBusy(false);
    }
  };

  const handleInvokeContract = async () => {
    const parsedId = ContractAddressSchema.safeParse(contractId.trim());
    if (!parsedId.success) {
      setContractError("Enter a valid 56-character Soroban C... Contract ID.");
      return;
    }
    setContractBusy(true);
    setContractError(null);
    setContractInvokeRes(null);
    try {
      const res = await invokeSorobanWrite({
        contractId: parsedId.data as ContractAddress,
        fnName: fnName.trim(),
        argsJson,
      });
      setContractInvokeRes(res);
    } catch (err) {
      setContractError(err instanceof Error ? err.message : "Soroban write invocation failed");
    } finally {
      setContractBusy(false);
    }
  };

  const handleGenerateTemplate = async (template: DevTemplateKind) => {
    setXdrBusy(true);
    setXdrError(null);
    setXdrScanReport(null);
    setXdrDecodedJson(null);
    setXdrSimRes(null);
    setSignedXdrOut(null);
    setSubmittedXdrOut(null);
    try {
      const generated = await buildDevTemplateXdr(template);
      setRawXdr(generated);
      const local = scanTransactionEnvelopeXdr(generated, {
        networkPassphrase: config.networkPassphrase,
      });
      setXdrScanReport(local.report);
      setXdrDecodedJson(JSON.stringify(local.decoded, null, 2));
    } catch (err) {
      setXdrError(
        err instanceof Error
          ? err.message
          : "Ensure active account is funded on Testnet before generating live-sequence XDR.",
      );
    } finally {
      setXdrBusy(false);
    }
  };

  const handleInspectXdr = async () => {
    if (!rawXdr.trim()) return;
    setXdrBusy(true);
    setXdrError(null);
    setXdrScanReport(null);
    setXdrDecodedJson(null);
    setXdrSimRes(null);
    try {
      const local = scanTransactionEnvelopeXdr(rawXdr.trim(), {
        networkPassphrase: config.networkPassphrase,
      });
      setXdrScanReport(local.report);
      setXdrDecodedJson(JSON.stringify(local.decoded, null, 2));
      const sim = await simulateRawXdr(rawXdr.trim()).catch(() => null);
      if (sim) setXdrSimRes(sim);
    } catch (err) {
      setXdrError(err instanceof Error ? err.message : "Invalid Base64 TransactionEnvelope XDR");
    } finally {
      setXdrBusy(false);
    }
  };

  const handleSignXdrOnly = async () => {
    if (!rawXdr.trim()) return;
    setXdrBusy(true);
    setXdrError(null);
    setSignedXdrOut(null);
    try {
      const res = await signRawXdrWithShield(rawXdr, allowWarnings);
      setXdrScanReport(res.scanReport);
      setSignedXdrOut(res.signedXdr);
      showToast("Envelope signed locally");
    } catch (err) {
      setXdrError(err instanceof Error ? err.message : "Signing failed");
    } finally {
      setXdrBusy(false);
    }
  };

  const handleSignAndSubmitXdr = async () => {
    if (!rawXdr.trim()) return;
    setXdrBusy(true);
    setXdrError(null);
    setSubmittedXdrOut(null);
    try {
      const res = await signAndSubmitRawXdrWithShield(rawXdr, allowWarnings);
      setSignedXdrOut(res.signedXdr);
      setSubmittedXdrOut({
        hash: res.hash,
        ledger: res.ledger,
        channel: res.channel,
      });
    } catch (err) {
      setXdrError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setXdrBusy(false);
    }
  };

  const handleSignSep53 = async (e: FormEvent) => {
    e.preventDefault();
    if (!sep53Message.trim()) return;
    const res = await signActiveSep53Message(sep53Message);
    setSep53Signature(res.signature);
    setVerifyPubkey(res.signerAddress);
    setVerifyMsg(sep53Message);
    setVerifySig(res.signature);
    setVerifyVerdict(true);
    showToast("Signed SEP-53 challenge message");
  };

  const handleVerifySep53 = (e: FormEvent) => {
    e.preventDefault();
    const parsed = ClassicAddressSchema.safeParse(verifyPubkey.trim());
    if (!parsed.success) {
      setVerifyVerdict(false);
      return;
    }
    setVerifyVerdict(verifyChallengeMessage(parsed.data, verifyMsg, verifySig));
  };

  const handleManageDataSubmit = async (remove: boolean) => {
    setDataBusy(true);
    try {
      await submitAccountDataEntry(
        dataKeyName.trim(),
        remove ? null : dataKeyValue,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "ManageData failed", "error");
    } finally {
      setDataBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Developer Lab Header & Sub-Tabs */}
      <section className="glass-card glass-card--vault" style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div className="aw-pixel-frame">
            <AstroNavigatorAvatar
              seedKey={activeAccount.address}
              kind="smart"
              state="shield"
              size={64}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
              <span className="glass-pill glass-pill--gold">Developer Workbench</span>
              <span className="glass-pill">{caip2}</span>
              <span className="glass-pill glass-pill--trust">
                TON Connect v2 · §7.3
              </span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>
              Stellar &amp; Soroban Dev Lab
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Live RPC telemetry, contract read/write caller, XDR signer &amp; SEP-53 tools
            </div>
          </div>
        </div>

        <div className="aw-dev-tabs" role="tablist" aria-label="Developer tools">
          {(
            [
              ["network", "RPC & Network"],
              ["contracts", "Contracts"],
              ["xdr", "XDR Lab"],
              ["crypto", "Crypto & Keys"],
              ["tonconnect", "TON Connect"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={subTab === id}
              aria-pressed={subTab === id}
              className="aw-chip-btn"
              onClick={() => setSubTab(id)}
            >
              {id === "network" && <IconRefresh size={13} />}
              {id === "contracts" && <IconCode size={13} />}
              {id === "xdr" && <IconTerminal size={13} />}
              {id === "crypto" && <IconKey size={13} />}
              {id === "tonconnect" && <IconPlug size={13} />}
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Sub-Tab 1: RPC & Network */}
      {subTab === "network" && (
        <div style={{ display: "grid", gap: 14 }}>
          <section className="glass-card" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Live Soroban RPC Telemetry</div>
              <button
                type="button"
                className="aw-chip-btn"
                disabled={telemetryLoading}
                onClick={() => void loadTelemetry()}
              >
                <IconRefresh size={13} />
                <span>{telemetryLoading ? "Polling..." : "Refresh Telemetry"}</span>
              </button>
            </div>

            {telemetryError && <div className="aw-banner aw-banner--danger">{telemetryError}</div>}

            {telemetry && (
              <div className="aw-dev-kv-grid">
                <div className="aw-seal-row">
                  <span>Health Status</span>
                  <code>{telemetry.healthStatus.toUpperCase()}</code>
                </div>
                <div className="aw-seal-row">
                  <span>Latest Ledger</span>
                  <code className="tabular-nums">#{telemetry.latestLedger.toLocaleString()}</code>
                </div>
                <div className="aw-seal-row">
                  <span>Protocol / RPC</span>
                  <code>
                    P{telemetry.protocolVersion} · v{telemetry.rpcVersion}
                  </code>
                </div>
                <div className="aw-seal-row">
                  <span>Inclusion Fee (p50)</span>
                  <code className="tabular-nums">
                    Soroban {telemetry.sorobanInclusionFeeP50} · Classic {telemetry.classicInclusionFeeP50} stroops
                  </code>
                </div>
              </div>
            )}

            <div className="aw-contract-seals">
              <div className="aw-seal-row">
                <span>Network Passphrase</span>
                <code>{config.networkPassphrase}</code>
              </div>
              <div className="aw-seal-row">
                <span>Soroban RPC</span>
                <code>{config.rpcUrls[0]}</code>
              </div>
              <div className="aw-seal-row">
                <span>Horizon REST</span>
                <code>{config.horizonUrls[0]}</code>
              </div>
              {config.claimEscrowContractId && (
                <div className="aw-seal-row">
                  <span>Claim Escrow C...</span>
                  <code>{config.claimEscrowContractId}</code>
                </div>
              )}
              {config.sorobitsContractId && (
                <div className="aw-seal-row">
                  <span>Sorobits SEP-50 C...</span>
                  <code>{config.sorobitsContractId}</code>
                </div>
              )}
            </div>
          </section>

          {config.network === "testnet" && config.friendbotUrl && (
            <section className="glass-card" style={{ display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                Testnet Friendbot Faucet (Any G... Account)
              </div>
              <form onSubmit={handleFaucetSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  type="text"
                  className="aw-input"
                  style={{ flex: "1 1 180px", minWidth: 0 }}
                  placeholder="G..."
                  value={faucetTarget}
                  onChange={(e) => setFaucetTarget(e.target.value)}
                />
                <button type="submit" className="aw-btn-gold" disabled={faucetBusy}>
                  <IconZap size={15} />
                  <span>{faucetBusy ? "Funding..." : "Fund 10,000 XLM"}</span>
                </button>
              </form>
            </section>
          )}
        </div>
      )}

      {/* Sub-Tab 2: Contracts */}
      {subTab === "contracts" && (
        <section className="glass-card" style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              Soroban Contract Read &amp; Write Caller
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Simulate views via Soroban RPC or assemble, sign &amp; invoke state mutations live
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {config.sorobitsContractId && (
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setContractId(config.sorobitsContractId ?? "");
                  setFnName("total_supply");
                  setArgsJson("[]");
                }}
              >
                Preset: Sorobits total_supply()
              </button>
            )}
            {config.sorobitsContractId && (
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setContractId(config.sorobitsContractId ?? "");
                  setFnName("get_sorobit");
                  setArgsJson('[{"type":"u32","value":0}]');
                }}
              >
                Preset: get_sorobit(0)
              </button>
            )}
            {config.sorobitsContractId && (
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setContractId(config.sorobitsContractId ?? "");
                  setFnName("tokens_of");
                  setArgsJson(
                    JSON.stringify([{ type: "address", value: activeAccount.address }]),
                  );
                }}
              >
                Preset: tokens_of(My Account)
              </button>
            )}
            {config.claimEscrowContractId && (
              <button
                type="button"
                className="aw-chip-btn"
                onClick={() => {
                  setContractId(config.claimEscrowContractId ?? "");
                  setFnName("get_claim");
                  setArgsJson('[{"type":"bytes","value":"' + "01".repeat(32) + '"}]');
                }}
              >
                Preset: Claim Escrow
              </button>
            )}
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="dev-contract-id">
                Contract ID (C...)
              </label>
              <input
                id="dev-contract-id"
                type="text"
                className="aw-input"
                placeholder="C..."
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
              />
            </div>
            <div>
              <label className="aw-label" htmlFor="dev-fn-name">
                Method Name
              </label>
              <input
                id="dev-fn-name"
                type="text"
                className="aw-input"
                placeholder="total_supply"
                value={fnName}
                onChange={(e) => setFnName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="aw-label" htmlFor="dev-args-json">
              Typed ScVal Arguments JSON Array
            </label>
            <textarea
              id="dev-args-json"
              className="aw-textarea"
              rows={3}
              placeholder='[{"type":"u32","value":0}] or [{"type":"address","value":"G..."}]'
              value={argsJson}
              onChange={(e) => setArgsJson(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={contractBusy || !contractId.trim() || !fnName.trim()}
              onClick={() => void handleSimulateContract()}
            >
              {contractBusy ? "Simulating..." : "Simulate Read (RPC)"}
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              disabled={contractBusy || !contractId.trim() || !fnName.trim()}
              onClick={() => void handleInvokeContract()}
            >
              <IconZap size={15} />
              <span>{contractBusy ? "Submitting..." : "Sign & Invoke (Write)"}</span>
            </button>
          </div>

          {contractError && <div className="aw-banner aw-banner--danger">{contractError}</div>}

          {contractSimRes && (
            <div style={{ display: "grid", gap: 8 }}>
              <div className={contractSimRes.ok ? "aw-banner" : "aw-banner aw-banner--danger"}>
                <strong>
                  {contractSimRes.ok ? "Simulation Succeeded" : "Simulation Failed"}
                </strong>{" "}
                · Ledger #{contractSimRes.latestLedger}
                {contractSimRes.minResourceFee && ` · Min Fee: ${contractSimRes.minResourceFee} stroops`}
                {contractSimRes.error && <div>{contractSimRes.error}</div>}
              </div>
              {contractSimRes.ok && (
                <pre className="aw-code-block">
                  {JSON.stringify(contractSimRes.decodedResult, null, 2)}
                </pre>
              )}
            </div>
          )}

          {contractInvokeRes && (
            <div className="aw-banner" style={{ display: "grid", gap: 6 }}>
              <div style={{ fontWeight: 700, color: "var(--aw-trust-emerald)" }}>
                Soroban Invoke {contractInvokeRes.status} · Ledger #{contractInvokeRes.ledger}
              </div>
              <div style={{ fontSize: 12, wordBreak: "break-all" }}>
                Tx Hash: <code>{contractInvokeRes.hash}</code>
              </div>
              {config.explorerBaseUrl && (
                <a
                  href={`${config.explorerBaseUrl.replace(/\/+$/, "")}/tx/${contractInvokeRes.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="aw-chip-btn"
                  style={{ justifySelf: "start" }}
                >
                  <span>View on Explorer</span>
                  <IconExternalLink size={13} />
                </a>
              )}
            </div>
          )}
        </section>
      )}

      {/* Sub-Tab 3: XDR Lab */}
      {subTab === "xdr" && (
        <section className="glass-card" style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              XDR Inspector, Multi-Sig Signer &amp; Broadcaster
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
              Generate live-sequence templates or inspect, sign, and broadcast any Base64 XDR
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-chip-btn"
              disabled={xdrBusy}
              onClick={() => void handleGenerateTemplate("self_payment")}
            >
              Template: Self 0.0001 XLM
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              disabled={xdrBusy}
              onClick={() => void handleGenerateTemplate("manage_data")}
            >
              Template: ManageData
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              disabled={xdrBusy}
              onClick={() => void handleGenerateTemplate("change_trust")}
            >
              Template: ChangeTrust ASTRO
            </button>
          </div>

          <textarea
            className="aw-textarea"
            rows={4}
            placeholder="Paste Base64 TransactionEnvelope or FeeBumpTransaction XDR..."
            value={rawXdr}
            onChange={(e) => setRawXdr(e.target.value)}
          />

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={allowWarnings}
              onChange={(e) => setAllowWarnings(e.target.checked)}
            />
            <span>Allow signing non-malicious XDR warnings (malicious drainers remain strictly blocked)</span>
          </label>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={xdrBusy || !rawXdr.trim()}
              onClick={() => void handleInspectXdr()}
            >
              <IconShield size={15} />
              <span>Decode &amp; Simulate</span>
            </button>
            <button
              type="button"
              className="aw-btn-secondary"
              disabled={xdrBusy || !rawXdr.trim()}
              onClick={() => void handleSignXdrOnly()}
            >
              <IconKey size={15} />
              <span>Sign Only (Copy XDR)</span>
            </button>
            <button
              type="button"
              className="aw-btn-primary"
              disabled={xdrBusy || !rawXdr.trim()}
              onClick={() => void handleSignAndSubmitXdr()}
            >
              <IconZap size={15} />
              <span>Sign &amp; Submit On-Chain</span>
            </button>
          </div>

          {xdrError && <div className="aw-banner aw-banner--danger">{xdrError}</div>}

          {xdrScanReport && (
            <div
              className={
                xdrScanReport.verdict === "malicious"
                  ? "aw-banner aw-banner--danger"
                  : xdrScanReport.verdict === "warning"
                    ? "aw-banner aw-banner--warn"
                    : "aw-banner"
              }
            >
              <div style={{ fontWeight: 700 }}>
                Scan &amp; Shield: {xdrScanReport.verdict.toUpperCase()} ({xdrScanReport.operationsCount} op)
              </div>
              {xdrSimRes && (
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  RPC Simulation: {xdrSimRes.ok ? `OK (Min Fee ${xdrSimRes.minResourceFee ?? "0"} stroops)` : xdrSimRes.error}
                </div>
              )}
            </div>
          )}

          {signedXdrOut && (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="aw-label" style={{ marginBottom: 0 }}>
                  Signed Transaction XDR (Base64)
                </span>
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => void copyValue("signed-xdr", signedXdrOut)}
                >
                  {copiedKey === "signed-xdr" ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  <span>{copiedKey === "signed-xdr" ? "Copied" : "Copy Signed XDR"}</span>
                </button>
              </div>
              <pre className="aw-code-block">{signedXdrOut}</pre>
            </div>
          )}

          {submittedXdrOut && (
            <div className="aw-banner" style={{ display: "grid", gap: 6 }}>
              <div style={{ fontWeight: 700, color: "var(--aw-trust-emerald)" }}>
                Broadcast Confirmed ({submittedXdrOut.channel}) · Ledger #{submittedXdrOut.ledger}
              </div>
              <div style={{ fontSize: 12, wordBreak: "break-all" }}>
                Tx Hash: <code>{submittedXdrOut.hash}</code>
              </div>
            </div>
          )}

          {xdrDecodedJson && <pre className="aw-code-block">{xdrDecodedJson}</pre>}
        </section>
      )}

      {/* Sub-Tab 4: Crypto, SEP-53, Derivation & ManageData */}
      {subTab === "crypto" && (
        <div style={{ display: "grid", gap: 14 }}>
          {/* Active Public Key & Raw Hex */}
          <section className="glass-card" style={{ display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Active Key Material Inspector</div>
            <div className="aw-seal-row">
              <span>Public G... StrKey</span>
              <code>{activeAccount.address}</code>
            </div>
            {activeRawHex && (
              <div className="aw-seal-row">
                <span>Raw Ed25519 32B Hex</span>
                <code>{activeRawHex}</code>
              </div>
            )}
            {pairedSmartAddress && (
              <div className="aw-seal-row">
                <span>Counterfactual Smart C...</span>
                <code>{pairedSmartAddress}</code>
              </div>
            )}
          </section>

          {/* SEP-53 Challenge Sign & Verify */}
          <section className="glass-card" style={{ display: "grid", gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>SEP-53 Sign &amp; Verify</div>
            <form onSubmit={(e) => void handleSignSep53(e)} style={{ display: "grid", gap: 8 }}>
              <input
                type="text"
                className="aw-input"
                placeholder="Challenge message string..."
                value={sep53Message}
                onChange={(e) => setSep53Message(e.target.value)}
              />
              <button type="submit" className="aw-btn-primary">
                Sign Challenge with {activeAccount.label}
              </button>
            </form>
            {sep53Signature && (
              <div className="aw-seal-row">
                <span>Base64 Signature</span>
                <code style={{ wordBreak: "break-all" }}>{sep53Signature}</code>
              </div>
            )}

            <form
              onSubmit={handleVerifySep53}
              className="aw-vault-divider"
              style={{ display: "grid", gap: 8 }}
            >
              <div style={{ fontWeight: 700, fontSize: 13 }}>Verify Any SEP-53 Signature</div>
              <input
                type="text"
                className="aw-input"
                placeholder="Signer Public Key (G...)"
                value={verifyPubkey}
                onChange={(e) => setVerifyPubkey(e.target.value)}
              />
              <input
                type="text"
                className="aw-input"
                placeholder="Original Message"
                value={verifyMsg}
                onChange={(e) => setVerifyMsg(e.target.value)}
              />
              <input
                type="text"
                className="aw-input"
                placeholder="Base64 Signature"
                value={verifySig}
                onChange={(e) => setVerifySig(e.target.value)}
              />
              <button type="submit" className="aw-btn-secondary">
                Verify Signature
              </button>
              {verifyVerdict !== null && (
                <div className={verifyVerdict ? "aw-banner" : "aw-banner aw-banner--danger"}>
                  {verifyVerdict
                    ? "VALID — Ed25519 signature matches SEP-53 digest."
                    : "INVALID — Signature does not verify against public key & message."}
                </div>
              )}
            </form>
          </section>

          {/* SEP-0005 Derivation Table */}
          <section className="glass-card" style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>SEP-0005 HD Derivation Table</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() => setDerivationCount((c) => (c === 5 ? 10 : 5))}
                >
                  Show {derivationCount === 5 ? "10" : "5"}
                </button>
                <button
                  type="button"
                  className="aw-chip-btn"
                  onClick={() =>
                    void copyValue("hd-json", JSON.stringify(derivationPreview, null, 2))
                  }
                >
                  {copiedKey === "hd-json" ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  <span>{copiedKey === "hd-json" ? "Copied JSON" : "Copy JSON"}</span>
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              {derivationPreview.map((row) => (
                <div key={row.index} className="aw-list-row">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>
                      {row.derivationPath}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                      <code>
                        {row.publicKey.slice(0, 12)}…{row.publicKey.slice(-8)}
                      </code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => void copyValue(`hd-${row.index}`, row.publicKey)}
                  >
                    {copiedKey === `hd-${row.index}` ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    <span>Copy G...</span>
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* ManageData Ledger Entries */}
          <section className="glass-card" style={{ display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>On-Chain ManageData Entry</div>
            <div className="aw-two-col-inputs">
              <input
                type="text"
                className="aw-input"
                maxLength={64}
                placeholder="Data Key (max 64 bytes)"
                value={dataKeyName}
                onChange={(e) => setDataKeyName(e.target.value)}
              />
              <input
                type="text"
                className="aw-input"
                maxLength={64}
                placeholder="Data Value (max 64 bytes)"
                value={dataKeyValue}
                onChange={(e) => setDataKeyValue(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="aw-btn-primary"
                disabled={dataBusy || !dataKeyName.trim()}
                onClick={() => void handleManageDataSubmit(false)}
              >
                {dataBusy ? "Writing Ledger..." : "Set Data Entry On-Chain"}
              </button>
              <button
                type="button"
                className="aw-btn-secondary"
                disabled={dataBusy || !dataKeyName.trim()}
                onClick={() => void handleManageDataSubmit(true)}
              >
                Delete Data Entry
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Sub-Tab 5: TON Connect v2 */}
      {subTab === "tonconnect" && <TonConnectSheet />}
    </div>
  );
}
