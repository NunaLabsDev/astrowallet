import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export interface SorobitAttribute {
  trait_type: string;
  value: string | number;
}

export interface SorobitCollectible {
  tokenId: number;
  name: string;
  edition: number;
  generation: number;
  rankTier: number;
  xpScore: number;
  bornLedger: number;
  soulbound: boolean;
  svgMarkup: string;
  animatedSvgMarkup: string;
  imageDataUrl: string;
  animatedDataUrl: string;
  attributes: readonly SorobitAttribute[];
  realmName: string;
}

export interface FetchOwnerSorobitsInput {
  rpcUrls: readonly string[];
  networkPassphrase: string;
  contractId: ContractAddress;
  ownerAddress: ClassicAddress;
  includeShowcaseGenesis?: boolean | undefined;
  fetchFn?: typeof fetch | undefined;
}

export interface FetchOwnerSorobitsResult {
  owned: SorobitCollectible[];
  showcaseGenesis: SorobitCollectible | null;
}

export interface FetchSorobitShowcaseInput {
  rpcUrls: readonly string[];
  networkPassphrase: string;
  contractId: ContractAddress;
  maxTokens?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export interface FetchSorobitShowcaseResult {
  totalSupply: number;
  tokens: SorobitCollectible[];
}

const DATA_JSON_PREFIX = "data:application/json;utf8,";
const DATA_SVG_PREFIX = "data:image/svg+xml;utf8,";

/**
 * Validates and sanitizes an on-chain `<svg>...</svg>` string so unsafe script tags or handlers never render.
 */
export function sanitizeOnChainSvg(rawSvg: string): string {
  const trimmed = rawSvg.trim();
  if (!trimmed.startsWith("<svg") || !trimmed.endsWith("</svg>")) {
    throw new Error("Invalid SVG markup returned from Soroban contract");
  }
  if (/<script\b/i.test(trimmed) || /\son[a-z]+\s*=/i.test(trimmed) || /javascript:/i.test(trimmed)) {
    throw new Error("Unsafe script or event handler detected in SVG markup");
  }
  return trimmed;
}

export function svgMarkupToDataUrl(svgMarkup: string): string {
  const safe = sanitizeOnChainSvg(svgMarkup);
  return `${DATA_SVG_PREFIX}${encodeURIComponent(safe)}`;
}

/**
 * Parses a SEP-50 `token_uri` JSON payload (`data:application/json;utf8,...` or raw JSON).
 */
export function parseSorobitTokenUriJson(rawUri: string): {
  name: string;
  attributes: SorobitAttribute[];
  svgMarkup: string;
} {
  const jsonText = rawUri.startsWith(DATA_JSON_PREFIX)
    ? rawUri.slice(DATA_JSON_PREFIX.length)
    : rawUri;

  const parsed = JSON.parse(jsonText) as {
    name?: unknown;
    image?: unknown;
    attributes?: unknown;
  };

  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Sorobit";
  const attributes: SorobitAttribute[] = [];
  if (Array.isArray(parsed.attributes)) {
    for (const item of parsed.attributes) {
      if (
        item &&
        typeof item === "object" &&
        "trait_type" in item &&
        "value" in item &&
        typeof (item as { trait_type: unknown }).trait_type === "string"
      ) {
        const val = (item as { value: unknown }).value;
        if (typeof val === "string" || typeof val === "number") {
          attributes.push({
            trait_type: (item as { trait_type: string }).trait_type,
            value: val,
          });
        }
      }
    }
  }

  let svgMarkup = "";
  if (typeof parsed.image === "string" && parsed.image.startsWith(DATA_SVG_PREFIX)) {
    svgMarkup = sanitizeOnChainSvg(parsed.image.slice(DATA_SVG_PREFIX.length));
  }

  return { name, attributes, svgMarkup };
}

function readonlySimulationSource(): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32));
}

async function simulateContractView<T>(input: {
  rpcUrls: readonly string[];
  networkPassphrase: string;
  contractId: ContractAddress;
  fnName: string;
  args: xdr.ScVal[];
  fetchFn: typeof fetch;
}): Promise<T> {
  const source = new Account(readonlySimulationSource(), "0");
  const txXdr = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: input.contractId,
        function: input.fnName,
        args: input.args,
      }),
    )
    .setTimeout(30)
    .build()
    .toXDR();

  let lastError: unknown;
  for (const rpcUrl of input.rpcUrls) {
    try {
      const response = await input.fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: { transaction: txXdr },
        }),
      });
      if (!response.ok) {
        lastError = new Error(`Soroban RPC returned HTTP ${response.status}`);
        continue;
      }

      const payload = (await response.json()) as {
        error?: { message?: string };
        result?: {
          error?: string;
          results?: Array<{ xdr?: string }>;
        };
      };

      if (payload.error) {
        lastError = new Error(payload.error.message ?? "Soroban RPC JSON-RPC error");
        continue;
      }
      if (payload.result?.error) {
        throw new Error(payload.result.error);
      }

      const returnXdr = payload.result?.results?.[0]?.xdr;
      if (!returnXdr) {
        throw new Error(`Missing return XDR from ${input.fnName}`);
      }

      const scVal = xdr.ScVal.fromXDR(returnXdr, "base64");
      return scValToNative(scVal) as T;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Soroban RPC call ${input.fnName} failed`);
}

async function fetchSingleSorobit(input: {
  rpcUrls: readonly string[];
  networkPassphrase: string;
  contractId: ContractAddress;
  tokenId: number;
  fetchFn: typeof fetch;
}): Promise<SorobitCollectible | null> {
  try {
    const tokenIdVal = nativeToScVal(input.tokenId, { type: "u32" });
    const [rec, rawUri, rawAnim] = await Promise.all([
      simulateContractView<Record<string, unknown>>({
        rpcUrls: input.rpcUrls,
        networkPassphrase: input.networkPassphrase,
        contractId: input.contractId,
        fnName: "get_sorobit",
        args: [tokenIdVal],
        fetchFn: input.fetchFn,
      }),
      simulateContractView<string>({
        rpcUrls: input.rpcUrls,
        networkPassphrase: input.networkPassphrase,
        contractId: input.contractId,
        fnName: "token_uri",
        args: [tokenIdVal],
        fetchFn: input.fetchFn,
      }),
      simulateContractView<string>({
        rpcUrls: input.rpcUrls,
        networkPassphrase: input.networkPassphrase,
        contractId: input.contractId,
        fnName: "animated_svg",
        args: [tokenIdVal],
        fetchFn: input.fetchFn,
      }).catch(() => ""),
    ]);

    const parsed = parseSorobitTokenUriJson(rawUri);
    const animSafe = rawAnim ? sanitizeOnChainSvg(rawAnim) : parsed.svgMarkup;
    const staticSafe = parsed.svgMarkup || animSafe;
    if (!staticSafe) return null;

    const factionAttr = parsed.attributes.find((a) => a.trait_type === "Faction");
    const realmName = factionAttr ? String(factionAttr.value) : "Stellar Realm";

    return {
      tokenId: input.tokenId,
      name: parsed.name,
      edition: Number(rec?.edition ?? 0),
      generation: Number(rec?.generation ?? 0),
      rankTier: Number(rec?.rank_tier ?? 0),
      xpScore: Number(rec?.xp_score ?? 0),
      bornLedger: Number(rec?.born_ledger ?? 0),
      soulbound: Boolean(rec?.soulbound),
      svgMarkup: staticSafe,
      animatedSvgMarkup: animSafe,
      imageDataUrl: svgMarkupToDataUrl(staticSafe),
      animatedDataUrl: svgMarkupToDataUrl(animSafe),
      attributes: parsed.attributes,
      realmName,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches live on-chain Sorobits (SEP-50) collectibles owned by an account,
 * plus an optional Genesis #0 showcase token when the account holds none yet.
 */
export async function fetchOwnerSorobits(
  input: FetchOwnerSorobitsInput,
): Promise<FetchOwnerSorobitsResult> {
  const fetchFn = input.fetchFn ?? fetch;

  const rawIds = await simulateContractView<Array<number | bigint>>({
    rpcUrls: input.rpcUrls,
    networkPassphrase: input.networkPassphrase,
    contractId: input.contractId,
    fnName: "tokens_of",
    args: [new Address(input.ownerAddress).toScVal()],
    fetchFn,
  }).catch(() => []);

  const tokenIds = rawIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id >= 0);
  const owned = (
    await Promise.all(
      tokenIds.slice(0, 24).map((tokenId) =>
        fetchSingleSorobit({
          rpcUrls: input.rpcUrls,
          networkPassphrase: input.networkPassphrase,
          contractId: input.contractId,
          tokenId,
          fetchFn,
        }),
      ),
    )
  ).filter((item): item is SorobitCollectible => item !== null);

  let showcaseGenesis: SorobitCollectible | null = null;
  if (owned.length === 0 && input.includeShowcaseGenesis !== false) {
    showcaseGenesis = await fetchSingleSorobit({
      rpcUrls: input.rpcUrls,
      networkPassphrase: input.networkPassphrase,
      contractId: input.contractId,
      tokenId: 0,
      fetchFn,
    });
  }

  return { owned, showcaseGenesis };
}

/**
 * Queries public on-chain Sorobits (SEP-50) supply and loads sanitized token showcase metadata.
 */
export async function fetchSorobitShowcase(
  input: FetchSorobitShowcaseInput,
): Promise<FetchSorobitShowcaseResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const rawSupply = await simulateContractView<number | bigint>({
    rpcUrls: input.rpcUrls,
    networkPassphrase: input.networkPassphrase,
    contractId: input.contractId,
    fnName: "total_supply",
    args: [],
    fetchFn,
  }).catch(() => 3);

  const parsedSupply = Number(rawSupply);
  const totalSupply = Number.isFinite(parsedSupply) && parsedSupply >= 0 ? Math.trunc(parsedSupply) : 3;
  const limit = Math.max(0, Math.min(totalSupply, input.maxTokens ?? 3));

  const ids = Array.from({ length: limit }, (_, idx) => idx);
  const tokens = (
    await Promise.all(
      ids.map((tokenId) =>
        fetchSingleSorobit({
          rpcUrls: input.rpcUrls,
          networkPassphrase: input.networkPassphrase,
          contractId: input.contractId,
          tokenId,
          fetchFn,
        }),
      ),
    )
  ).filter((item): item is SorobitCollectible => item !== null);

  return { totalSupply, tokens };
}
