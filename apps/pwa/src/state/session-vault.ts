import type { SecurityFinding } from "@astrowallet/domain";
import {
  decodeAuthEntryXdr,
  evaluateSorobanInvocation,
  type DecodedAuthEntrySummary,
} from "@astrowallet/security-shield";

/**
 * In-memory mutable `Uint8Array` container for the unlocked session mnemonic.
 * Keeps plaintext recovery words out of React component state strings and supports
 * deterministic zeroization on lock, inactivity timeout, `pagehide`, and `beforeunload`.
 */
export class SessionMnemonicVault {
  private buffer: Uint8Array | null = null;
  private importedSecrets = new Map<string, Uint8Array>();

  set(mnemonic: string): void {
    this.clear();
    const encoded = new TextEncoder().encode(mnemonic);
    this.buffer = new Uint8Array(encoded.byteLength);
    this.buffer.set(encoded);
    encoded.fill(0);
  }

  has(): boolean {
    return this.buffer !== null && this.buffer.byteLength > 0;
  }

  withMnemonic<T>(fn: (mnemonic: string) => T): T {
    if (!this.buffer || this.buffer.byteLength === 0) {
      throw new Error("Vault is locked");
    }
    return fn(new TextDecoder().decode(this.buffer));
  }

  setImportedSecret(address: string, secretSeed: string): void {
    const existing = this.importedSecrets.get(address);
    if (existing) {
      existing.fill(0);
    }
    const encoded = new TextEncoder().encode(secretSeed);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    encoded.fill(0);
    this.importedSecrets.set(address, copy);
  }

  hasImportedSecret(address: string): boolean {
    const buf = this.importedSecrets.get(address);
    return Boolean(buf && buf.byteLength > 0);
  }

  withImportedSecret<T>(address: string, fn: (secretSeed: string) => T): T {
    const buf = this.importedSecrets.get(address);
    if (!buf || buf.byteLength === 0) {
      throw new Error("Imported secret is not unlocked");
    }
    return fn(new TextDecoder().decode(buf));
  }

  clear(): void {
    if (this.buffer) {
      this.buffer.fill(0);
      this.buffer = null;
    }
    for (const buf of this.importedSecrets.values()) {
      buf.fill(0);
    }
    this.importedSecrets.clear();
  }
}

export const sessionVault = new SessionMnemonicVault();

async function sha256HexFromText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface DappAuthEntryInspection {
  summary: DecodedAuthEntrySummary;
  findings: SecurityFinding[];
  blockedReason?: string | undefined;
}

/**
 * Decodes and security-evaluates a Soroban `stellar_signAuthEntry` payload
 * (`HashIdPreimage` or `SorobanAuthorizationEntry`) before prompting the user.
 */
export async function inspectDappAuthEntrySecurity(
  rawEntryXdr: string,
  networkPassphrase: string,
): Promise<DappAuthEntryInspection> {
  const summary = decodeAuthEntryXdr(rawEntryXdr);
  if (summary.kind === "hash_id_preimage" && summary.networkIdHex) {
    const expectedNetworkHex = await sha256HexFromText(networkPassphrase);
    if (summary.networkIdHex.toLowerCase() !== expectedNetworkHex.toLowerCase()) {
      throw new Error("Cross-network Soroban auth entry networkId mismatch rejected");
    }
  }
  const findings = evaluateSorobanInvocation(summary.invocation);
  const blocker = findings.find((f) => f.severity === "malicious" || f.blocksSigning);
  return {
    summary,
    findings,
    ...(blocker ? { blockedReason: blocker.title } : {}),
  };
}

/**
 * Maps any standard SEP-0007 `memo_type` string to SendSheet's typed memo selector.
 */
export function mapSep7MemoKind(
  memoType?: string | null,
): "none" | "text" | "id" | "hash" | "return" {
  switch ((memoType ?? "").trim().toUpperCase()) {
    case "MEMO_ID":
      return "id";
    case "MEMO_HASH":
      return "hash";
    case "MEMO_RETURN":
      return "return";
    case "MEMO_TEXT":
      return "text";
    case "MEMO_NONE":
      return "none";
    default:
      return "text";
  }
}
