import type {
  AstroConnectConfig,
  AstroIdentity,
  ConnectRequestHandle,
  ConnectResult,
  ConnectStatusResponse,
  LoginOptions,
  LoginResult,
  SignMessageOptions,
  SignMessageResult,
  SignTransactionOptions,
  SignTransactionResult,
  WaitOptions,
} from "./types.js";
import { sha256Hex } from "./verify.js";

function generateNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function defaultOpenTelegramLink(deepLink: string): void {
  const g = globalThis as unknown as {
    Telegram?: { WebApp?: { openTelegramLink?: (url: string) => void } };
    open?: (url: string, target?: string, features?: string) => void;
  };
  if (g.Telegram?.WebApp?.openTelegramLink && deepLink.startsWith("https://t.me/")) {
    g.Telegram.WebApp.openTelegramLink(deepLink);
    return;
  }
  g.open?.(deepLink, "_blank", "noopener,noreferrer");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("AstroConnect request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("AstroConnect request aborted"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AstroConnectError extends Error {
  readonly code: "rejected" | "expired" | "timeout" | "http_error" | "aborted";

  constructor(
    code: AstroConnectError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AstroConnectError";
    this.code = code;
  }
}

export interface AstroConnectClient {
  createLoginRequest(opts?: LoginOptions): Promise<ConnectRequestHandle>;
  createSignTransactionRequest(
    unsignedXdr: string,
    opts: SignTransactionOptions,
  ): Promise<ConnectRequestHandle>;
  createSignMessageRequest(
    message: string,
    opts?: SignMessageOptions,
  ): Promise<ConnectRequestHandle>;
  getRequestStatus(requestId: string, resultToken: string): Promise<ConnectStatusResponse>;
  waitForResult(
    requestId: string,
    resultToken: string,
    opts?: WaitOptions,
  ): Promise<{ status: ConnectStatusResponse; result: ConnectResult }>;
  openDeepLink(deepLink: string): void;
  login(opts?: LoginOptions): Promise<LoginResult>;
  signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions,
  ): Promise<SignTransactionResult>;
  signMessage(message: string, opts?: SignMessageOptions): Promise<SignMessageResult>;
  resolveIdentity(query: string): Promise<AstroIdentity>;
}

/**
 * Creates a lightweight AstroConnect v1 client for Telegram Mini Apps, Node.js, or Cloudflare Workers.
 */
export function createAstroConnectClient(config: AstroConnectConfig): AstroConnectClient {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchFn ?? fetch;
  const openLinkImpl = config.openLinkFn ?? defaultOpenTelegramLink;

  async function postCreateRequest(body: Record<string, unknown>): Promise<ConnectRequestHandle> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.ecosystemSecret) {
      headers["X-Ecosystem-Secret"] = config.ecosystemSecret;
    }
    const res = await fetchImpl(`${baseUrl}/v1/connect/requests`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as ConnectRequestHandle & { error?: string };
    if (!res.ok) {
      throw new AstroConnectError(
        "http_error",
        data.error ?? `Failed to create AstroConnect request (${res.status})`,
      );
    }
    return data;
  }

  return {
    async createLoginRequest(opts = {}) {
      const nonce = opts.nonce ?? generateNonce();
      return postCreateRequest({
        action: "auth",
        app: config.app,
        ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
        payload: {
          nonce,
          includeAccounts: opts.includeAccounts ?? true,
          ...(opts.statement ? { statement: opts.statement } : {}),
          ...(opts.domain ? { domain: opts.domain } : {}),
        },
      });
    },

    async createSignTransactionRequest(unsignedXdr, opts) {
      const xdrSha256 = await sha256Hex(unsignedXdr);
      return postCreateRequest({
        action: "sign_xdr",
        app: config.app,
        ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
        payload: {
          unsignedXdr,
          xdrSha256,
          submit: opts.submit ?? true,
          humanSummary: opts.humanSummary,
          ...(opts.subAction ? { subAction: opts.subAction } : {}),
        },
      });
    },

    async createSignMessageRequest(message, opts = {}) {
      return postCreateRequest({
        action: "sign_message",
        app: config.app,
        ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
        payload: {
          message,
          ...(opts.humanSummary ? { humanSummary: opts.humanSummary } : {}),
        },
      });
    },

    async getRequestStatus(requestId, resultToken) {
      const res = await fetchImpl(
        `${baseUrl}/v1/connect/requests/${encodeURIComponent(requestId)}`,
        {
          method: "GET",
          headers: { "X-Connect-Token": resultToken },
        },
      );
      const data = (await res.json()) as ConnectStatusResponse & { error?: string };
      if (!res.ok) {
        throw new AstroConnectError(
          "http_error",
          data.error ?? `Failed to poll AstroConnect status (${res.status})`,
        );
      }
      return data;
    },

    async waitForResult(requestId, resultToken, opts = {}) {
      const pollIntervalMs = opts.pollIntervalMs ?? 1500;
      const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        if (opts.signal?.aborted) {
          throw new AstroConnectError("aborted", "AstroConnect request aborted");
        }
        const status = await this.getRequestStatus(requestId, resultToken);
        if (status.status === "approved" && status.result) {
          return { status, result: status.result };
        }
        if (status.status === "rejected") {
          throw new AstroConnectError(
            "rejected",
            status.result?.reason ?? "User rejected request in AstroWallet",
          );
        }
        if (status.status === "expired") {
          throw new AstroConnectError("expired", "AstroConnect request expired");
        }
        if (Date.now() >= deadline) {
          throw new AstroConnectError("timeout", "Timed out waiting for AstroWallet response");
        }
        await sleep(pollIntervalMs, opts.signal).catch((err) => {
          throw new AstroConnectError(
            "aborted",
            err instanceof Error ? err.message : "AstroConnect request aborted",
          );
        });
      }
    },

    openDeepLink(deepLink) {
      openLinkImpl(deepLink);
    },

    async login(opts = {}) {
      const handle = await this.createLoginRequest(opts);
      if (opts.autoOpen ?? true) {
        this.openDeepLink(handle.deepLink);
      }
      const { status, result } = await this.waitForResult(
        handle.requestId,
        handle.resultToken,
        opts,
      );
      if (!result.address || !result.signatureBase64 || !result.signedMessage) {
        throw new AstroConnectError("http_error", "Incomplete login proof returned by AstroWallet");
      }
      return {
        requestId: handle.requestId,
        network: status.network,
        address: result.address,
        accounts: result.accounts ?? [],
        telegramUserId: result.telegramUserId,
        username: result.username,
        challengeMessage: result.signedMessage,
        signatureBase64: result.signatureBase64,
        completedAt: result.completedAt,
      };
    },

    async signTransaction(unsignedXdr, opts) {
      const handle = await this.createSignTransactionRequest(unsignedXdr, opts);
      if (opts.autoOpen ?? true) {
        this.openDeepLink(handle.deepLink);
      }
      const { status, result } = await this.waitForResult(
        handle.requestId,
        handle.resultToken,
        opts,
      );
      return {
        requestId: handle.requestId,
        network: status.network,
        address: result.address,
        signedXdr: result.signedXdr,
        txHash: result.txHash,
        ledger: result.ledger,
        completedAt: result.completedAt,
      };
    },

    async signMessage(message, opts = {}) {
      const handle = await this.createSignMessageRequest(message, opts);
      if (opts.autoOpen ?? true) {
        this.openDeepLink(handle.deepLink);
      }
      const { status, result } = await this.waitForResult(
        handle.requestId,
        handle.resultToken,
        opts,
      );
      if (!result.address || !result.signatureBase64) {
        throw new AstroConnectError(
          "http_error",
          "Incomplete message signature returned by AstroWallet",
        );
      }
      return {
        requestId: handle.requestId,
        network: status.network,
        address: result.address,
        message: result.signedMessage ?? message,
        signatureBase64: result.signatureBase64,
        completedAt: result.completedAt,
      };
    },

    async resolveIdentity(query) {
      const res = await fetchImpl(
        `${baseUrl}/v1/identity/resolve?q=${encodeURIComponent(query)}`,
      );
      const data = (await res.json()) as AstroIdentity & { error?: string };
      if (!res.ok) {
        throw new AstroConnectError(
          "http_error",
          data.error ?? `Failed to resolve AstroID (${res.status})`,
        );
      }
      return data;
    },
  };
}
