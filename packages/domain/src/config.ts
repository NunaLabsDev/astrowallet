import { z } from "zod";
import { ContractAddressSchema, type ContractAddress } from "./accounts.js";

export const StellarNetworkSchema = z.enum(["testnet", "mainnet"]);
export type StellarNetwork = z.infer<typeof StellarNetworkSchema>;

interface MinimalUrl {
  protocol: string;
  hostname: string;
}

function parseUrlSafe(raw: string): MinimalUrl | null {
  const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => MinimalUrl }).URL;
  if (!UrlCtor) {
    throw new Error("Global WHATWG URL constructor is required");
  }
  try {
    return new UrlCtor(raw);
  } catch {
    return null;
  }
}

function isAllowedUrl(raw: string): boolean {
  const parsed = parseUrlSafe(raw);
  if (!parsed) return false;
  if (parsed.protocol === "https:") return true;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

const emptyToUndefined = (val: unknown): unknown => {
  if (typeof val === "string" && val.trim() === "") {
    return undefined;
  }
  return val;
};

const RequiredUrlSchema = (field: string) =>
  z
    .string({ required_error: `${field} is required` })
    .trim()
    .min(1, `${field} cannot be empty`)
    .refine(isAllowedUrl, `${field} must be a valid https:// (or localhost http://) URL`);

const OptionalUrlSchema = (field: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine(isAllowedUrl, `${field} must be a valid https:// (or localhost http://) URL`)
      .optional(),
  );

const OptionalNonEmptyStringSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);

function parseContractCsv(field: string) {
  return z
    .preprocess(
      (val) => (typeof val === "string" ? val : ""),
      z.string(),
    )
    .transform((raw) =>
      Array.from(
        new Set(
          raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ),
    )
    .superRefine((contracts, ctx) => {
      for (const addr of contracts) {
        if (!ContractAddressSchema.safeParse(addr).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} contains invalid Soroban contract address "${addr}"`,
          });
        }
      }
    });
}

function parsePositiveIntWithDefault(defaultValue: number, max: number) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(max).default(defaultValue),
  );
}

function parseUrlCsv(field: string, required: boolean) {
  return z
    .preprocess(
      (val) => (typeof val === "string" ? val : ""),
      z.string(),
    )
    .transform((raw) =>
      Array.from(
        new Set(
          raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ),
    )
    .superRefine((urls, ctx) => {
      if (required && urls.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must define at least one valid URL`,
        });
        return;
      }
      for (const url of urls) {
        if (!isAllowedUrl(url)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} contains invalid URL "${url}"`,
          });
        }
      }
    });
}

const RawPwaEnvSchema = z
  .object({
    VITE_STELLAR_NETWORK: StellarNetworkSchema,
    VITE_STELLAR_NETWORK_PASSPHRASE: z
      .string({ required_error: "VITE_STELLAR_NETWORK_PASSPHRASE is required" })
      .trim()
      .min(1, "VITE_STELLAR_NETWORK_PASSPHRASE cannot be empty"),
    VITE_STELLAR_RPC_URLS: parseUrlCsv("VITE_STELLAR_RPC_URLS", true),
    VITE_HORIZON_URLS: parseUrlCsv("VITE_HORIZON_URLS", true),
    VITE_API_BASE_URL: RequiredUrlSchema("VITE_API_BASE_URL"),
    VITE_PWA_ORIGIN: RequiredUrlSchema("VITE_PWA_ORIGIN"),
    VITE_TG_BOT_USERNAME: z
      .string({ required_error: "VITE_TG_BOT_USERNAME is required" })
      .trim()
      .transform((v) => v.replace(/^@/, ""))
      .refine(
        (v) => /^[A-Za-z0-9_]{5,32}$/.test(v),
        "VITE_TG_BOT_USERNAME must be a valid Telegram bot username (5-32 chars)",
      ),
    VITE_FRIENDBOT_URL: OptionalUrlSchema("VITE_FRIENDBOT_URL"),
    VITE_SMART_ACCOUNT_WASM_HASH: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{64}$/, "VITE_SMART_ACCOUNT_WASM_HASH must be 64 hex chars")
        .optional(),
    ),
    VITE_CLAIM_ESCROW_CONTRACT_ID: z.preprocess(
      emptyToUndefined,
      ContractAddressSchema.optional(),
    ),
    VITE_SOROBITS_CONTRACT_ID: z.preprocess(
      emptyToUndefined,
      ContractAddressSchema.optional(),
    ),
    VITE_SEP42_ASSET_LIST_URLS: parseUrlCsv("VITE_SEP42_ASSET_LIST_URLS", false),
    VITE_EXPLORER_BASE_URL: OptionalUrlSchema("VITE_EXPLORER_BASE_URL"),
    VITE_REOWN_PROJECT_ID: OptionalNonEmptyStringSchema,
    VITE_CCTP_BRIDGE_URL: OptionalUrlSchema("VITE_CCTP_BRIDGE_URL"),
    VITE_CCTP_FORWARDER_CONTRACT_ID: z.preprocess(
      emptyToUndefined,
      ContractAddressSchema.optional(),
    ),
    VITE_MOONPAY_WIDGET_URL: OptionalUrlSchema("VITE_MOONPAY_WIDGET_URL"),
    VITE_TRANSAK_WIDGET_URL: OptionalUrlSchema("VITE_TRANSAK_WIDGET_URL"),
  })
  .superRefine((env, ctx) => {
    if (env.VITE_STELLAR_NETWORK === "mainnet" && env.VITE_FRIENDBOT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VITE_FRIENDBOT_URL"],
        message: "VITE_FRIENDBOT_URL is strictly forbidden when VITE_STELLAR_NETWORK=mainnet",
      });
    }
  });

export interface PwaConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  rpcUrls: string[];
  horizonUrls: string[];
  apiBaseUrl: string;
  pwaOrigin: string;
  tgBotUsername: string;
  friendbotUrl?: string | undefined;
  smartAccountWasmHash?: string | undefined;
  claimEscrowContractId?: string | undefined;
  sorobitsContractId?: string | undefined;
  sep42AssetListUrls: string[];
  explorerBaseUrl?: string | undefined;
  reownProjectId?: string | undefined;
  cctpBridgeUrl?: string | undefined;
  cctpForwarderContractId?: ContractAddress | undefined;
  moonPayWidgetUrl?: string | undefined;
  transakWidgetUrl?: string | undefined;
}

export function parsePwaConfig(rawEnv: Record<string, unknown>): PwaConfig {
  const parsed = RawPwaEnvSchema.parse(rawEnv);
  return {
    network: parsed.VITE_STELLAR_NETWORK,
    networkPassphrase: parsed.VITE_STELLAR_NETWORK_PASSPHRASE,
    rpcUrls: parsed.VITE_STELLAR_RPC_URLS,
    horizonUrls: parsed.VITE_HORIZON_URLS,
    apiBaseUrl: parsed.VITE_API_BASE_URL,
    pwaOrigin: parsed.VITE_PWA_ORIGIN,
    tgBotUsername: parsed.VITE_TG_BOT_USERNAME,
    friendbotUrl: parsed.VITE_FRIENDBOT_URL,
    smartAccountWasmHash: parsed.VITE_SMART_ACCOUNT_WASM_HASH,
    claimEscrowContractId: parsed.VITE_CLAIM_ESCROW_CONTRACT_ID,
    sorobitsContractId: parsed.VITE_SOROBITS_CONTRACT_ID,
    sep42AssetListUrls: parsed.VITE_SEP42_ASSET_LIST_URLS,
    explorerBaseUrl: parsed.VITE_EXPLORER_BASE_URL,
    reownProjectId: parsed.VITE_REOWN_PROJECT_ID,
    cctpBridgeUrl: parsed.VITE_CCTP_BRIDGE_URL,
    cctpForwarderContractId: parsed.VITE_CCTP_FORWARDER_CONTRACT_ID,
    moonPayWidgetUrl: parsed.VITE_MOONPAY_WIDGET_URL,
    transakWidgetUrl: parsed.VITE_TRANSAK_WIDGET_URL,
  };
}

const RawServerEnvSchema = z
  .object({
    STELLAR_NETWORK: StellarNetworkSchema,
    STELLAR_NETWORK_PASSPHRASE: z
      .string({ required_error: "STELLAR_NETWORK_PASSPHRASE is required" })
      .trim()
      .min(1, "STELLAR_NETWORK_PASSPHRASE cannot be empty"),
    STELLAR_RPC_URLS: parseUrlCsv("STELLAR_RPC_URLS", true),
    HORIZON_URLS: parseUrlCsv("HORIZON_URLS", true),
    PWA_ORIGIN: RequiredUrlSchema("PWA_ORIGIN"),
    ALLOWED_ORIGINS: parseUrlCsv("ALLOWED_ORIGINS", true),
    FRIENDBOT_URL: OptionalUrlSchema("FRIENDBOT_URL"),
    STELLAR_EXPERT_API_BASE: OptionalUrlSchema("STELLAR_EXPERT_API_BASE"),
    OZ_CHANNELS_API_URL: OptionalUrlSchema("OZ_CHANNELS_API_URL"),
    SOROSWAP_API_BASE: OptionalUrlSchema("SOROSWAP_API_BASE"),
    SEP42_ASSET_LIST_URLS: parseUrlCsv("SEP42_ASSET_LIST_URLS", false),
    CLAIM_ESCROW_CONTRACT_ID: z.preprocess(
      emptyToUndefined,
      ContractAddressSchema.optional(),
    ),
    RELAY_ALLOWED_CONTRACTS: parseContractCsv("RELAY_ALLOWED_CONTRACTS"),
    RELAY_RATE_LIMIT_PER_MIN: parsePositiveIntWithDefault(10, 1000),
    PROXY_RATE_LIMIT_PER_MIN: parsePositiveIntWithDefault(60, 5000),
    TG_BOT_TOKEN: z
      .string({ required_error: "TG_BOT_TOKEN is required" })
      .trim()
      .min(1, "TG_BOT_TOKEN cannot be empty"),
    TG_WEBHOOK_SECRET: z
      .string({ required_error: "TG_WEBHOOK_SECRET is required" })
      .trim()
      .min(16, "TG_WEBHOOK_SECRET must be at least 16 characters"),
    INTENT_HMAC_SECRET: z
      .string({ required_error: "INTENT_HMAC_SECRET is required" })
      .trim()
      .min(32, "INTENT_HMAC_SECRET must be at least 32 characters"),
    OZ_CHANNELS_API_KEY: OptionalNonEmptyStringSchema,
    SOROSWAP_API_KEY: OptionalNonEmptyStringSchema,
    INDEXER_WEBHOOK_SECRET: OptionalNonEmptyStringSchema,
  })
  .superRefine((env, ctx) => {
    if (env.STELLAR_NETWORK === "mainnet" && env.FRIENDBOT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FRIENDBOT_URL"],
        message: "FRIENDBOT_URL is strictly forbidden when STELLAR_NETWORK=mainnet",
      });
    }
  });

export interface ServerConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  rpcUrls: string[];
  horizonUrls: string[];
  pwaOrigin: string;
  allowedOrigins: string[];
  friendbotUrl?: string | undefined;
  stellarExpertApiBase?: string | undefined;
  ozChannelsApiUrl?: string | undefined;
  soroswapApiBase?: string | undefined;
  sep42AssetListUrls: string[];
  claimEscrowContractId?: ContractAddress | undefined;
  relayAllowedContracts: string[];
  relayRateLimitPerMin: number;
  proxyRateLimitPerMin: number;
  tgBotToken: string;
  tgWebhookSecret: string;
  intentHmacSecret: string;
  ozChannelsApiKey?: string | undefined;
  soroswapApiKey?: string | undefined;
  indexerWebhookSecret?: string | undefined;
}

export function parseServerConfig(rawEnv: Record<string, unknown>): ServerConfig {
  const parsed = RawServerEnvSchema.parse(rawEnv);
  return {
    network: parsed.STELLAR_NETWORK,
    networkPassphrase: parsed.STELLAR_NETWORK_PASSPHRASE,
    rpcUrls: parsed.STELLAR_RPC_URLS,
    horizonUrls: parsed.HORIZON_URLS,
    pwaOrigin: parsed.PWA_ORIGIN,
    allowedOrigins: parsed.ALLOWED_ORIGINS,
    friendbotUrl: parsed.FRIENDBOT_URL,
    stellarExpertApiBase: parsed.STELLAR_EXPERT_API_BASE,
    ozChannelsApiUrl: parsed.OZ_CHANNELS_API_URL,
    soroswapApiBase: parsed.SOROSWAP_API_BASE,
    sep42AssetListUrls: parsed.SEP42_ASSET_LIST_URLS,
    claimEscrowContractId: parsed.CLAIM_ESCROW_CONTRACT_ID,
    relayAllowedContracts: parsed.RELAY_ALLOWED_CONTRACTS,
    relayRateLimitPerMin: parsed.RELAY_RATE_LIMIT_PER_MIN,
    proxyRateLimitPerMin: parsed.PROXY_RATE_LIMIT_PER_MIN,
    tgBotToken: parsed.TG_BOT_TOKEN,
    tgWebhookSecret: parsed.TG_WEBHOOK_SECRET,
    intentHmacSecret: parsed.INTENT_HMAC_SECRET,
    ozChannelsApiKey: parsed.OZ_CHANNELS_API_KEY,
    soroswapApiKey: parsed.SOROSWAP_API_KEY,
    indexerWebhookSecret: parsed.INDEXER_WEBHOOK_SECRET,
  };
}
