import type { TonNetwork } from "@astrowallet/domain";
import {
  Address,
  Cell,
  SendMode,
  beginCell,
  external,
  internal,
  loadStateInit,
  storeMessage,
  type MessageRelaxed,
  type StateInit,
} from "@ton/core";
import { WalletContractV5R1, type WalletContractV4 } from "@ton/ton";
import { formatNanoTon, parseTonToNano, type DerivedTonAccount } from "./derivation.js";

export type TonFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TonClientConfig {
  network: TonNetwork;
  rpcUrls: readonly string[];
  fetchFn?: TonFetchLike | undefined;
}

export interface TonAccountChainState {
  address: string;
  balanceNano: string;
  balanceTon: string;
  state: "active" | "uninitialized" | "frozen" | string;
  seqno: number;
}

export interface TonTransferMessageInput {
  destination: string;
  amountNano: bigint;
  bounce?: boolean | undefined;
  comment?: string | undefined;
  payloadCellBase64?: string | undefined;
  stateInitBase64?: string | undefined;
}

export interface TonBroadcastResult {
  bocBase64: string;
  hash: string;
}

interface TonRpcResponse<T> {
  ok?: boolean;
  result?: T;
  error?: string;
}

interface TonAddressInformationResult {
  balance?: string | number;
  state?: string;
}

interface TonRunGetMethodResult {
  exit_code?: number;
  stack?: Array<[string, string | Record<string, unknown>]>;
}

interface TonSendBocReturnHashResult {
  hash?: string;
}

async function callTonRpcWithFailover<T>(
  rpcUrls: readonly string[],
  method: string,
  params: Record<string, unknown>,
  fetchFn: TonFetchLike,
): Promise<T> {
  if (rpcUrls.length === 0) {
    throw new Error("No VITE_TON_RPC_URLS endpoints configured");
  }

  let lastError: unknown;
  for (let i = 0; i < rpcUrls.length; i += 1) {
    const endpoint = rpcUrls[i]!;
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `aw-${Date.now()}`,
          jsonrpc: "2.0",
          method,
          params,
        }),
      });
      if (!response.ok) {
        throw new Error(`TON RPC ${method} HTTP ${response.status}`);
      }
      const data = (await response.json()) as TonRpcResponse<T>;
      if (data.ok === false || data.error) {
        throw new Error(data.error ?? `TON RPC ${method} returned error`);
      }
      if (data.result === undefined) {
        throw new Error(`TON RPC ${method} returned empty result`);
      }
      return data.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All TON RPC endpoints failed for ${method}`);
}

function parseSeqnoFromStack(res: TonRunGetMethodResult): number {
  if (res.exit_code !== undefined && res.exit_code !== 0) {
    return 0;
  }
  const top = res.stack?.[0];
  if (!top || top[0] !== "num") return 0;
  const rawVal = String(top[1]);
  const parsed = rawVal.startsWith("0x") ? Number.parseInt(rawVal, 16) : Number(rawVal);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseAnyAddressAsFriendlyOrRaw(raw: string): {
  to: Address;
  bounce: boolean;
} {
  const trimmed = raw.trim();
  if (Address.isFriendly(trimmed)) {
    const parsed = Address.parseFriendly(trimmed);
    return { to: parsed.address, bounce: parsed.isBounceable };
  }
  return { to: Address.parse(trimmed), bounce: true };
}

/**
 * Builds and signs a TON external-in BOC transfer with 1..4 messages using V4R2 or V5R1.
 */
export function buildSignedTonTransfer(input: {
  account: DerivedTonAccount;
  messages: readonly TonTransferMessageInput[];
  seqno: number;
  validUntil?: number | undefined;
}): string {
  if (input.messages.length === 0 || input.messages.length > 4) {
    throw new Error("TON wallet transfer supports between 1 and 4 messages");
  }
  const secretBuf = Buffer.from(input.account.secretKey);
  const timeout = input.validUntil ?? Math.floor(Date.now() / 1000) + 180;
  const relaxedMessages: MessageRelaxed[] = input.messages.map((msg) => {
    const { to, bounce } = parseAnyAddressAsFriendlyOrRaw(msg.destination);
    let body: Cell | undefined;
    if (msg.payloadCellBase64) {
      body = Cell.fromBase64(msg.payloadCellBase64);
    } else if (msg.comment && msg.comment.trim()) {
      body = beginCell().storeUint(0, 32).storeStringTail(msg.comment.trim()).endCell();
    }
    let init: StateInit | undefined;
    if (msg.stateInitBase64) {
      init = loadStateInit(Cell.fromBase64(msg.stateInitBase64).beginParse());
    }
    return internal({
      to,
      value: msg.amountNano,
      bounce: msg.bounce ?? bounce,
      ...(body ? { body } : {}),
      ...(init ? { init } : {}),
    });
  });

  const sendMode = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;
  const transferBody =
    input.account.wallet instanceof WalletContractV5R1
      ? input.account.wallet.createTransfer({
          seqno: input.seqno,
          secretKey: secretBuf,
          messages: relaxedMessages,
          sendMode,
          timeout,
        })
      : (input.account.wallet as WalletContractV4).createTransfer({
          seqno: input.seqno,
          secretKey: secretBuf,
          messages: relaxedMessages,
          sendMode,
          timeout,
        });

  const extMsg = external({
    to: input.account.wallet.address,
    ...(input.seqno === 0 ? { init: input.account.wallet.init } : {}),
    body: transferBody,
  });

  const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc();
  secretBuf.fill(0);
  return boc.toString("base64");
}

/**
 * Env-driven TON RPC client supporting balance/seqno lookup and BOC broadcast with failover.
 */
export function createTonClient(config: TonClientConfig) {
  const fetchFn: TonFetchLike =
    config.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  return {
    network: config.network,

    async getAccountState(address: string): Promise<TonAccountChainState> {
      const info = await callTonRpcWithFailover<TonAddressInformationResult>(
        config.rpcUrls,
        "getAddressInformation",
        { address },
        fetchFn,
      );
      const balanceNano = String(info.balance ?? "0");
      const state = String(info.state ?? "uninitialized");
      let seqno = 0;
      if (state === "active") {
        const seqRes = await callTonRpcWithFailover<TonRunGetMethodResult>(
          config.rpcUrls,
          "runGetMethod",
          { address, method: "seqno", stack: [] },
          fetchFn,
        );
        seqno = parseSeqnoFromStack(seqRes);
      }

      return {
        address,
        balanceNano,
        balanceTon: formatNanoTon(balanceNano),
        state,
        seqno,
      };
    },

    async sendTonTransfer(input: {
      account: DerivedTonAccount;
      destination: string;
      amountTon: string;
      comment?: string | undefined;
      validUntil?: number | undefined;
    }): Promise<TonBroadcastResult> {
      const amountNano = parseTonToNano(input.amountTon);
      const state = await this.getAccountState(input.account.friendlyAddress);
      const bocBase64 = buildSignedTonTransfer({
        account: input.account,
        seqno: state.seqno,
        validUntil: input.validUntil,
        messages: [
          {
            destination: input.destination,
            amountNano,
            comment: input.comment,
          },
        ],
      });
      return this.broadcastBoc(bocBase64);
    },

    async broadcastBoc(bocBase64: string): Promise<TonBroadcastResult> {
      try {
        const res = await callTonRpcWithFailover<TonSendBocReturnHashResult>(
          config.rpcUrls,
          "sendBocReturnHash",
          { boc: bocBase64 },
          fetchFn,
        );
        return {
          bocBase64,
          hash: res.hash ?? Cell.fromBase64(bocBase64).hash().toString("hex"),
        };
      } catch {
        await callTonRpcWithFailover<unknown>(
          config.rpcUrls,
          "sendBoc",
          { boc: bocBase64 },
          fetchFn,
        );
        return {
          bocBase64,
          hash: Cell.fromBase64(bocBase64).hash().toString("hex"),
        };
      }
    },
  };
}
