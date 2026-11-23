import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { StrKey } from "@stellar/stellar-sdk";
import { createFailoverEndpoints } from "../network.js";
import { resolveSacContractId } from "../smart-account/index.js";

export type TokenPriceTimeframe = "24h" | "7d" | "30d" | "1y" | "all";

export interface TokenIssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export interface StellarTomlCurrencyMeta {
  code: string;
  issuer?: string | undefined;
  name?: string | undefined;
  desc?: string | undefined;
  image?: string | undefined;
  linkedTomlUrl?: string | undefined;
  conditions?: string | undefined;
  isAssetAnchored?: boolean | undefined;
  anchorAsset?: string | undefined;
  orgName?: string | undefined;
  orgUrl?: string | undefined;
}

export interface StellarTokenDetails {
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  isNative: boolean;
  sacContractId: ContractAddress;
  homeDomain?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  image?: string | undefined;
  orgName?: string | undefined;
  orgUrl?: string | undefined;
  isAssetAnchored?: boolean | undefined;
  anchorAsset?: string | undefined;
  supplyAmount: string;
  numAccounts: number;
  authorizedToMaintainLiabilitiesAccounts?: number | undefined;
  unauthorizedAccounts?: number | undefined;
  numClaimableBalances?: number | undefined;
  numLiquidityPools?: number | undefined;
  numContracts?: number | undefined;
  contractsAmount?: string | undefined;
  claimableBalancesAmount?: string | undefined;
  liquidityPoolsAmount?: string | undefined;
  latestLedgerSequence?: number | undefined;
  baseFeeStroops?: number | undefined;
  baseReserveStroops?: number | undefined;
  maxTxSetSize?: number | undefined;
  protocolVersion?: number | undefined;
  flags: TokenIssuerFlags;
}

export interface TokenPriceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
}

export interface TokenPriceHistoryResult {
  timeframe: TokenPriceTimeframe;
  quoteCode: string;
  quoteIssuer?: ClassicAddress | undefined;
  candles: TokenPriceCandle[];
  latestPriceXlm: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volumeBase: number;
  source: "trade_aggregations" | "order_book" | "trades" | "parity";
}

export interface TokenOrderbookLevel {
  price: string;
  amount: string;
}

export interface TokenOrderbookSnapshot {
  quoteCode: string;
  quoteIssuer?: ClassicAddress | undefined;
  bids: TokenOrderbookLevel[];
  asks: TokenOrderbookLevel[];
  midPriceXlm: string | null;
  spreadPct: string | null;
}

export interface TokenCatalogItem {
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  name?: string | undefined;
  domain?: string | undefined;
  icon?: string | undefined;
  numAccounts?: number | undefined;
  supplyAmount?: string | undefined;
  isVerified: boolean;
  userBalance?: string | undefined;
  hasTrustline: boolean;
  hasLiquidityPool?: boolean | undefined;
  poolReserveAmount?: string | undefined;
}

interface HorizonAssetRecord {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  balances?: {
    authorized?: string;
  };
  accounts?: {
    authorized?: number;
    authorized_to_maintain_liabilities?: number;
    unauthorized?: number;
  };
  num_claimable_balances?: number;
  num_liquidity_pools?: number;
  num_contracts?: number;
  contracts_amount?: string;
  claimable_balances_amount?: string;
  liquidity_pools_amount?: string;
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  };
  _links?: {
    toml?: { href?: string };
  };
}

interface HorizonTradeAggRecord {
  timestamp?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  base_volume?: string;
}

interface HorizonOrderbookResponse {
  bids?: Array<{ price?: string; amount?: string }>;
  asks?: Array<{ price?: string; amount?: string }>;
}

interface HorizonTradeRecord {
  ledger_close_time?: string;
  base_amount?: string;
  price?: { n?: string | number; d?: string | number };
}

function resolveAssetQueryParams(
  prefix: string,
  assetCode: string,
  assetIssuer?: string,
): Record<string, string> {
  const code = assetCode.trim();
  if (code.toUpperCase() === "XLM" && !assetIssuer) {
    return {
      [`${prefix}_asset_type`]: "native",
    };
  }
  const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return {
    [`${prefix}_asset_type`]: type,
    [`${prefix}_asset_code`]: code,
    ...(assetIssuer ? { [`${prefix}_asset_issuer`]: assetIssuer } : {}),
  };
}

async function fetchJsonWithHorizonFailover<T>(
  horizonUrls: readonly string[],
  pathAndQuery: string,
  fetchFn: typeof fetch = fetch,
): Promise<T | null> {
  const endpoints = createFailoverEndpoints(horizonUrls);
  const urls = endpoints.list();
  let lastErr: unknown;

  for (let i = 0; i < urls.length; i += 1) {
    const base = endpoints.current().replace(/\/+$/, "");
    try {
      const res = await fetchFn(`${base}${pathAndQuery}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        lastErr = new Error(`Horizon returned HTTP ${res.status}`);
        endpoints.next();
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      endpoints.next();
    }
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  return null;
}

function parseFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseTradePrice(price?: { n?: string | number; d?: string | number }): number | null {
  if (!price) return null;
  const n = parseFiniteNumber(price.n);
  const d = parseFiniteNumber(price.d);
  if (n === null || d === null || d <= 0) return null;
  const val = n / d;
  return Number.isFinite(val) && val > 0 ? val : null;
}

function extractDomainFromTomlHref(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href).hostname || undefined;
  } catch {
    return undefined;
  }
}

function cleanHttpsUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stripTomlInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === null) {
        quote = ch;
      } else if (quote === ch) {
        quote = null;
      }
      continue;
    }
    if (ch === "#" && quote === null) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlScalarValue(rawVal: string): string | boolean | undefined {
  const trimmed = rawVal.trim();
  if (!trimmed) return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * Parses a SEP-0001 `stellar.toml` document to extract `[DOCUMENTATION]` and
 * matching `[[CURRENCIES]]` metadata (name, description, HTTPS image logo, anchor info).
 */
export function parseStellarTomlForAsset(
  tomlText: string,
  assetCode: string,
  assetIssuer?: string,
): StellarTomlCurrencyMeta | null {
  const targetCode = assetCode.trim().toUpperCase();
  const targetIssuer = assetIssuer?.trim();
  if (!targetCode || !tomlText.trim()) return null;

  let section: "root" | "documentation" | "currency" | "other" = "root";
  let orgName: string | undefined;
  let orgUrl: string | undefined;
  const currencies: Array<Record<string, string | boolean>> = [];
  let currentCurrency: Record<string, string | boolean> | null = null;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const cleanLine = stripTomlInlineComment(rawLine).trim();
    if (!cleanLine) continue;

    if (cleanLine.toUpperCase() === "[[CURRENCIES]]") {
      currentCurrency = {};
      currencies.push(currentCurrency);
      section = "currency";
      continue;
    }
    if (cleanLine.startsWith("[")) {
      currentCurrency = null;
      const header = cleanLine.toUpperCase();
      section = header === "[DOCUMENTATION]" ? "documentation" : "other";
      continue;
    }

    const eqIdx = cleanLine.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleanLine.slice(0, eqIdx).trim();
    const val = parseTomlScalarValue(cleanLine.slice(eqIdx + 1));
    if (val === undefined) continue;

    if (section === "currency" && currentCurrency) {
      currentCurrency[key] = val;
    } else if (section === "documentation" || section === "root") {
      if (key === "ORG_NAME" && typeof val === "string") {
        orgName = val.trim() || orgName;
      } else if (key === "ORG_DBA" && typeof val === "string" && !orgName) {
        orgName = val.trim() || orgName;
      } else if (key === "ORG_URL" && typeof val === "string") {
        orgUrl = cleanHttpsUrl(val) ?? orgUrl;
      }
    }
  }

  const matched = currencies.find((c) => {
    const code = typeof c.code === "string" ? c.code.trim().toUpperCase() : "";
    if (code !== targetCode) return false;
    const issuer = typeof c.issuer === "string" ? c.issuer.trim() : "";
    if (targetIssuer && issuer && issuer !== targetIssuer) return false;
    return true;
  });

  if (!matched) {
    return null;
  }

  const resolvedImage =
    typeof matched.image === "string" ? cleanHttpsUrl(matched.image) : undefined;
  const linkedTomlUrl =
    typeof matched.toml === "string" ? cleanHttpsUrl(matched.toml) : undefined;

  return {
    code: targetCode,
    ...(typeof matched.issuer === "string" ? { issuer: matched.issuer.trim() } : {}),
    ...(typeof matched.name === "string" && matched.name.trim()
      ? { name: matched.name.trim() }
      : {}),
    ...(typeof matched.desc === "string" && matched.desc.trim()
      ? { desc: matched.desc.trim() }
      : {}),
    ...(resolvedImage ? { image: resolvedImage } : {}),
    ...(linkedTomlUrl ? { linkedTomlUrl } : {}),
    ...(typeof matched.conditions === "string" && matched.conditions.trim()
      ? { conditions: matched.conditions.trim() }
      : {}),
    ...(typeof matched.is_asset_anchored === "boolean"
      ? { isAssetAnchored: matched.is_asset_anchored }
      : {}),
    ...(typeof matched.anchor_asset === "string" && matched.anchor_asset.trim()
      ? { anchorAsset: matched.anchor_asset.trim() }
      : {}),
    ...(orgName ? { orgName } : {}),
    ...(orgUrl ? { orgUrl } : {}),
  };
}

function parseLinkedCurrencyTomlFields(tomlText: string): Partial<StellarTomlCurrencyMeta> {
  const fields: Record<string, string | boolean> = {};
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const cleanLine = stripTomlInlineComment(rawLine).trim();
    if (!cleanLine || cleanLine.startsWith("[")) continue;
    const eqIdx = cleanLine.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleanLine.slice(0, eqIdx).trim();
    const val = parseTomlScalarValue(cleanLine.slice(eqIdx + 1));
    if (val !== undefined) {
      fields[key] = val;
    }
  }
  const image = typeof fields.image === "string" ? cleanHttpsUrl(fields.image) : undefined;
  return {
    ...(typeof fields.name === "string" && fields.name.trim() ? { name: fields.name.trim() } : {}),
    ...(typeof fields.desc === "string" && fields.desc.trim() ? { desc: fields.desc.trim() } : {}),
    ...(image ? { image } : {}),
    ...(typeof fields.conditions === "string" && fields.conditions.trim()
      ? { conditions: fields.conditions.trim() }
      : {}),
    ...(typeof fields.is_asset_anchored === "boolean"
      ? { isAssetAnchored: fields.is_asset_anchored }
      : {}),
    ...(typeof fields.anchor_asset === "string" && fields.anchor_asset.trim()
      ? { anchorAsset: fields.anchor_asset.trim() }
      : {}),
  };
}

const STELLAR_TOML_CACHE_TTL_MS = 15 * 60 * 1000;
const stellarTomlTextCache = new Map<string, { expiresAt: number; text: string | null }>();

function normalizeDomainName(rawDomain: string): string | null {
  const cleaned = rawDomain.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return extractDomainFromTomlHref(cleaned) ?? null;
  }
  const hostOnly = cleaned.split("/")[0]?.trim() ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostOnly) ? hostOnly : null;
}

/**
 * Fetches and parses an issuer's SEP-0001 `stellar.toml` via the Worker proxy (if configured)
 * or directly over HTTPS, caching per domain for 15 minutes.
 */
export async function fetchAssetStellarTomlMeta(input: {
  domain: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  apiBaseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<StellarTomlCurrencyMeta | null> {
  const domain = normalizeDomainName(input.domain);
  if (!domain) return null;

  const useCache = !input.fetchFn;
  const now = Date.now();
  if (useCache) {
    const cached = stellarTomlTextCache.get(domain);
    if (cached && cached.expiresAt > now) {
      return cached.text
        ? parseStellarTomlForAsset(cached.text, input.assetCode, input.assetIssuer)
        : null;
    }
  }

  const fetchFn = input.fetchFn ?? fetch;
  let tomlText: string | null = null;

  if (input.apiBaseUrl) {
    try {
      const proxyUrl = `${input.apiBaseUrl.replace(/\/+$/, "")}/v1/proxy/stellar-toml?domain=${encodeURIComponent(domain)}`;
      const res = await fetchFn(proxyUrl, {
        headers: { Accept: "text/plain" },
      });
      if (res.ok) {
        tomlText = await res.text();
      }
    } catch {
      // Fall through to direct HTTPS stellar.toml lookup
    }
  }

  if (tomlText === null) {
    try {
      const res = await fetchFn(`https://${domain}/.well-known/stellar.toml`, {
        headers: { Accept: "text/plain" },
      });
      if (res.ok) {
        tomlText = await res.text();
      }
    } catch {
      tomlText = null;
    }
  }

  if (useCache) {
    stellarTomlTextCache.set(domain, {
      expiresAt: now + STELLAR_TOML_CACHE_TTL_MS,
      text: tomlText,
    });
  }

  const parsed = tomlText
    ? parseStellarTomlForAsset(tomlText, input.assetCode, input.assetIssuer)
    : null;

  if (parsed?.linkedTomlUrl && !parsed.image) {
    try {
      const linkedRes = await fetchFn(parsed.linkedTomlUrl, {
        headers: { Accept: "text/plain" },
      });
      if (linkedRes.ok) {
        const linkedText = await linkedRes.text();
        const linkedMeta =
          parseStellarTomlForAsset(linkedText, input.assetCode, input.assetIssuer) ??
          parseLinkedCurrencyTomlFields(linkedText);
        return {
          ...parsed,
          name: parsed.name ?? linkedMeta.name,
          desc: parsed.desc ?? linkedMeta.desc,
          image: parsed.image ?? linkedMeta.image,
          conditions: parsed.conditions ?? linkedMeta.conditions,
          isAssetAnchored: parsed.isAssetAnchored ?? linkedMeta.isAssetAnchored,
          anchorAsset: parsed.anchorAsset ?? linkedMeta.anchorAsset,
        };
      }
    } catch {
      // Non-fatal if linked currency TOML is unreachable
    }
  }

  return parsed;
}

const issuerHomeDomainCache = new Map<string, { expiresAt: number; domain: string | null }>();

export interface HeldTokenTomlMetadata {
  assetCode: string;
  assetIssuer: ClassicAddress;
  homeDomain?: string | undefined;
  name?: string | undefined;
  desc?: string | undefined;
  image?: string | undefined;
  orgName?: string | undefined;
  orgUrl?: string | undefined;
  tomlMatched: boolean;
}

/**
 * Resolves live SEP-1 `stellar.toml` metadata and real currency logos for held Stellar assets.
 */
export async function fetchHeldAssetsTomlMetadata(input: {
  horizonUrls: readonly string[];
  assets: ReadonlyArray<{
    assetCode: string;
    assetIssuer?: string | undefined;
    knownDomain?: string | undefined;
  }>;
  apiBaseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<Record<string, HeldTokenTomlMetadata>> {
  const fetchFn = input.fetchFn ?? fetch;
  const useCache = !input.fetchFn;
  const deduped = new Map<
    string,
    { assetCode: string; assetIssuer: ClassicAddress; knownDomain?: string | undefined }
  >();

  for (const item of input.assets) {
    const code = item.assetCode.trim();
    const issuer = item.assetIssuer?.trim();
    if (!code || (code.toUpperCase() === "XLM" && !issuer)) continue;
    if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) continue;
    const key = `${code.toUpperCase()}:${issuer}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        assetCode: code,
        assetIssuer: issuer as ClassicAddress,
        knownDomain: item.knownDomain?.trim() || undefined,
      });
    }
  }

  const out: Record<string, HeldTokenTomlMetadata> = {};
  await Promise.all(
    Array.from(deduped.entries()).map(async ([key, asset]) => {
      let homeDomain = asset.knownDomain;
      if (!homeDomain) {
        const now = Date.now();
        const cached = useCache ? issuerHomeDomainCache.get(asset.assetIssuer) : undefined;
        if (cached && cached.expiresAt > now) {
          homeDomain = cached.domain ?? undefined;
        } else {
          try {
            const acc = await fetchJsonWithHorizonFailover<{ home_domain?: string }>(
              input.horizonUrls,
              `/accounts/${encodeURIComponent(asset.assetIssuer)}`,
              fetchFn,
            );
            homeDomain = acc?.home_domain?.trim() || undefined;
            if (useCache) {
              issuerHomeDomainCache.set(asset.assetIssuer, {
                expiresAt: now + STELLAR_TOML_CACHE_TTL_MS,
                domain: homeDomain ?? null,
              });
            }
          } catch {
            homeDomain = undefined;
          }
        }
      }

      if (!homeDomain) {
        out[key] = {
          assetCode: asset.assetCode,
          assetIssuer: asset.assetIssuer,
          tomlMatched: false,
        };
        return;
      }

      const meta = await fetchAssetStellarTomlMeta({
        domain: homeDomain,
        assetCode: asset.assetCode,
        assetIssuer: asset.assetIssuer,
        apiBaseUrl: input.apiBaseUrl,
        fetchFn,
      }).catch(() => null);

      out[key] = {
        assetCode: asset.assetCode,
        assetIssuer: asset.assetIssuer,
        homeDomain,
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.desc ? { desc: meta.desc } : {}),
        ...(meta?.image ? { image: meta.image } : {}),
        ...(meta?.orgName ? { orgName: meta.orgName } : {}),
        ...(meta?.orgUrl ? { orgUrl: meta.orgUrl } : {}),
        tomlMatched: Boolean(meta),
      };
    }),
  );

  return out;
}

async function enrichCatalogItemsWithToml(
  items: TokenCatalogItem[],
  apiBaseUrl: string | undefined,
  fetchFn: typeof fetch,
): Promise<TokenCatalogItem[]> {
  if (!apiBaseUrl) return items;
  const candidates = items.filter((item) => Boolean(item.domain)).slice(0, 16);
  if (candidates.length === 0) return items;

  const enrichedMap = new Map<string, StellarTomlCurrencyMeta | null>();
  await Promise.all(
    candidates.map(async (item) => {
      if (!item.domain) return;
      const meta = await fetchAssetStellarTomlMeta({
        domain: item.domain,
        assetCode: item.assetCode,
        assetIssuer: item.assetIssuer,
        apiBaseUrl,
        fetchFn,
      }).catch(() => null);
      enrichedMap.set(`${item.assetCode.toUpperCase()}:${item.assetIssuer ?? ""}`, meta);
    }),
  );

  return items.map((item) => {
    const meta = enrichedMap.get(`${item.assetCode.toUpperCase()}:${item.assetIssuer ?? ""}`);
    if (!meta) return item;
    return {
      ...item,
      ...(meta.name || meta.orgName ? { name: meta.name ?? item.name ?? meta.orgName } : {}),
      ...(meta.image ? { icon: meta.image } : {}),
    };
  });
}

/**
 * Searches Stellar Horizon `/assets` for matching codes or issuers (`CODE`, `CODE:G...`, or `G...`).
 */
export async function searchHorizonAssets(input: {
  horizonUrls: readonly string[];
  query: string;
  limit?: number | undefined;
  apiBaseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<TokenCatalogItem[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const limit = Math.min(Math.max(input.limit ?? 15, 1), 50);
  const trimmed = input.query.trim();
  const params = new URLSearchParams({
    limit: String(limit),
    order: "desc",
  });

  if (trimmed.includes(":")) {
    const [rawCode, rawIssuer] = trimmed.split(":");
    const code = (rawCode ?? "").trim();
    const issuer = (rawIssuer ?? "").trim();
    if (code) params.set("asset_code", code.toUpperCase());
    if (StrKey.isValidEd25519PublicKey(issuer)) {
      params.set("asset_issuer", issuer);
    }
  } else if (StrKey.isValidEd25519PublicKey(trimmed)) {
    params.set("asset_issuer", trimmed);
  } else if (trimmed.length > 0 && /^[A-Za-z0-9]{1,12}$/.test(trimmed)) {
    params.set("asset_code", trimmed.toUpperCase());
  }

  const body = await fetchJsonWithHorizonFailover<{
    _embedded?: { records?: HorizonAssetRecord[] };
  }>(input.horizonUrls, `/assets?${params.toString()}`, fetchFn);

  const records = body?._embedded?.records ?? [];
  const items: TokenCatalogItem[] = [];
  for (const rec of records) {
    if (!rec.asset_code || !rec.asset_issuer || !StrKey.isValidEd25519PublicKey(rec.asset_issuer)) {
      continue;
    }
    const authorized = rec.accounts?.authorized ?? 0;
    const supply = rec.balances?.authorized ?? rec.amount ?? "0";
    items.push({
      assetCode: rec.asset_code,
      assetIssuer: rec.asset_issuer as ClassicAddress,
      domain: extractDomainFromTomlHref(rec._links?.toml?.href),
      numAccounts: authorized,
      supplyAmount: supply,
      isVerified: false,
      hasTrustline: false,
    });
  }

  return enrichCatalogItemsWithToml(items, input.apiBaseUrl, fetchFn);
}

/**
 * Fetches complete on-chain asset metadata, SAC C... address, home domain, SEP-1 `stellar.toml`
 * branding/anchor metadata, circulating supply, holder trustline counts, and issuer flags.
 */
export async function fetchTokenOnChainDetails(input: {
  horizonUrls: readonly string[];
  networkPassphrase: string;
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  apiBaseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<StellarTokenDetails> {
  const fetchFn = input.fetchFn ?? fetch;
  const cleanCode = input.assetCode.trim();
  const isNative = cleanCode.toUpperCase() === "XLM" && !input.assetIssuer;
  const sacContractId = resolveSacContractId({
    assetCode: isNative ? "XLM" : cleanCode,
    assetIssuer: isNative ? undefined : input.assetIssuer,
    networkPassphrase: input.networkPassphrase,
  });

  if (isNative) {
    let totalCoins = "0";
    let latestLedgerSequence: number | undefined;
    let baseFeeStroops: number | undefined;
    let baseReserveStroops: number | undefined;
    let maxTxSetSize: number | undefined;
    let protocolVersion: number | undefined;

    try {
      const ledgerBody = await fetchJsonWithHorizonFailover<{
        _embedded?: {
          records?: Array<{
            sequence?: number;
            total_coins?: string;
            base_fee_in_stroops?: number;
            base_reserve_in_stroops?: number;
            max_tx_set_size?: number;
            protocol_version?: number;
          }>;
        };
      }>(input.horizonUrls, "/ledgers?order=desc&limit=1", fetchFn);
      const rec = ledgerBody?._embedded?.records?.[0];
      totalCoins = rec?.total_coins ?? "0";
      if (typeof rec?.sequence === "number") latestLedgerSequence = rec.sequence;
      if (typeof rec?.base_fee_in_stroops === "number") baseFeeStroops = rec.base_fee_in_stroops;
      if (typeof rec?.base_reserve_in_stroops === "number") {
        baseReserveStroops = rec.base_reserve_in_stroops;
      }
      if (typeof rec?.max_tx_set_size === "number") maxTxSetSize = rec.max_tx_set_size;
      if (typeof rec?.protocol_version === "number") protocolVersion = rec.protocol_version;
    } catch {
      // Non-fatal if latest ledger summary is unreachable
    }
    return {
      assetCode: "XLM",
      isNative: true,
      sacContractId,
      homeDomain: "stellar.org",
      name: "Stellar Lumens",
      description:
        "Native protocol asset of the Stellar network securing ledger base reserves, Soroban execution, and fees.",
      orgName: "Stellar Development Foundation",
      orgUrl: "https://stellar.org",
      supplyAmount: totalCoins,
      numAccounts: 0,
      ...(latestLedgerSequence !== undefined ? { latestLedgerSequence } : {}),
      ...(baseFeeStroops !== undefined ? { baseFeeStroops } : {}),
      ...(baseReserveStroops !== undefined ? { baseReserveStroops } : {}),
      ...(maxTxSetSize !== undefined ? { maxTxSetSize } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      flags: {
        authRequired: false,
        authRevocable: false,
        authImmutable: true,
        authClawbackEnabled: false,
      },
    };
  }

  if (!input.assetIssuer || !StrKey.isValidEd25519PublicKey(input.assetIssuer)) {
    throw new Error(`Valid G... issuer address is required for ${cleanCode}`);
  }

  const assetParams = new URLSearchParams({
    asset_code: cleanCode,
    asset_issuer: input.assetIssuer,
    limit: "1",
  });

  const [assetBody, issuerAccount] = await Promise.all([
    fetchJsonWithHorizonFailover<{
      _embedded?: { records?: HorizonAssetRecord[] };
    }>(input.horizonUrls, `/assets?${assetParams.toString()}`, fetchFn).catch(() => null),
    fetchJsonWithHorizonFailover<{
      home_domain?: string;
      flags?: {
        auth_required?: boolean;
        auth_revocable?: boolean;
        auth_immutable?: boolean;
        auth_clawback_enabled?: boolean;
      };
    }>(
      input.horizonUrls,
      `/accounts/${encodeURIComponent(input.assetIssuer)}`,
      fetchFn,
    ).catch(() => null),
  ]);

  const record = assetBody?._embedded?.records?.[0];
  const flagsSource = record?.flags ?? issuerAccount?.flags;
  const homeDomain =
    issuerAccount?.home_domain?.trim() ||
    extractDomainFromTomlHref(record?._links?.toml?.href) ||
    undefined;

  const tomlMeta = homeDomain
    ? await fetchAssetStellarTomlMeta({
        domain: homeDomain,
        assetCode: cleanCode,
        assetIssuer: input.assetIssuer,
        apiBaseUrl: input.apiBaseUrl,
        fetchFn,
      }).catch(() => null)
    : null;

  return {
    assetCode: cleanCode,
    assetIssuer: input.assetIssuer,
    isNative: false,
    sacContractId,
    homeDomain,
    ...(tomlMeta?.name ? { name: tomlMeta.name } : {}),
    ...(tomlMeta?.desc ? { description: tomlMeta.desc } : {}),
    ...(tomlMeta?.image ? { image: tomlMeta.image } : {}),
    ...(tomlMeta?.orgName ? { orgName: tomlMeta.orgName } : {}),
    ...(tomlMeta?.orgUrl ? { orgUrl: tomlMeta.orgUrl } : {}),
    ...(tomlMeta?.isAssetAnchored !== undefined
      ? { isAssetAnchored: tomlMeta.isAssetAnchored }
      : {}),
    ...(tomlMeta?.anchorAsset ? { anchorAsset: tomlMeta.anchorAsset } : {}),
    supplyAmount: record?.balances?.authorized ?? record?.amount ?? "0",
    numAccounts: record?.accounts?.authorized ?? 0,
    ...(typeof record?.accounts?.authorized_to_maintain_liabilities === "number"
      ? {
          authorizedToMaintainLiabilitiesAccounts:
            record.accounts.authorized_to_maintain_liabilities,
        }
      : {}),
    ...(typeof record?.accounts?.unauthorized === "number"
      ? { unauthorizedAccounts: record.accounts.unauthorized }
      : {}),
    ...(typeof record?.num_claimable_balances === "number"
      ? { numClaimableBalances: record.num_claimable_balances }
      : {}),
    ...(typeof record?.num_liquidity_pools === "number"
      ? { numLiquidityPools: record.num_liquidity_pools }
      : {}),
    ...(typeof record?.num_contracts === "number" ? { numContracts: record.num_contracts } : {}),
    ...(record?.contracts_amount ? { contractsAmount: record.contracts_amount } : {}),
    claimableBalancesAmount: record?.claimable_balances_amount,
    liquidityPoolsAmount: record?.liquidity_pools_amount,
    flags: {
      authRequired: Boolean(flagsSource?.auth_required),
      authRevocable: Boolean(flagsSource?.auth_revocable),
      authImmutable: Boolean(flagsSource?.auth_immutable),
      authClawbackEnabled: Boolean(flagsSource?.auth_clawback_enabled),
    },
  };
}

/**
 * Fetches historical OHLC candles from Horizon `/trade_aggregations` with graceful fallback
 * to `/order_book` mid-price or `/trades` when a pair has sparse aggregation candles.
 */
export async function fetchTokenPriceHistoryAgainstXlm(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  timeframe: TokenPriceTimeframe;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  nowMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<TokenPriceHistoryResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;

  if (isBaseNative && isQuoteNative) {
    return {
      timeframe: input.timeframe,
      quoteCode: "XLM",
      candles: [],
      latestPriceXlm: 1,
      changePct: 0,
      high: 1,
      low: 1,
      volumeBase: 0,
      source: "parity",
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const timeframeConfig: Record<
    TokenPriceTimeframe,
    { lookbackMs: number; resolutionMs: number; limit: number }
  > = {
    "24h": { lookbackMs: 24 * 60 * 60 * 1000, resolutionMs: 3_600_000, limit: 24 },
    "7d": { lookbackMs: 7 * 24 * 60 * 60 * 1000, resolutionMs: 14_400_000, limit: 42 },
    "30d": { lookbackMs: 30 * 24 * 60 * 60 * 1000, resolutionMs: 86_400_000, limit: 30 },
    "1y": { lookbackMs: 365 * 24 * 60 * 60 * 1000, resolutionMs: 86_400_000, limit: 200 },
    "all": { lookbackMs: 10 * 365 * 24 * 60 * 60 * 1000, resolutionMs: 604_800_000, limit: 200 },
  };
  const cfg = timeframeConfig[input.timeframe];

  const baseParams = resolveAssetQueryParams("base", input.assetCode, input.assetIssuer);
  const counterParams = resolveAssetQueryParams("counter", quoteCode, quoteIssuer);

  async function queryAggCandles(lookbackMs: number, resolutionMs: number, limit: number) {
    const aggParams = new URLSearchParams({
      ...baseParams,
      ...counterParams,
      start_time: String(Math.max(0, nowMs - lookbackMs)),
      end_time: String(nowMs),
      resolution: String(resolutionMs),
      limit: String(limit),
      order: "desc",
    });
    const aggBody = await fetchJsonWithHorizonFailover<{
      _embedded?: { records?: HorizonTradeAggRecord[] };
    }>(input.horizonUrls, `/trade_aggregations?${aggParams.toString()}`, fetchFn);

    return (aggBody?._embedded?.records ?? [])
      .map((rec): TokenPriceCandle | null => {
        const ts = parseFiniteNumber(rec.timestamp);
        const open = parseFiniteNumber(rec.open);
        const high = parseFiniteNumber(rec.high);
        const low = parseFiniteNumber(rec.low);
        const close = parseFiniteNumber(rec.close);
        const baseVolume = parseFiniteNumber(rec.base_volume) ?? 0;
        if (
          ts === null ||
          open === null ||
          high === null ||
          low === null ||
          close === null ||
          close <= 0
        ) {
          return null;
        }
        return { timestamp: ts, open, high, low, close, baseVolume };
      })
      .filter((c): c is TokenPriceCandle => c !== null)
      .reverse();
  }

  try {
    let parsedCandles = await queryAggCandles(cfg.lookbackMs, cfg.resolutionMs, cfg.limit);
    // For newer tokens on "all" where weekly candles are sparse (< 2), step down to daily candles.
    if (input.timeframe === "all" && parsedCandles.length < 2) {
      const dailyCandles = await queryAggCandles(365 * 24 * 60 * 60 * 1000, 86_400_000, 200);
      if (dailyCandles.length > parsedCandles.length) {
        parsedCandles = dailyCandles;
      }
    }

    if (parsedCandles.length > 0) {
      const first = parsedCandles[0]!;
      const last = parsedCandles[parsedCandles.length - 1]!;
      const high = Math.max(...parsedCandles.map((c) => c.high));
      const low = Math.min(...parsedCandles.map((c) => c.low));
      const volumeBase = parsedCandles.reduce((sum, c) => sum + c.baseVolume, 0);
      const changePct =
        first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;
      return {
        timeframe: input.timeframe,
        quoteCode,
        quoteIssuer,
        candles: parsedCandles,
        latestPriceXlm: last.close,
        changePct,
        high,
        low,
        volumeBase,
        source: "trade_aggregations",
      };
    }
  } catch {
    // Fall through to recent trades / orderbook mid-price fallback
  }

  // Fallback 1: Recent trades
  try {
    const tradeParams = new URLSearchParams({
      ...baseParams,
      ...counterParams,
      limit: "20",
      order: "desc",
    });
    const tradesBody = await fetchJsonWithHorizonFailover<{
      _embedded?: { records?: HorizonTradeRecord[] };
    }>(input.horizonUrls, `/trades?${tradeParams.toString()}`, fetchFn);

    const points = (tradesBody?._embedded?.records ?? [])
      .map((t): TokenPriceCandle | null => {
        const p = parseTradePrice(t.price);
        const ts = t.ledger_close_time ? Date.parse(t.ledger_close_time) : NaN;
        if (p === null || !Number.isFinite(ts)) return null;
        const vol = parseFiniteNumber(t.base_amount) ?? 0;
        return { timestamp: ts, open: p, high: p, low: p, close: p, baseVolume: vol };
      })
      .filter((c): c is TokenPriceCandle => c !== null)
      .reverse();

    if (points.length > 0) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const high = Math.max(...points.map((c) => c.high));
      const low = Math.min(...points.map((c) => c.low));
      const volumeBase = points.reduce((sum, c) => sum + c.baseVolume, 0);
      const changePct =
        first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;
      return {
        timeframe: input.timeframe,
        quoteCode,
        quoteIssuer,
        candles: points,
        latestPriceXlm: last.close,
        changePct,
        high,
        low,
        volumeBase,
        source: "trades",
      };
    }
  } catch {
    // Fall through to orderbook mid-price
  }

  // Fallback 2: Orderbook mid-price snapshot
  const ob = await fetchTokenOrderbookAgainstXlm({
    horizonUrls: input.horizonUrls,
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    counterAsset: input.counterAsset,
    limit: 5,
    fetchFn,
  }).catch(() => null);

  const midNum = ob?.midPriceXlm ? parseFiniteNumber(ob.midPriceXlm) : null;
  return {
    timeframe: input.timeframe,
    quoteCode,
    quoteIssuer,
    candles: [],
    latestPriceXlm: midNum,
    changePct: null,
    high: midNum,
    low: midNum,
    volumeBase: 0,
    source: "order_book",
  };
}

export interface TokenRecentTradeRecord {
  id: string;
  timestamp: string;
  price: string;
  baseAmount: string;
  counterAmount: string;
  baseAccount?: string | undefined;
  counterAccount?: string | undefined;
  isBuy: boolean;
}

/**
 * Fetches recent executed SDEX/AMM trades for a token pair from Horizon `/trades`.
 */
export async function fetchTokenRecentTrades(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  limit?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<TokenRecentTradeRecord[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;
  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;
  if (isBaseNative && isQuoteNative) {
    return [];
  }

  const baseParams = resolveAssetQueryParams("base", input.assetCode, input.assetIssuer);
  const counterParams = resolveAssetQueryParams("counter", quoteCode, quoteIssuer);
  const params = new URLSearchParams({
    ...baseParams,
    ...counterParams,
    limit: String(Math.min(Math.max(input.limit ?? 15, 1), 50)),
    order: "desc",
  });

  const body = await fetchJsonWithHorizonFailover<{
    _embedded?: {
      records?: Array<{
        id?: string;
        ledger_close_time?: string;
        base_amount?: string;
        counter_amount?: string;
        base_account?: string;
        counter_account?: string;
        base_is_seller?: boolean;
        price?: { n?: string | number; d?: string | number };
      }>;
    };
  }>(input.horizonUrls, `/trades?${params.toString()}`, fetchFn);

  const out: TokenRecentTradeRecord[] = [];
  for (const rec of body?._embedded?.records ?? []) {
    const p = parseTradePrice(rec.price);
    if (p === null || !rec.id || !rec.ledger_close_time) continue;
    out.push({
      id: rec.id,
      timestamp: rec.ledger_close_time,
      price: p.toPrecision(6),
      baseAmount: rec.base_amount ?? "0",
      counterAmount: rec.counter_amount ?? "0",
      baseAccount: rec.base_account,
      counterAccount: rec.counter_account,
      isBuy: !rec.base_is_seller,
    });
  }
  return out;
}

/**
 * Fetches top SDEX bids/asks and spread from Horizon `/order_book` for an asset pair.
 */
export async function fetchTokenOrderbookAgainstXlm(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  limit?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<TokenOrderbookSnapshot> {
  const fetchFn = input.fetchFn ?? fetch;
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;

  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;

  if (isBaseNative && isQuoteNative) {
    return {
      quoteCode,
      quoteIssuer,
      bids: [],
      asks: [],
      midPriceXlm: "1",
      spreadPct: "0.00",
    };
  }

  const sellingParams = resolveAssetQueryParams("selling", input.assetCode, input.assetIssuer);
  const buyingParams = resolveAssetQueryParams("buying", quoteCode, quoteIssuer);
  const params = new URLSearchParams({
    ...sellingParams,
    ...buyingParams,
    limit: String(limit),
  });

  const body = await fetchJsonWithHorizonFailover<HorizonOrderbookResponse>(
    input.horizonUrls,
    `/order_book?${params.toString()}`,
    fetchFn,
  );

  const bids = (body?.bids ?? [])
    .filter((b): b is { price: string; amount: string } => Boolean(b.price && b.amount))
    .slice(0, limit);
  const asks = (body?.asks ?? [])
    .filter((a): a is { price: string; amount: string } => Boolean(a.price && a.amount))
    .slice(0, limit);

  const topBid = parseFiniteNumber(bids[0]?.price);
  const topAsk = parseFiniteNumber(asks[0]?.price);

  let midPriceXlm: string | null = null;
  let spreadPct: string | null = null;

  if (topBid !== null && topAsk !== null && topBid > 0 && topAsk > 0) {
    const mid = (topBid + topAsk) / 2;
    midPriceXlm = mid.toPrecision(6);
    if (mid > 0) {
      spreadPct = Math.max(0, ((topAsk - topBid) / mid) * 100).toFixed(2);
    }
  } else if (topBid !== null && topBid > 0) {
    midPriceXlm = topBid.toPrecision(6);
  } else if (topAsk !== null && topAsk > 0) {
    midPriceXlm = topAsk.toPrecision(6);
  }

  return {
    quoteCode,
    quoteIssuer,
    bids,
    asks,
    midPriceXlm,
    spreadPct,
  };
}

interface HorizonLiquidityPoolRecord {
  id?: string;
  total_shares?: string;
  reserves?: Array<{
    asset?: string;
    amount?: string;
  }>;
}

/**
 * Discovers live, functional Stellar assets with active AMM liquidity pools or
 * non-zero holder trustlines on the configured Horizon network (e.g. active Testnet pairs).
 */
export async function discoverLiquidHorizonAssets(input: {
  horizonUrls: readonly string[];
  limit?: number | undefined;
  apiBaseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<TokenCatalogItem[]> {
  const fetchFn = input.fetchFn ?? fetch;
  const limit = Math.min(Math.max(input.limit ?? 15, 1), 30);

  const [poolsBody, assetsBody] = await Promise.all([
    fetchJsonWithHorizonFailover<{
      _embedded?: { records?: HorizonLiquidityPoolRecord[] };
    }>(input.horizonUrls, `/liquidity_pools?limit=${limit}&order=desc`, fetchFn).catch(() => null),
    fetchJsonWithHorizonFailover<{
      _embedded?: { records?: HorizonAssetRecord[] };
    }>(input.horizonUrls, `/assets?limit=${limit}&order=desc`, fetchFn).catch(() => null),
  ]);

  const discovered = new Map<string, TokenCatalogItem>();

  for (const pool of poolsBody?._embedded?.records ?? []) {
    const shares = parseFiniteNumber(pool.total_shares) ?? 0;
    if (shares <= 0) continue;

    for (const reserve of pool.reserves ?? []) {
      const rawAsset = reserve.asset?.trim();
      if (!rawAsset || rawAsset === "native" || !rawAsset.includes(":")) continue;
      const [rawCode, rawIssuer] = rawAsset.split(":");
      const code = rawCode?.trim();
      const issuer = rawIssuer?.trim();
      if (!code || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) continue;

      const reserveNum = parseFiniteNumber(reserve.amount) ?? 0;
      if (reserveNum <= 0) continue;

      const key = `${code.toUpperCase()}:${issuer}`;
      const existing = discovered.get(key);
      const prevReserve = parseFiniteNumber(existing?.poolReserveAmount) ?? 0;
      if (!existing || reserveNum > prevReserve) {
        discovered.set(key, {
          assetCode: code,
          assetIssuer: issuer as ClassicAddress,
          domain: existing?.domain,
          numAccounts: existing?.numAccounts,
          supplyAmount: existing?.supplyAmount,
          isVerified: false,
          hasTrustline: false,
          hasLiquidityPool: true,
          poolReserveAmount: reserve.amount,
        });
      }
    }
  }

  for (const rec of assetsBody?._embedded?.records ?? []) {
    if (!rec.asset_code || !rec.asset_issuer || !StrKey.isValidEd25519PublicKey(rec.asset_issuer)) {
      continue;
    }
    const authorized = rec.accounts?.authorized ?? 0;
    const supply = rec.balances?.authorized ?? rec.amount ?? "0";
    if (authorized <= 0 && (parseFiniteNumber(supply) ?? 0) <= 0) continue;

    const key = `${rec.asset_code.toUpperCase()}:${rec.asset_issuer}`;
    const existing = discovered.get(key);
    discovered.set(key, {
      assetCode: rec.asset_code,
      assetIssuer: rec.asset_issuer as ClassicAddress,
      domain: existing?.domain ?? extractDomainFromTomlHref(rec._links?.toml?.href),
      numAccounts: authorized,
      supplyAmount: supply,
      isVerified: false,
      hasTrustline: false,
      ...(existing?.hasLiquidityPool ? { hasLiquidityPool: true } : {}),
      ...(existing?.poolReserveAmount ? { poolReserveAmount: existing.poolReserveAmount } : {}),
    });
  }

  const sorted = Array.from(discovered.values()).sort((a, b) => {
    if (Boolean(a.hasLiquidityPool) !== Boolean(b.hasLiquidityPool)) {
      return a.hasLiquidityPool ? -1 : 1;
    }
    return (b.numAccounts ?? 0) - (a.numAccounts ?? 0);
  });
  return enrichCatalogItemsWithToml(sorted, input.apiBaseUrl, fetchFn);
}
