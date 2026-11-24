import type { StellarNetwork } from "@astrowallet/domain";

/**
 * Builds request headers with explicit `X-Astro-Network` so Cloudflare Pages `_proxy`
 * always routes Testnet and Mainnet traffic to the matching worker.
 */
export function withNetworkHeaders(
  network: StellarNetwork,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "X-Astro-Network": network,
    ...(extra ?? {}),
  };
}
