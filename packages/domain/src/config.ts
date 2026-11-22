import { z } from "zod";
import {
  ContractAddressSchema,
  TonNetworkSchema,
  type ContractAddress,
  type TonNetwork,
} from "./accounts.js";

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

function parseBooleanWithDefault(defaultValue: boolean) {
  return z.preprocess((val) => {
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      const normalized = val.trim().toLowerCase();
      if (normalized === "") return undefined;
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
    return val;
  }, z.boolean().default(defaultValue));
}

const OptionalShortNameSchema = (field: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{3,64}$/, `${field} must be 3-64 alphanumeric/underscore characters`)
      .optional(),
  );

const OptionalBotUsernameSchema = (field: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .transform((v) => v.replace(/^@/, ""))
      .refine(
        (v) => /^[A-Za-z0-9_]{5,32}$/.test(v),
        `${field} must be a valid Telegram bot username (5-32 chars)`,
      )
      .optional(),
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

function parseBotUsernameCsv(field: string) {
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
            .map((part) => part.trim().replace(/^@/, "").toLowerCase())
            .filter(Boolean),
        ),
      ),
    )
    .superRefine((bots, ctx) => {
      for (const bot of bots) {
        if (!/^[a-z0-9_]{5,32}$/.test(bot)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} contains invalid Telegram bot username "${bot}"`,
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

function parsePositiveStroopsStringWithDefault(field: string, defaultValue: string) {
  return z.preprocess(
    (val) => emptyToUndefined(val) ?? defaultValue,
    z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine(
        (v) => /^\d+$/.test(v) && BigInt(v) > 0n,
        `${field} must be a positive integer string in stroops`,
      ),
  );
}

function validateNetworkCoherence(
  network: StellarNetwork,
  passphrase: string,
  urls: ReadonlyArray<string | undefined>,
  ctx: z.RefinementCtx,
  passphrasePath: string,
  urlPath: string,
) {
  if (network === "mainnet" && /\btest\b/i.test(passphrase)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [passphrasePath],
      message: `${passphrasePath} cannot reference a test network when network=mainnet`,
    });
  }
  if (network === "testnet" && /\bpublic\b/i.test(passphrase)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [passphrasePath],
      message: `${passphrasePath} cannot reference a public mainnet passphrase when network=testnet`,
    });
  }
  if (network === "mainnet") {
    for (const u of urls) {
      if (u && u.trim().toLowerCase().startsWith("http://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [urlPath],
          message: `Plaintext http:// endpoint "${u}" is strictly forbidden when network=mainnet`,
        });
      }
    }
  }
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
    VITE_TG_MINI_APP_SHORT_NAME: OptionalShortNameSchema("VITE_TG_MINI_APP_SHORT_NAME"),
    VITE_ASTRODEX_BOT_USERNAME: OptionalBotUsernameSchema("VITE_ASTRODEX_BOT_USERNAME"),
    VITE_ASTRODEX_MINI_APP_SHORT_NAME: OptionalShortNameSchema("VITE_ASTRODEX_MINI_APP_SHORT_NAME"),
    VITE_ASTROGATE_BOT_USERNAME: OptionalBotUsernameSchema("VITE_ASTROGATE_BOT_USERNAME"),
    VITE_TON_NETWORK: z.preprocess(emptyToUndefined, TonNetworkSchema.optional()),
    VITE_TON_RPC_URLS: parseUrlCsv("VITE_TON_RPC_URLS", false),
    VITE_TON_BRIDGE_URL: OptionalUrlSchema("VITE_TON_BRIDGE_URL"),
    VITE_TON_EXPLORER_BASE_URL: OptionalUrlSchema("VITE_TON_EXPLORER_BASE_URL"),
    VITE_ALLOW_DEV_OUTSIDE_TELEGRAM: parseBooleanWithDefault(false),
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
    VITE_SOROBITS_EXPLORER_URL: OptionalUrlSchema("VITE_SOROBITS_EXPLORER_URL"),
    VITE_SOROBAN_MAX_RESOURCE_FEE_STROOPS: parsePositiveStroopsStringWithDefault(
      "VITE_SOROBAN_MAX_RESOURCE_FEE_STROOPS",
      "5000000",
    ),
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
    if (env.VITE_STELLAR_NETWORK === "mainnet" && env.VITE_ALLOW_DEV_OUTSIDE_TELEGRAM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VITE_ALLOW_DEV_OUTSIDE_TELEGRAM"],
        message:
          "VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true is strictly forbidden when VITE_STELLAR_NETWORK=mainnet",
      });
    }
    validateNetworkCoherence(
      env.VITE_STELLAR_NETWORK,
      env.VITE_STELLAR_NETWORK_PASSPHRASE,
      [
        ...env.VITE_STELLAR_RPC_URLS,
        ...env.VITE_HORIZON_URLS,
        env.VITE_API_BASE_URL,
        env.VITE_PWA_ORIGIN,
        ...env.VITE_SEP42_ASSET_LIST_URLS,
        env.VITE_EXPLORER_BASE_URL,
        env.VITE_SOROBITS_EXPLORER_URL,
        env.VITE_CCTP_BRIDGE_URL,
        env.VITE_MOONPAY_WIDGET_URL,
        env.VITE_TRANSAK_WIDGET_URL,
        ...env.VITE_TON_RPC_URLS,
        env.VITE_TON_BRIDGE_URL,
        env.VITE_TON_EXPLORER_BASE_URL,
      ],
      ctx,
      "VITE_STELLAR_NETWORK_PASSPHRASE",
      "VITE_STELLAR_NETWORK",
    );
  });

export interface PwaConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  rpcUrls: string[];
  horizonUrls: string[];
  apiBaseUrl: string;
  pwaOrigin: string;
  tgBotUsername: string;
  tgMiniAppShortName?: string | undefined;
  astrodexBotUsername?: string | undefined;
  astrodexMiniAppShortName?: string | undefined;
  astrogateBotUsername?: string | undefined;
  tonNetwork: TonNetwork;
  tonRpcUrls: string[];
  tonBridgeUrl?: string | undefined;
  tonExplorerBaseUrl?: string | undefined;
  allowDevOutsideTelegram: boolean;
  friendbotUrl?: string | undefined;
  smartAccountWasmHash?: string | undefined;
  claimEscrowContractId?: string | undefined;
  sorobitsContractId?: string | undefined;
  sep42AssetListUrls: string[];
  explorerBaseUrl?: string | undefined;
  sorobitsExplorerUrl?: string | undefined;
  sorobanMaxResourceFeeStroops: string;
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
    tgMiniAppShortName: parsed.VITE_TG_MINI_APP_SHORT_NAME,
    astrodexBotUsername: parsed.VITE_ASTRODEX_BOT_USERNAME,
    astrodexMiniAppShortName: parsed.VITE_ASTRODEX_MINI_APP_SHORT_NAME,
    astrogateBotUsername: parsed.VITE_ASTROGATE_BOT_USERNAME,
    tonNetwork: parsed.VITE_TON_NETWORK ?? parsed.VITE_STELLAR_NETWORK,
    tonRpcUrls: parsed.VITE_TON_RPC_URLS,
    tonBridgeUrl: parsed.VITE_TON_BRIDGE_URL,
    tonExplorerBaseUrl: parsed.VITE_TON_EXPLORER_BASE_URL,
    allowDevOutsideTelegram: parsed.VITE_ALLOW_DEV_OUTSIDE_TELEGRAM,
    friendbotUrl: parsed.VITE_FRIENDBOT_URL,
    smartAccountWasmHash: parsed.VITE_SMART_ACCOUNT_WASM_HASH,
    claimEscrowContractId: parsed.VITE_CLAIM_ESCROW_CONTRACT_ID,
    sorobitsContractId: parsed.VITE_SOROBITS_CONTRACT_ID,
    sep42AssetListUrls: parsed.VITE_SEP42_ASSET_LIST_URLS,
    explorerBaseUrl: parsed.VITE_EXPLORER_BASE_URL,
    sorobitsExplorerUrl: parsed.VITE_SOROBITS_EXPLORER_URL,
    sorobanMaxResourceFeeStroops: parsed.VITE_SOROBAN_MAX_RESOURCE_FEE_STROOPS,
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
    ASTRODEX_API_BASE_URL: OptionalUrlSchema("ASTRODEX_API_BASE_URL"),
    ASTROGATE_API_BASE_URL: OptionalUrlSchema("ASTROGATE_API_BASE_URL"),
    SEP42_ASSET_LIST_URLS: parseUrlCsv("SEP42_ASSET_LIST_URLS", false),
    CLAIM_ESCROW_CONTRACT_ID: z.preprocess(
      emptyToUndefined,
      ContractAddressSchema.optional(),
    ),
    SMART_ACCOUNT_WASM_HASH: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{64}$/, "SMART_ACCOUNT_WASM_HASH must be 64 hex chars")
        .optional(),
    ),
    RELAY_ALLOWED_CONTRACTS: parseContractCsv("RELAY_ALLOWED_CONTRACTS"),
    RELAY_RATE_LIMIT_PER_MIN: parsePositiveIntWithDefault(10, 1000),
    PROXY_RATE_LIMIT_PER_MIN: parsePositiveIntWithDefault(60, 5000),
    RELAY_MAX_OPERATIONS: parsePositiveIntWithDefault(5, 20),
    RELAY_MAX_FEE_STROOPS: parsePositiveStroopsStringWithDefault(
      "RELAY_MAX_FEE_STROOPS",
      "2000000",
    ),
    RELAY_DAILY_BUDGET_STROOPS: parsePositiveStroopsStringWithDefault(
      "RELAY_DAILY_BUDGET_STROOPS",
      "500000000",
    ),
    TELEGRAM_API_ORIGIN: OptionalUrlSchema("TELEGRAM_API_ORIGIN"),
    TG_BOT_USERNAME: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .transform((v) => v.replace(/^@/, ""))
        .refine(
          (v) => /^[A-Za-z0-9_]{5,32}$/.test(v),
          "TG_BOT_USERNAME must be a valid Telegram bot username (5-32 chars)",
        )
        .optional(),
    ),
    TG_MINI_APP_SHORT_NAME: OptionalShortNameSchema("TG_MINI_APP_SHORT_NAME"),
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
    ECOSYSTEM_SHARED_INTENT_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .min(32, "ECOSYSTEM_SHARED_INTENT_SECRET must be at least 32 characters")
        .optional(),
    ),
    CONNECT_VERIFIED_BOTS: parseBotUsernameCsv("CONNECT_VERIFIED_BOTS"),
  })
  .superRefine((env, ctx) => {
    if (env.STELLAR_NETWORK === "mainnet" && env.FRIENDBOT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FRIENDBOT_URL"],
        message: "FRIENDBOT_URL is strictly forbidden when STELLAR_NETWORK=mainnet",
      });
    }
    validateNetworkCoherence(
      env.STELLAR_NETWORK,
      env.STELLAR_NETWORK_PASSPHRASE,
      [
        ...env.STELLAR_RPC_URLS,
        ...env.HORIZON_URLS,
        env.PWA_ORIGIN,
        ...env.ALLOWED_ORIGINS,
        env.STELLAR_EXPERT_API_BASE,
        env.OZ_CHANNELS_API_URL,
        env.SOROSWAP_API_BASE,
        env.ASTRODEX_API_BASE_URL,
        env.ASTROGATE_API_BASE_URL,
        ...env.SEP42_ASSET_LIST_URLS,
        env.TELEGRAM_API_ORIGIN,
      ],
      ctx,
      "STELLAR_NETWORK_PASSPHRASE",
      "STELLAR_NETWORK",
    );
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
  astrodexApiBaseUrl?: string | undefined;
  astrogateApiBaseUrl?: string | undefined;
  sep42AssetListUrls: string[];
  claimEscrowContractId?: ContractAddress | undefined;
  smartAccountWasmHash?: string | undefined;
  relayAllowedContracts: string[];
  relayRateLimitPerMin: number;
  proxyRateLimitPerMin: number;
  relayMaxOperations: number;
  relayMaxFeeStroops: string;
  relayDailyBudgetStroops: string;
  telegramApiOrigin?: string | undefined;
  tgBotUsername?: string | undefined;
  tgMiniAppShortName?: string | undefined;
  tgBotToken: string;
  tgWebhookSecret: string;
  intentHmacSecret: string;
  ozChannelsApiKey?: string | undefined;
  soroswapApiKey?: string | undefined;
  indexerWebhookSecret?: string | undefined;
  ecosystemSharedIntentSecret?: string | undefined;
  connectVerifiedBots: string[];
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
    astrodexApiBaseUrl: parsed.ASTRODEX_API_BASE_URL,
    astrogateApiBaseUrl: parsed.ASTROGATE_API_BASE_URL,
    sep42AssetListUrls: parsed.SEP42_ASSET_LIST_URLS,
    claimEscrowContractId: parsed.CLAIM_ESCROW_CONTRACT_ID,
    smartAccountWasmHash: parsed.SMART_ACCOUNT_WASM_HASH,
    relayAllowedContracts: parsed.RELAY_ALLOWED_CONTRACTS,
    relayRateLimitPerMin: parsed.RELAY_RATE_LIMIT_PER_MIN,
    proxyRateLimitPerMin: parsed.PROXY_RATE_LIMIT_PER_MIN,
    relayMaxOperations: parsed.RELAY_MAX_OPERATIONS,
    relayMaxFeeStroops: parsed.RELAY_MAX_FEE_STROOPS,
    relayDailyBudgetStroops: parsed.RELAY_DAILY_BUDGET_STROOPS,
    telegramApiOrigin: parsed.TELEGRAM_API_ORIGIN,
    tgBotUsername: parsed.TG_BOT_USERNAME,
    tgMiniAppShortName: parsed.TG_MINI_APP_SHORT_NAME,
    tgBotToken: parsed.TG_BOT_TOKEN,
    tgWebhookSecret: parsed.TG_WEBHOOK_SECRET,
    intentHmacSecret: parsed.INTENT_HMAC_SECRET,
    ozChannelsApiKey: parsed.OZ_CHANNELS_API_KEY,
    soroswapApiKey: parsed.SOROSWAP_API_KEY,
    indexerWebhookSecret: parsed.INDEXER_WEBHOOK_SECRET,
    ecosystemSharedIntentSecret: parsed.ECOSYSTEM_SHARED_INTENT_SECRET,
    connectVerifiedBots: parsed.CONNECT_VERIFIED_BOTS,
  };
}
