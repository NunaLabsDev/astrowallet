export interface PagesProxyEnv {
  ASTROWALLET_SERVER?: {
    fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
  };
  ASTROWALLET_SERVER_TESTNET?: {
    fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
  };
}

export interface PagesProxyContext {
  request: Request;
  env: PagesProxyEnv;
}

/**
 * Forwards API, webhook, and Telegram Bot requests from Cloudflare Pages
 * (`astrowallet.pages.dev`) to `astrowallet-server` (Mainnet or Testnet) via Service Binding.
 */
export async function forwardToWorker(context: PagesProxyContext): Promise<Response> {
  const requestedNet = (
    context.request.headers.get("X-Astro-Network") ??
    new URL(context.request.url).searchParams.get("network") ??
    ""
  )
    .trim()
    .toLowerCase();
  const targetService =
    requestedNet === "testnet" && context.env.ASTROWALLET_SERVER_TESTNET
      ? context.env.ASTROWALLET_SERVER_TESTNET
      : context.env.ASTROWALLET_SERVER;

  if (!targetService) {
    return Response.json(
      { ok: false, error: "ASTROWALLET_SERVER service binding is not configured." },
      { status: 503 },
    );
  }
  return targetService.fetch(context.request);
}
