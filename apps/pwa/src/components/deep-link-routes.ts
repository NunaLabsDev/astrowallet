export interface ActiveConnectRoute {
  requestId: string;
  sig: string;
}

export interface ActiveIntentRoute {
  intentId: string;
  sig: string;
  claimSecretHex?: string | undefined;
}

export function parseConnectRouteFromLocation(): ActiveConnectRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/connect\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
  if (!sig) return null;
  return {
    requestId: match[1],
    sig,
  };
}

let cachedClaimSecret: { pathKey: string; secretHex: string } | null = null;

export function clearCachedClaimSecret(): void {
  cachedClaimSecret = null;
}

export function parseIntentRouteFromLocation(): ActiveIntentRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/intent\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1]) return null;
  const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
  if (!sig) return null;

  const pathKey = `${window.location.pathname}${window.location.search}`;
  const hashMatch = window.location.hash.match(/^#k=([0-9a-fA-F]{64})(?:&.*)?$/);
  let claimSecretHex: string | undefined;
  if (hashMatch?.[1]) {
    claimSecretHex = hashMatch[1].toLowerCase();
    cachedClaimSecret = { pathKey, secretHex: claimSecretHex };
    window.history.replaceState({}, "", pathKey);
  } else if (cachedClaimSecret?.pathKey === pathKey) {
    claimSecretHex = cachedClaimSecret.secretHex;
  }

  return {
    intentId: match[1],
    sig,
    ...(claimSecretHex ? { claimSecretHex } : {}),
  };
}
