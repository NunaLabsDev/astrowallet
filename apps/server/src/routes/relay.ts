import type { ServerConfig } from "@astrowallet/domain";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import type { FetchLike } from "../stellar-verifier.js";

export interface RelayRoutesDeps {
  fetchFn?: FetchLike | undefined;
}

export type RelayRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
  };
};

const RelaySubmitSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("soroban"),
    funcXdrBase64: z.string().min(8),
    authEntriesXdrBase64: z.array(z.string().min(8)).default([]),
  }),
  z.object({
    mode: z.literal("feebump"),
    signedTxXdrBase64: z.string().min(16),
  }),
]);

/**
 * Policy-gated proxy to OpenZeppelin Stellar Channels (sponsors transaction gas fees,
 * distinct from Classic CAP-33 account reserves).
 */
export function createRelayRoutes(deps: RelayRoutesDeps = {}): Hono<RelayRouteEnv> {
  const router = new Hono<RelayRouteEnv>();
  const fetchFn = deps.fetchFn ?? fetch;

  router.post("/submit", async (c) => {
    const config = c.get("config");
    if (!config.ozChannelsApiUrl) {
      return c.json(
        { error: "OpenZeppelin Channels relayer URL (OZ_CHANNELS_API_URL) is not configured" },
        503,
      );
    }

    let body: z.infer<typeof RelaySubmitSchema>;
    try {
      body = RelaySubmitSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid relay payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const upstreamPayload =
      body.mode === "soroban"
        ? { func: body.funcXdrBase64, auth: body.authEntriesXdrBase64 }
        : { xdr: body.signedTxXdrBase64 };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.ozChannelsApiKey) {
      headers.Authorization = `Bearer ${config.ozChannelsApiKey}`;
    }

    const cleanUrl = config.ozChannelsApiUrl.replace(/\/+$/, "");
    const res = await fetchFn(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return c.json(
        { error: `Relayer rejected transaction (${res.status})`, details: errText },
        502,
      );
    }

    const data = (await res.json()) as { hash?: string; txHash?: string; status?: string };
    return c.json({
      ok: true,
      mode: body.mode,
      hash: data.hash ?? data.txHash ?? "",
      status: data.status ?? "submitted",
    });
  });

  return router;
}
