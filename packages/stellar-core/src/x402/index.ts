import type { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import { signChallengeMessage } from "../sep0005.js";

export const AGENT_DERIVATION_INDEX = 99;

export const AgentBudgetPolicySchema = z.object({
  enabled: z.boolean(),
  dailyCapStroops: z.string().regex(/^\d+$/),
  maxPerRequestStroops: z.string().regex(/^\d+$/),
  allowedNetworks: z.array(z.enum(["stellar:testnet", "stellar:pubnet"])).min(1),
  allowedDomains: z.array(z.string().trim().min(1)),
  allowedAssets: z.array(z.string().trim().min(1)).optional(),
  spentTodayStroops: z.string().regex(/^\d+$/),
  lastResetDayUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface AgentBudgetPolicy {
  enabled: boolean;
  dailyCapStroops: string;
  maxPerRequestStroops: string;
  allowedNetworks: readonly ("stellar:testnet" | "stellar:pubnet")[];
  allowedDomains: readonly string[];
  allowedAssets?: readonly string[] | undefined;
  spentTodayStroops: string;
  lastResetDayUtc: string;
}

export interface ParsedX402AcceptOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number | undefined;
  description?: string | undefined;
}

export interface ParsedX402PaymentRequired {
  x402Version: number;
  accepts: readonly ParsedX402AcceptOption[];
}

export function getUtcDayString(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function getEffectiveSpentTodayStroops(
  policy: Pick<AgentBudgetPolicy, "spentTodayStroops" | "lastResetDayUtc">,
  nowMs = Date.now(),
): string {
  return policy.lastResetDayUtc === getUtcDayString(nowMs)
    ? policy.spentTodayStroops
    : "0";
}

export function createDefaultAgentBudgetPolicy(
  network: "testnet" | "mainnet",
  nowMs = Date.now(),
  options?: { allowedDomains?: readonly string[] | undefined },
): AgentBudgetPolicy {
  return {
    enabled: false,
    dailyCapStroops: "20000000", // 2.00 USDC
    maxPerRequestStroops: "500000", // 0.05 USDC
    allowedNetworks: [network === "mainnet" ? "stellar:pubnet" : "stellar:testnet"],
    allowedDomains: options?.allowedDomains
      ? [...options.allowedDomains]
      : ["astrodex-testnet.pages.dev", "astrodex.pages.dev"],
    allowedAssets: [
      "USDC",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // Testnet USDC SAC
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // Mainnet USDC SAC
    ],
    spentTodayStroops: "0",
    lastResetDayUtc: getUtcDayString(nowMs),
  };
}

export function parseX402PaymentRequiredHeader(
  headerValue: string,
): ParsedX402PaymentRequired {
  const clean = headerValue.trim();
  if (!clean) {
    throw new Error("Empty PAYMENT-REQUIRED header");
  }
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    x402Version?: unknown;
    accepts?: unknown;
  };
  if (typeof parsed.x402Version !== "number" || !Array.isArray(parsed.accepts)) {
    throw new Error("Invalid x402 PAYMENT-REQUIRED payload");
  }
  return {
    x402Version: parsed.x402Version,
    accepts: parsed.accepts as ParsedX402AcceptOption[],
  };
}

export function evaluateAgentSpendRequest(
  policy: AgentBudgetPolicy,
  req: {
    domain: string;
    network: string;
    amountStroops: string;
    asset?: string | undefined;
  },
  nowMs = Date.now(),
): { allowed: true; effectiveSpentTodayStroops: string } | { allowed: false; reason: string } {
  if (!policy.enabled) {
    return { allowed: false, reason: "Agent budget is paused (kill-switch active)." };
  }

  const normalizedDomain = req.domain.trim().toLowerCase();
  if (
    policy.allowedDomains.length > 0 &&
    !policy.allowedDomains.some((d) => d.trim().toLowerCase() === normalizedDomain)
  ) {
    return {
      allowed: false,
      reason: `Domain "${req.domain}" is not in the agent allowlist.`,
    };
  }

  if (!policy.allowedNetworks.includes(req.network as "stellar:testnet" | "stellar:pubnet")) {
    return {
      allowed: false,
      reason: `Network "${req.network}" is not permitted by this agent policy.`,
    };
  }

  if (req.asset && policy.allowedAssets && policy.allowedAssets.length > 0) {
    const cleanAsset = req.asset.trim().toUpperCase();
    const assetAllowed = policy.allowedAssets.some((a) => {
      const upper = a.trim().toUpperCase();
      return cleanAsset === upper || cleanAsset.startsWith(`${upper}:`);
    });
    if (!assetAllowed) {
      return {
        allowed: false,
        reason: `Asset "${req.asset}" is not permitted by this agent budget policy.`,
      };
    }
  }

  if (!/^\d+$/.test(req.amountStroops) || BigInt(req.amountStroops) <= 0n) {
    return { allowed: false, reason: "Invalid x402 payment amount." };
  }

  const amount = BigInt(req.amountStroops);
  const maxPerReq = BigInt(policy.maxPerRequestStroops);
  if (amount > maxPerReq) {
    return {
      allowed: false,
      reason: `Requested ${req.amountStroops} stroops exceeds per-request cap (${policy.maxPerRequestStroops}).`,
    };
  }

  const today = getUtcDayString(nowMs);
  const baseSpent =
    policy.lastResetDayUtc === today ? BigInt(policy.spentTodayStroops) : 0n;
  const dailyCap = BigInt(policy.dailyCapStroops);

  if (baseSpent + amount > dailyCap) {
    return {
      allowed: false,
      reason: `Daily cap exceeded (${baseSpent.toString()} + ${amount.toString()} > ${dailyCap.toString()} stroops).`,
    };
  }

  return {
    allowed: true,
    effectiveSpentTodayStroops: (baseSpent + amount).toString(),
  };
}

export function recordAgentSpend(
  policy: AgentBudgetPolicy,
  amountStroops: string,
  nowMs = Date.now(),
): AgentBudgetPolicy {
  const today = getUtcDayString(nowMs);
  const baseSpent =
    policy.lastResetDayUtc === today ? BigInt(policy.spentTodayStroops) : 0n;
  return {
    ...policy,
    spentTodayStroops: (baseSpent + BigInt(amountStroops)).toString(),
    lastResetDayUtc: today,
  };
}

export function buildX402PaymentHeader(input: {
  x402Version: number;
  network: string;
  payer: string;
  asset: string;
  amount: string;
  payTo: string;
  nonce: string;
  signatureBase64: string;
}): string {
  const payload = {
    x402Version: input.x402Version,
    scheme: "exact",
    network: input.network,
    payer: input.payer,
    asset: input.asset,
    amount: input.amount,
    payTo: input.payTo,
    nonce: input.nonce,
    signature: input.signatureBase64,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/**
 * Signs an x402 payment authorization challenge using the dedicated agent Ed25519 keypair
 * (`m/44'/148'/99'`) and builds the Base64 x402 payment header.
 */
export function signX402ChallengeWithKeypair(
  agentKeypair: Keypair,
  input: {
    x402Version: number;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    nonce: string;
  },
): {
  payer: string;
  signingPayload: string;
  signatureBase64: string;
  paymentHeader: string;
} {
  const payer = agentKeypair.publicKey();
  const signingPayload = `x402:${input.network}:${input.asset}:${input.amount}:${input.payTo}:${input.nonce}:${payer}`;
  const signatureBase64 = signChallengeMessage(agentKeypair, signingPayload);
  const paymentHeader = buildX402PaymentHeader({
    x402Version: input.x402Version,
    network: input.network,
    payer,
    asset: input.asset,
    amount: input.amount,
    payTo: input.payTo,
    nonce: input.nonce,
    signatureBase64,
  });
  return {
    payer,
    signingPayload,
    signatureBase64,
    paymentHeader,
  };
}
