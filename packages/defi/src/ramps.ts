import { StrKey } from "@stellar/stellar-sdk";
import type { RampPort, RampQuoteRequest } from "@astrowallet/domain";

function assertSafeHttpsUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error(`${label} must use https://`);
  }
  return parsed;
}

/**
 * MoneyGram Ramps & standard Stellar SEP-24 hosted deposit/withdrawal adapter.
 * Resolves `TRANSFER_SERVER_SEP0024` + `WEB_AUTH_ENDPOINT` from the anchor's `stellar.toml`
 * or builds a direct interactive SEP-24 session link.
 */
export function createSep24AnchorRampAdapter(input: {
  anchorDomain: string;
  assetCode?: string | undefined;
  transferServerUrl?: string | undefined;
  webAuthEndpoint?: string | undefined;
}): RampPort {
  const cleanDomain = input.anchorDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleanDomain)) {
    throw new Error("Invalid SEP-24 anchor domain");
  }
  const baseTransferUrl = input.transferServerUrl?.trim()
    ? assertSafeHttpsUrl(input.transferServerUrl.trim(), "SEP-24 transferServerUrl").toString()
    : `https://${cleanDomain}/sep24`;

  return {
    providerName: "moneygram-sep24",
    async createSessionUrl(request: RampQuoteRequest): Promise<{ url: string }> {
      if (!/^\d+(?:\.\d{1,7})?$/.test(request.amount.trim()) || Number(request.amount) <= 0) {
        throw new Error("SEP-24 ramp amount must be positive");
      }
      if (!/^[GC][A-Z2-7]{55}$/.test(request.destinationAddress)) {
        throw new Error("Valid Stellar G... or C... address is required for SEP-24");
      }
      const actionPath = request.direction === "offramp" ? "withdraw" : "deposit";
      const url = assertSafeHttpsUrl(
        `${baseTransferUrl.replace(/\/+$/, "")}/transactions/${actionPath}/webapp`,
        "SEP-24 interactive URL",
      );
      url.searchParams.set("asset_code", (input.assetCode ?? request.assetCode).trim().toUpperCase());
      url.searchParams.set("account", request.destinationAddress);
      url.searchParams.set("amount", request.amount.trim());
      if (input.webAuthEndpoint?.trim()) {
        url.searchParams.set(
          "web_auth",
          assertSafeHttpsUrl(input.webAuthEndpoint.trim(), "SEP-10 webAuthEndpoint").toString(),
        );
      }
      return { url: url.toString() };
    },
  };
}

export const NEAR_STELLAR_USDC_ASSET_ID =
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";
export const NEAR_STELLAR_XLM_ASSET_ID =
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";

export interface NearIntentsQuoteInput {
  originAsset: string;
  destinationAsset: string;
  amountAtomic: string;
  recipient: string;
  refundTo: string;
  dry?: boolean | undefined;
  slippageToleranceBps?: number | undefined;
}

export interface NearIntentsQuoteResult {
  depositAddress: string;
  depositMemo?: string | undefined;
  amountInFormatted?: string | undefined;
  amountOutFormatted?: string | undefined;
  minAmountOut?: string | undefined;
  timeEstimateSeconds?: number | undefined;
  dry: boolean;
}

/**
 * NEAR Intents 1Click API adapter (`POST /v0/quote`).
 * Strictly enforces `"depositMode": "MEMO"` for Stellar-origin swaps and rejects
 * Stellar-origin responses that omit `depositMemo`.
 */
export function createNearIntentsQuoteAdapter(input: {
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}) {
  const baseUrl = assertSafeHttpsUrl(
    input.apiBaseUrl?.trim() || "https://1click.chaindefuser.com",
    "NEAR Intents API base URL",
  )
    .toString()
    .replace(/\/+$/, "");
  const fetchFn = input.fetchFn ?? fetch;

  return {
    async requestQuote(req: NearIntentsQuoteInput): Promise<NearIntentsQuoteResult> {
      const originLower = req.originAsset.toLowerCase();
      const isStellarOrigin =
        originLower.includes("stellar") ||
        originLower.startsWith("nep245:v2_1.omni.hot.tg:1100_");
      const body: Record<string, unknown> = {
        dry: req.dry ?? true,
        swapType: "EXACT_INPUT",
        slippageTolerance: req.slippageToleranceBps ?? 100,
        originAsset: req.originAsset,
        destinationAsset: req.destinationAsset,
        amount: req.amountAtomic,
        refundTo: req.refundTo,
        recipient: req.recipient,
        deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ...(isStellarOrigin ? { depositMode: "MEMO" } : {}),
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (input.apiKey?.trim()) {
        headers.Authorization = `Bearer ${input.apiKey.trim()}`;
      }

      const res = await fetchFn(`${baseUrl}/v0/quote`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`NEAR Intents quote failed (${res.status}): ${text || "unknown error"}`);
      }

      const json = (await res.json()) as {
        quote?: {
          depositAddress?: string;
          depositMemo?: string;
          amountInFormatted?: string;
          amountOutFormatted?: string;
          minAmountOut?: string;
          timeEstimate?: number;
        };
      };

      const q = json.quote;
      if (!(req.dry ?? true) && !q?.depositAddress) {
        throw new Error("NEAR Intents response missing depositAddress");
      }
      if (!(req.dry ?? true) && isStellarOrigin && !q?.depositMemo) {
        throw new Error(
          "NEAR Intents Stellar-origin quote missing required depositMemo — aborting to prevent uncredited deposit",
        );
      }

      return {
        depositAddress: q?.depositAddress ?? "",
        depositMemo: q?.depositMemo,
        amountInFormatted: q?.amountInFormatted,
        amountOutFormatted: q?.amountOutFormatted,
        minAmountOut: q?.minAmountOut,
        timeEstimateSeconds: q?.timeEstimate,
        dry: req.dry ?? true,
      };
    },
  };
}

/**
 * Encodes a Stellar G... or C... strkey into its raw 32-byte hex payload (`0x...`)
 * required by LayerZero V2 OFT (`USDT0` / Ethena `USDe` / `sUSDe`) cross-chain sends.
 */
export function encodeLayerZeroRecipientBytes32(strkey: string): `0x${string}` {
  const clean = strkey.trim();
  if (clean.startsWith("M")) {
    throw new Error("Muxed M... addresses are unsupported by LayerZero OFT (32-byte limit)");
  }
  let raw: Uint8Array;
  if (StrKey.isValidContract(clean)) {
    raw = StrKey.decodeContract(clean);
  } else if (StrKey.isValidEd25519PublicKey(clean)) {
    raw = StrKey.decodeEd25519PublicKey(clean);
  } else {
    throw new Error(`Invalid Stellar G... or C... address: ${strkey}`);
  }
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/**
 * Computes LayerZero OFT 6-decimal shared precision from Stellar 7-decimal stroops
 * and surfaces any 7th-decimal dust remainder before signing.
 */
export function computeLayerZeroOftSharedAmount(stellarDecimalAmount: string): {
  stroops7: bigint;
  sharedUnits6: bigint;
  dustStroops: bigint;
  sendableFormatted: string;
} {
  const cleaned = stellarDecimalAmount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleaned)) {
    throw new Error("Amount must be a positive decimal with up to 7 decimal places");
  }
  const [wholePart = "0", fracPart = ""] = cleaned.split(".");
  const frac7 = fracPart.padEnd(7, "0");
  const stroops7 = BigInt(wholePart) * 10_000_000n + BigInt(frac7);
  if (stroops7 <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  const sharedUnits6 = stroops7 / 10n;
  const dustStroops = stroops7 % 10n;
  const sendableStroops = sharedUnits6 * 10n;
  const whole = sendableStroops / 10_000_000n;
  const frac = (sendableStroops % 10_000_000n).toString().padStart(7, "0");
  return {
    stroops7,
    sharedUnits6,
    dustStroops,
    sendableFormatted: `${whole.toString()}.${frac}`,
  };
}
