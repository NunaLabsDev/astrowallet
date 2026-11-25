import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { createFailoverEndpoints } from "../network.js";

export interface Sep50Trait {
  traitType: string;
  value: string;
}

export interface Sep50CollectibleItem {
  contractId: ContractAddress;
  tokenId: number;
  name: string;
  description?: string | undefined;
  image?: string | undefined;
  metadataUrl?: string | undefined;
  traits: Sep50Trait[];
  soulbound?: boolean | undefined;
}

export interface Sep50HoldingsSnapshot {
  contractId: ContractAddress;
  ownerAddress: string;
  collectionName?: string | undefined;
  collectionSymbol?: string | undefined;
  totalOwned: number;
  items: Sep50CollectibleItem[];
}

function readonlySimAddress(): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32));
}

function normalizeCollectibleImageUrl(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("ipfs://")) {
    const cidPath = trimmed.slice(7).replace(/^ipfs\//i, "").replace(/^\/+/, "");
    return cidPath ? `https://ipfs.io/ipfs/${cidPath}` : undefined;
  }
  if (
    /^data:image\/(svg\+xml|png|jpeg|webp);(?:utf8|charset=utf-8|base64),/i.test(trimmed)
  ) {
    // Strip/reject script tags & inline event handlers inside SVG data URIs (raw or base64)
    if (/data:image\/svg\+xml/i.test(trimmed)) {
      let decodedSvg = trimmed;
      const b64Marker = ";base64,";
      const idx = trimmed.toLowerCase().indexOf(b64Marker);
      if (idx !== -1) {
        try {
          decodedSvg = decodeBase64ToUtf8(trimmed.slice(idx + b64Marker.length));
        } catch {
          return undefined;
        }
      } else {
        try {
          decodedSvg = decodeURIComponent(trimmed);
        } catch {
          decodedSvg = trimmed;
        }
      }
      if (
        /<script[\s>]|<foreignobject[\s>]|<iframe[\s>]|<object[\s>]|<embed[\s>]|<animate[\s>]|<set[\s>]|<meta[\s>]|on[a-z]+\s*=|javascript:|vbscript:|data:text\/html|data:application\/|&#x|&#\d|(?:xlink:)?href\s*=\s*["']?\s*(?:https?:|\/\/|javascript:|vbscript:|data:)/i.test(
          decodedSvg,
        )
      ) {
        return undefined;
      }
    }
    return trimmed;
  }
  return undefined;
}

function decodeBase64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Parses a SEP-50 `token_uri(token_id)` string (`data:application/json;utf8,...`, base64, raw JSON, or `https://`/`ipfs://` URL).
 */
export function parseSep50TokenUri(
  contractId: ContractAddress,
  tokenId: number,
  rawUri: string,
): Sep50CollectibleItem {
  const trimmed = rawUri.trim();
  let jsonStr: string | undefined;
  let metadataUrl: string | undefined;

  if (trimmed.startsWith("data:application/json;utf8,")) {
    const body = trimmed.slice("data:application/json;utf8,".length);
    try {
      jsonStr = body.startsWith("{") ? body : decodeURIComponent(body);
    } catch {
      jsonStr = body;
    }
  } else if (trimmed.startsWith("data:application/json;charset=utf-8,")) {
    const body = trimmed.slice("data:application/json;charset=utf-8,".length);
    try {
      jsonStr = body.startsWith("{") ? body : decodeURIComponent(body);
    } catch {
      jsonStr = body;
    }
  } else if (trimmed.startsWith("data:application/json;base64,")) {
    try {
      jsonStr = decodeBase64ToUtf8(trimmed.slice("data:application/json;base64,".length));
    } catch {
      jsonStr = undefined;
    }
  } else if (trimmed.startsWith("{")) {
    jsonStr = trimmed;
  } else if (trimmed.startsWith("https://")) {
    metadataUrl = trimmed;
  } else if (trimmed.startsWith("ipfs://")) {
    const cidPath = trimmed.slice(7).replace(/^ipfs\//i, "").replace(/^\/+/, "");
    metadataUrl = cidPath ? `https://ipfs.io/ipfs/${cidPath}` : undefined;
  }

  let parsed: Record<string, unknown> | undefined;
  if (jsonStr) {
    try {
      const val = JSON.parse(jsonStr) as unknown;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        parsed = val as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }
  }

  const name =
    typeof parsed?.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : `Token #${tokenId}`;
  const description =
    typeof parsed?.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : undefined;
  const image = normalizeCollectibleImageUrl(
    typeof parsed?.image === "string" ? parsed.image : undefined,
  );

  const traits: Sep50Trait[] = [];
  if (Array.isArray(parsed?.attributes)) {
    for (const rawAttr of parsed.attributes) {
      if (!rawAttr || typeof rawAttr !== "object") continue;
      const rec = rawAttr as Record<string, unknown>;
      const traitType = typeof rec.trait_type === "string" ? rec.trait_type.trim() : "";
      const val = rec.value;
      if (traitType && (typeof val === "string" || typeof val === "number" || typeof val === "boolean")) {
        traits.push({ traitType, value: String(val) });
      }
    }
  }

  const soulboundAttr = traits.find((t) => t.traitType.toLowerCase() === "soulbound");
  const soulbound = soulboundAttr ? soulboundAttr.value.toLowerCase() === "true" : undefined;

  return {
    contractId,
    tokenId,
    name,
    description,
    image,
    metadataUrl,
    traits,
    soulbound,
  };
}

async function simulateSep50Read(input: {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<unknown> {
  const sourceAccount = new Account(readonlySimAddress(), "0");
  const contract = new Contract(input.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(contract.call(input.method, ...input.args))
    .setTimeout(25)
    .build();

  const sim = await input.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`SEP-50 simulation error (${input.method}): ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

/**
 * Queries a SEP-50 + `NonFungibleEnumerable` Soroban NFT contract (`balance`, `get_owner_token_id`, `token_uri`).
 */
export async function fetchSep50Holdings(input: {
  contractId: ContractAddress;
  ownerAddress: string;
  rpcUrls: readonly string[];
  networkPassphrase: string;
  maxItems?: number | undefined;
  apiBaseUrl?: string | undefined;
  network?: "testnet" | "mainnet" | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<Sep50HoldingsSnapshot> {
  if (!StrKey.isValidContract(input.contractId)) {
    throw new Error(`Invalid SEP-50 contract ID: ${input.contractId}`);
  }
  const ownerClean = input.ownerAddress.trim();
  if (!StrKey.isValidEd25519PublicKey(ownerClean) && !StrKey.isValidContract(ownerClean)) {
    throw new Error(`Invalid Stellar owner address: ${input.ownerAddress}`);
  }

  const cap = Math.max(1, Math.min(input.maxItems ?? 12, 24));
  const endpoints = createFailoverEndpoints(input.rpcUrls);
  const urls = endpoints.list();
  let lastError: unknown;

  for (let i = 0; i < urls.length; i += 1) {
    const rpcUrl = endpoints.current();
    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    try {
      const ownerScVal = new Address(ownerClean).toScVal();
      const [rawBalance, rawName, rawSymbol] = await Promise.all([
        simulateSep50Read({
          server,
          contractId: input.contractId,
          networkPassphrase: input.networkPassphrase,
          method: "balance",
          args: [ownerScVal],
        }),
        simulateSep50Read({
          server,
          contractId: input.contractId,
          networkPassphrase: input.networkPassphrase,
          method: "name",
          args: [],
        }).catch(() => undefined),
        simulateSep50Read({
          server,
          contractId: input.contractId,
          networkPassphrase: input.networkPassphrase,
          method: "symbol",
          args: [],
        }).catch(() => undefined),
      ]);

      const totalOwnedNum = Number(rawBalance ?? 0);
      const totalOwned = Number.isFinite(totalOwnedNum) && totalOwnedNum >= 0 ? Math.trunc(totalOwnedNum) : 0;
      const collectionName = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;
      const collectionSymbol =
        typeof rawSymbol === "string" && rawSymbol.trim() ? rawSymbol.trim() : undefined;

      if (totalOwned === 0) {
        return {
          contractId: input.contractId,
          ownerAddress: ownerClean,
          collectionName,
          collectionSymbol,
          totalOwned: 0,
          items: [],
        };
      }

      const fetchCount = Math.min(totalOwned, cap);
      const indices = Array.from({ length: fetchCount }, (_, idx) => idx);
      const items = await Promise.all(
        indices.map(async (index): Promise<Sep50CollectibleItem | null> => {
          try {
            const rawTokenId = await simulateSep50Read({
              server,
              contractId: input.contractId,
              networkPassphrase: input.networkPassphrase,
              method: "get_owner_token_id",
              args: [ownerScVal, nativeToScVal(index, { type: "u32" })],
            });
            const tokenId = Number(rawTokenId);
            if (!Number.isInteger(tokenId) || tokenId < 0) {
              return null;
            }
            const rawUri = await simulateSep50Read({
              server,
              contractId: input.contractId,
              networkPassphrase: input.networkPassphrase,
              method: "token_uri",
              args: [nativeToScVal(tokenId, { type: "u32" })],
            });
            const item = parseSep50TokenUri(
              input.contractId,
              tokenId,
              typeof rawUri === "string" ? rawUri : "",
            );
            if (item.metadataUrl && !item.image && !item.description) {
              try {
                const fetchImpl = input.fetchFn ?? fetch;
                const cleanApiBase = input.apiBaseUrl?.trim().replace(/\/+$/, "");
                let metaRes: Response | null = null;
                if (cleanApiBase) {
                  const proxyUrl = `${cleanApiBase}/v1/proxy/sep50-meta?url=${encodeURIComponent(item.metadataUrl)}`;
                  metaRes = await fetchImpl(proxyUrl, {
                    headers: {
                      Accept: "application/json",
                      ...(input.network ? { "X-Astro-Network": input.network } : {}),
                    },
                    signal: AbortSignal.timeout(5000),
                  });
                  if (
                    metaRes.status === 404 &&
                    (item.metadataUrl.startsWith("https://ipfs.io/") ||
                      item.metadataUrl.startsWith("https://dweb.link/"))
                  ) {
                    metaRes = await fetchImpl(item.metadataUrl, {
                      headers: { Accept: "application/json" },
                      signal: AbortSignal.timeout(5000),
                    });
                  }
                } else {
                  metaRes = await fetchImpl(item.metadataUrl, {
                    headers: { Accept: "application/json" },
                    signal: AbortSignal.timeout(5000),
                  });
                }
                if (metaRes && metaRes.ok) {
                  const rawMeta = (await metaRes.json()) as unknown;
                  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
                    const rec = rawMeta as Record<string, unknown>;
                    const hydratedName =
                      typeof rec.name === "string" && rec.name.trim()
                        ? rec.name.trim()
                        : item.name;
                    const hydratedDesc =
                      typeof rec.description === "string" && rec.description.trim()
                        ? rec.description.trim()
                        : item.description;
                    const hydratedImage = normalizeCollectibleImageUrl(
                      typeof rec.image === "string" ? rec.image : item.image,
                    );
                    const hydratedTraits: Sep50Trait[] = [...item.traits];
                    if (hydratedTraits.length === 0 && Array.isArray(rec.attributes)) {
                      for (const rawAttr of rec.attributes) {
                        if (!rawAttr || typeof rawAttr !== "object") continue;
                        const attr = rawAttr as Record<string, unknown>;
                        const traitType =
                          typeof attr.trait_type === "string" ? attr.trait_type.trim() : "";
                        const val = attr.value;
                        if (
                          traitType &&
                          (typeof val === "string" ||
                            typeof val === "number" ||
                            typeof val === "boolean")
                        ) {
                          hydratedTraits.push({ traitType, value: String(val) });
                        }
                      }
                    }
                    const sbAttr = hydratedTraits.find(
                      (t) => t.traitType.toLowerCase() === "soulbound",
                    );
                    return {
                      ...item,
                      name: hydratedName,
                      description: hydratedDesc,
                      image: hydratedImage,
                      traits: hydratedTraits,
                      soulbound: sbAttr
                        ? sbAttr.value.toLowerCase() === "true"
                        : item.soulbound,
                    };
                  }
                }
              } catch {
                // Non-fatal if off-chain NFT metadata URL is unreachable
              }
            }
            return item;
          } catch {
            return null;
          }
        }),
      );

      return {
        contractId: input.contractId,
        ownerAddress: ownerClean,
        collectionName,
        collectionSymbol,
        totalOwned,
        items: items.filter((entry): entry is Sep50CollectibleItem => entry !== null),
      };
    } catch (err) {
      lastError = err;
      endpoints.next();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
}

/**
 * Builds and simulates an unsigned SEP-50 `transfer(from, to, token_id)` Soroban transaction XDR.
 */
export async function buildSep50TransferXdr(input: {
  contractId: ContractAddress;
  from: ClassicAddress;
  to: string;
  tokenId: number;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<{ unsignedXdr: string; minResourceFee: string }> {
  if (!StrKey.isValidContract(input.contractId)) {
    throw new Error(`Invalid SEP-50 contract ID: ${input.contractId}`);
  }
  if (!StrKey.isValidEd25519PublicKey(input.from)) {
    throw new Error(`Invalid Classic sender address: ${input.from}`);
  }
  const cleanTo = input.to.trim();
  if (!StrKey.isValidEd25519PublicKey(cleanTo) && !StrKey.isValidContract(cleanTo)) {
    throw new Error(`Invalid Stellar G... or C... destination: ${input.to}`);
  }
  if (!Number.isInteger(input.tokenId) || input.tokenId < 0 || input.tokenId > 0xffffffff) {
    throw new Error(`Invalid SEP-50 u32 tokenId: ${input.tokenId}`);
  }

  const endpoints = createFailoverEndpoints(input.rpcUrls);
  const urls = endpoints.list();
  let lastError: unknown;

  for (let i = 0; i < urls.length; i += 1) {
    const rpcUrl = endpoints.current();
    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    try {
      const sourceAccount = await server.getAccount(input.from);
      const contract = new Contract(input.contractId);
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: input.networkPassphrase,
      })
        .addOperation(
          contract.call(
            "transfer",
            new Address(input.from).toScVal(),
            new Address(cleanTo).toScVal(),
            nativeToScVal(input.tokenId, { type: "u32" }),
          ),
        )
        .setTimeout(60)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationRestore(sim)) {
        throw new Error("SEP-50 contract entry requires state restore before transfer");
      }
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`SEP-50 transfer simulation failed: ${sim.error}`);
      }
      const assembled = rpc.assembleTransaction(tx, sim).build();
      return {
        unsignedXdr: assembled.toXDR(),
        minResourceFee: sim.minResourceFee || "0",
      };
    } catch (err) {
      lastError = err;
      endpoints.next();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
}
