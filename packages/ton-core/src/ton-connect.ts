import type { TonNetwork } from "@astrowallet/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { Address } from "@ton/core";
import nacl from "tweetnacl";

export type TonConnectFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TonConnectRequestItem {
  name: "ton_addr" | "ton_proof";
  payload?: string | undefined;
}

export interface ParsedTonConnectUri {
  version: string;
  clientId: string;
  manifestUrl: string;
  items: TonConnectRequestItem[];
  returnStrategy?: string | undefined;
}

export interface TonConnectSendTxMessage {
  address: string;
  amount: string;
  payload?: string | undefined;
  stateInit?: string | undefined;
}

export interface TonConnectSendTxRequest {
  id: string;
  validUntil?: number | undefined;
  network?: string | undefined;
  from?: string | undefined;
  messages: TonConnectSendTxMessage[];
}

export interface TonConnectValidatedRequest {
  ok: true;
  validUntil: number;
  network: TonNetwork;
  messages: Array<{
    address: string;
    amountNano: bigint;
    payload?: string | undefined;
    stateInit?: string | undefined;
  }>;
}

export interface TonConnectValidationFailure {
  ok: false;
  code: number;
  message: string;
}

export type ValidateSendTxResult = TonConnectValidatedRequest | TonConnectValidationFailure;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const cleaned = hex.trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function expectedTonConnectChainId(network: TonNetwork): "-239" | "-3" {
  return network === "mainnet" ? "-239" : "-3";
}

/**
 * Parses a TON Connect v2 tc:// or universal link URI and validates version, client_id, and HTTPS manifest URL.
 */
export function parseTonConnectUri(rawUri: string): ParsedTonConnectUri {
  const trimmed = rawUri.trim();
  let queryString = "";
  if (trimmed.toLowerCase().startsWith("tc://")) {
    const qIdx = trimmed.indexOf("?");
    queryString = qIdx >= 0 ? trimmed.slice(qIdx + 1) : "";
  } else {
    const parsedUrl = new URL(trimmed);
    queryString = parsedUrl.search.replace(/^\?/, "");
  }

  const params = new URLSearchParams(queryString);
  const version = params.get("v") ?? "";
  if (version !== "2") {
    throw new Error(`Unsupported TON Connect protocol version "${version}"`);
  }

  const clientId = (params.get("id") ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clientId)) {
    throw new Error("TON Connect URI contains invalid dApp client id");
  }

  const rawRequest = params.get("r") ?? "";
  if (!rawRequest) {
    throw new Error("TON Connect URI missing request payload 'r'");
  }
  const parsedReq = JSON.parse(rawRequest) as {
    manifestUrl?: unknown;
    items?: unknown;
  };
  if (typeof parsedReq.manifestUrl !== "string") {
    throw new Error("TON Connect request missing manifestUrl");
  }
  const manifestParsed = new URL(parsedReq.manifestUrl);
  if (
    manifestParsed.protocol !== "https:" &&
    !(manifestParsed.protocol === "http:" && manifestParsed.hostname === "localhost")
  ) {
    throw new Error("TON Connect manifestUrl must use https://");
  }

  const rawItems = Array.isArray(parsedReq.items) ? parsedReq.items : [];
  const items: TonConnectRequestItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as { name?: unknown; payload?: unknown };
    if (obj.name === "ton_addr") {
      items.push({ name: "ton_addr" });
    } else if (obj.name === "ton_proof" && typeof obj.payload === "string") {
      items.push({ name: "ton_proof", payload: obj.payload });
    }
  }

  if (!items.some((i) => i.name === "ton_addr")) {
    items.push({ name: "ton_addr" });
  }

  return {
    version,
    clientId,
    manifestUrl: parsedReq.manifestUrl,
    items,
    returnStrategy: params.get("ret") ?? undefined,
  };
}

/**
 * Manages X25519 NaCl box session encryption for TON Connect v2 HTTP SSE bridge messaging.
 */
export class TonConnectCryptoSession {
  readonly publicKeyHex: string;
  readonly secretKeyHex: string;
  private readonly keyPair: nacl.BoxKeyPair;

  constructor(existingSecretKeyHex?: string) {
    if (existingSecretKeyHex) {
      const secretKey = fromHex(existingSecretKeyHex);
      this.keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
    } else {
      this.keyPair = nacl.box.keyPair();
    }
    this.publicKeyHex = toHex(this.keyPair.publicKey);
    this.secretKeyHex = toHex(this.keyPair.secretKey);
  }

  get clientId(): string {
    return this.publicKeyHex;
  }

  encrypt(plaintext: string, peerPublicKeyHex: string): string {
    const peerPubKey = fromHex(peerPublicKeyHex);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const messageBytes = new TextEncoder().encode(plaintext);
    const sealed = nacl.box(messageBytes, nonce, peerPubKey, this.keyPair.secretKey);
    const wire = new Uint8Array(nonce.length + sealed.length);
    wire.set(nonce, 0);
    wire.set(sealed, nonce.length);
    return toBase64(wire);
  }

  decrypt(ciphertextBase64: string, peerPublicKeyHex: string): string {
    const wire = fromBase64(ciphertextBase64);
    if (wire.length <= nacl.box.nonceLength) {
      throw new Error("Malformed TON Connect encrypted payload");
    }
    const peerPubKey = fromHex(peerPublicKeyHex);
    const nonce = wire.subarray(0, nacl.box.nonceLength);
    const boxBytes = wire.subarray(nacl.box.nonceLength);
    const opened = nacl.box.open(boxBytes, nonce, peerPubKey, this.keyPair.secretKey);
    if (!opened) {
      throw new Error("TON Connect message decryption failed");
    }
    return new TextDecoder().decode(opened);
  }
}

/**
 * Builds the TON Connect v2 ton_proof digest bytes and signs them with the wallet's Ed25519 key.
 */
export function buildTonProofSignatureMessage(input: {
  rawAddress: string;
  domain: string;
  timestamp: number;
  payload: string;
}): Uint8Array {
  const parsed = Address.parseRaw(input.rawAddress);
  const encoder = new TextEncoder();
  const domainBytes = encoder.encode(input.domain);
  const payloadBytes = encoder.encode(input.payload);
  const prefixBytes = encoder.encode("ton-proof-item-v2/");

  const workchainBuf = new Uint8Array(4);
  new DataView(workchainBuf.buffer).setInt32(0, parsed.workChain, false);

  const domainLenBuf = new Uint8Array(4);
  new DataView(domainLenBuf.buffer).setUint32(0, domainBytes.length, true);

  const tsBuf = new Uint8Array(8);
  new DataView(tsBuf.buffer).setBigUint64(0, BigInt(input.timestamp), true);

  const messageLen =
    prefixBytes.length +
    4 +
    parsed.hash.length +
    4 +
    domainBytes.length +
    8 +
    payloadBytes.length;
  const message = new Uint8Array(messageLen);
  let offset = 0;
  message.set(prefixBytes, offset);
  offset += prefixBytes.length;
  message.set(workchainBuf, offset);
  offset += 4;
  message.set(parsed.hash, offset);
  offset += parsed.hash.length;
  message.set(domainLenBuf, offset);
  offset += 4;
  message.set(domainBytes, offset);
  offset += domainBytes.length;
  message.set(tsBuf, offset);
  offset += 8;
  message.set(payloadBytes, offset);

  const msgHash = sha256(message);
  const tonConnectPrefix = encoder.encode("ton-connect");
  const wrapped = new Uint8Array(2 + tonConnectPrefix.length + msgHash.length);
  wrapped[0] = 0xff;
  wrapped[1] = 0xff;
  wrapped.set(tonConnectPrefix, 2);
  wrapped.set(msgHash, 2 + tonConnectPrefix.length);

  return sha256(wrapped);
}

export function signTonProof(input: {
  rawAddress: string;
  domain: string;
  timestamp: number;
  payload: string;
  secretKey: Uint8Array;
}): string {
  const digest = buildTonProofSignatureMessage(input);
  const sig = nacl.sign.detached(digest, input.secretKey);
  return toBase64(sig);
}

export function buildTonConnectSuccessEvent(input: {
  id?: number | undefined;
  rawAddress: string;
  network: TonNetwork;
  walletStateInitBase64: string;
  publicKeyHex: string;
  appName?: string | undefined;
  appVersion?: string | undefined;
  tonProof?:
    | {
        timestamp: number;
        domain: string;
        payload: string;
        signatureBase64: string;
      }
    | undefined;
}): string {
  const items: Array<Record<string, unknown>> = [
    {
      name: "ton_addr",
      address: input.rawAddress,
      network: expectedTonConnectChainId(input.network),
      walletStateInit: input.walletStateInitBase64,
      publicKey: input.publicKeyHex,
    },
  ];
  if (input.tonProof) {
    const domainBytes = new TextEncoder().encode(input.tonProof.domain);
    items.push({
      name: "ton_proof",
      proof: {
        timestamp: input.tonProof.timestamp,
        domain: {
          lengthBytes: domainBytes.length,
          value: input.tonProof.domain,
        },
        signature: input.tonProof.signatureBase64,
        payload: input.tonProof.payload,
      },
    });
  }

  return JSON.stringify({
    event: "connect",
    id: input.id ?? Date.now(),
    payload: {
      items,
      device: {
        platform: "web",
        appName: input.appName ?? "AstroWallet",
        appVersion: input.appVersion ?? "0.1.0",
        maxProtocolVersion: 2,
        features: [
          "SendTransaction",
          {
            name: "SendTransaction",
            maxMessages: 4,
          },
        ],
      },
    },
  });
}

export function buildTonConnectErrorEvent(code: number, message: string, id = Date.now()): string {
  return JSON.stringify({
    event: "connect_error",
    id,
    payload: {
      code,
      message,
    },
  });
}

/**
 * Validates an incoming TON Connect v2 sendTransaction RPC request fail-closed.
 */
export function validateTonConnectSendTxRequest(
  req: TonConnectSendTxRequest,
  expectedNetwork: TonNetwork,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): ValidateSendTxResult {
  const validUntil = req.validUntil ?? nowUnixSeconds + 300;
  if (!Number.isInteger(validUntil) || validUntil <= nowUnixSeconds) {
    return { ok: false, code: 1, message: "TON Connect request expired (validUntil passed)" };
  }

  const expectedChain = expectedTonConnectChainId(expectedNetwork);
  if (req.network && req.network !== expectedChain) {
    return {
      ok: false,
      code: 1,
      message: `Network mismatch: expected TON ${expectedNetwork} (${expectedChain})`,
    };
  }

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, code: 1, message: "Request must contain at least 1 message" };
  }
  if (req.messages.length > 4) {
    return { ok: false, code: 1, message: "Request exceeds maxMessages limit of 4" };
  }

  const validatedMessages: TonConnectValidatedRequest["messages"] = [];
  for (const msg of req.messages) {
    try {
      Address.parse(msg.address.trim());
    } catch {
      return { ok: false, code: 1, message: `Invalid destination TON address: ${msg.address}` };
    }
    if (!/^\d+$/.test(String(msg.amount)) || BigInt(msg.amount) <= 0n) {
      return { ok: false, code: 1, message: `Invalid nanoTON amount: ${msg.amount}` };
    }
    validatedMessages.push({
      address: msg.address.trim(),
      amountNano: BigInt(msg.amount),
      payload: msg.payload,
      stateInit: msg.stateInit,
    });
  }

  return {
    ok: true,
    validUntil,
    network: expectedNetwork,
    messages: validatedMessages,
  };
}

export function buildTonConnectEventsUrl(
  bridgeUrl: string,
  clientIds: readonly string[],
  lastEventId?: string,
): string {
  const base = new URL(bridgeUrl.replace(/\/+$/, "") + "/events");
  base.searchParams.set("client_id", clientIds.join(","));
  if (lastEventId) {
    base.searchParams.set("last_event_id", lastEventId);
  }
  return base.toString();
}

export async function sendTonConnectBridgeMessage(input: {
  bridgeUrl: string;
  clientId: string;
  to: string;
  payloadBase64: string;
  ttlSeconds?: number | undefined;
  fetchFn?: TonConnectFetchLike | undefined;
}): Promise<void> {
  const url = new URL(input.bridgeUrl.replace(/\/+$/, "") + "/message");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("to", input.to);
  url.searchParams.set("ttl", String(input.ttlSeconds ?? 300));

  const fetchFn = input.fetchFn ?? ((u, init) => globalThis.fetch(u, init));
  const res = await fetchFn(url.toString(), {
    method: "POST",
    body: input.payloadBase64,
  });
  if (!res.ok) {
    throw new Error(`TON Connect bridge error HTTP ${res.status}`);
  }
}
