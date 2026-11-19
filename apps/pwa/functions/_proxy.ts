export interface PagesProxyEnv {
  ASTROWALLET_SERVER?: {
    fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
  };
}

export interface PagesProxyContext {
  request: Request;
  env: PagesProxyEnv;
}

/**
 * Forwards API, webhook, and Telegram Bot requests from Cloudflare Pages
 * (`astrowallet.pages.dev`) to `astrowallet-server` via Service Binding.
 */
export async function forwardToWorker(context: PagesProxyContext): Promise<Response> {
  if (!context.env.ASTROWALLET_SERVER) {
    return Response.json(
      { ok: false, error: "ASTROWALLET_SERVER service binding is not configured." },
      { status: 503 },
    );
  }
  return context.env.ASTROWALLET_SERVER.fetch(context.request);
}
