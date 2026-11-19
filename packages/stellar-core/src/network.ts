import type { PwaConfig, ServerConfig } from "@astrowallet/domain";

export type FriendbotCapableConfig = Pick<PwaConfig | ServerConfig, "network" | "friendbotUrl">;

/**
 * Enforces the Mainnet Friendbot hard-block. Throws fatally outside testnet.
 */
export function assertFriendbotAllowed(config: FriendbotCapableConfig): string {
  if (config.network !== "testnet") {
    throw new Error(
      `Friendbot is strictly forbidden on "${config.network}" network`,
    );
  }
  if (!config.friendbotUrl) {
    throw new Error("Friendbot URL is not configured for testnet");
  }
  return config.friendbotUrl;
}

export interface FailoverEndpoints {
  list(): readonly string[];
  current(): string;
  next(): string;
  reset(): void;
}

/**
 * Immutable ordered RPC / Horizon failover endpoint pool.
 */
export function createFailoverEndpoints(urls: readonly string[]): FailoverEndpoints {
  const normalized = urls.map((u) => u.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one endpoint URL is required for failover");
  }
  const pool = Object.freeze([...normalized]);
  let index = 0;

  return {
    list() {
      return pool;
    },
    current() {
      return pool[index] as string;
    },
    next() {
      index = (index + 1) % pool.length;
      return pool[index] as string;
    },
    reset() {
      index = 0;
    },
  };
}
