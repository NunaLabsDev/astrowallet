import type { KVNamespace } from "@cloudflare/workers-types";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const memoryBuckets = new Map<string, { windowStart: number; count: number }>();

/** Test helper: clears the in-memory fallback buckets. */
export function resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}

export function clientKeyFromHeaders(headers: {
  get(name: string): string | null | undefined;
}): string {
  const cf = headers.get("CF-Connecting-IP");
  if (cf && cf.trim()) return cf.trim();
  const xff = headers.get("X-Forwarded-For");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return "anonymous";
}

/**
 * Fixed-window per-minute counter. Uses KV when available (best-effort, eventually consistent)
 * and falls back to an in-memory map for local dev and unit tests.
 */
export async function checkRateLimit(input: {
  cache?: KVNamespace | undefined;
  scope: string;
  clientKey: string;
  limitPerMin: number;
  nowMs?: number | undefined;
}): Promise<RateLimitResult> {
  const now = input.nowMs ?? Date.now();
  const windowId = Math.floor(now / 60_000);
  const retryAfterSeconds = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
  const key = `rl:${input.scope}:${input.clientKey}:${windowId}`;

  if (input.cache) {
    const raw = await input.cache.get(key);
    const current = raw ? Number.parseInt(raw, 10) || 0 : 0;
    if (current >= input.limitPerMin) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    await input.cache.put(key, String(current + 1), { expirationTtl: 120 });
    return {
      allowed: true,
      remaining: Math.max(0, input.limitPerMin - current - 1),
      retryAfterSeconds,
    };
  }

  const bucket = memoryBuckets.get(key);
  const count = bucket?.count ?? 0;
  if (count >= input.limitPerMin) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  memoryBuckets.set(key, { windowStart: windowId, count: count + 1 });
  if (memoryBuckets.size > 5000) {
    for (const [k, v] of memoryBuckets) {
      if (v.windowStart < windowId) memoryBuckets.delete(k);
    }
  }
  return {
    allowed: true,
    remaining: Math.max(0, input.limitPerMin - count - 1),
    retryAfterSeconds,
  };
}
