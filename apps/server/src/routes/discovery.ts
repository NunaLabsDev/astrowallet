import type { ServerConfig } from "@astrowallet/domain";
import { Hono } from "hono";

export type DiscoveryRouteEnv = {
  Variables: {
    config: ServerConfig;
  };
};

export function createDiscoveryRoutes(): Hono<DiscoveryRouteEnv> {
  const router = new Hono<DiscoveryRouteEnv>();

  router.get("/openapi.json", (c) => {
    const config = c.get("config");
    const serverUrl = config.pwaOrigin.replace(/\/+$/, "");

    return c.json({
      openapi: "3.1.0",
      info: {
        title: "AstroWallet & AstroConnect v1 Open API",
        version: "1.0.0",
        description:
          "Open, permissionless Stellar/Soroban wallet connection, SEP-53 authentication, Clear-Sign XDR execution, and AstroID directory protocol for Telegram Mini Apps.",
      },
      servers: [
        {
          url: serverUrl,
          description: `AstroWallet (${config.network})`,
        },
      ],
      paths: {
        "/health": {
          get: {
            summary: "Health & active Stellar network check",
            responses: {
              "200": { description: "Service operational status and configured network" },
            },
          },
        },
        "/v1/identity/resolve": {
          get: {
            summary: "Resolve public AstroID Stellar G.../C... addresses by Telegram user ID, @username, or address",
            parameters: [
              {
                name: "q",
                in: "query",
                required: true,
                schema: { type: "string" },
                description: "Numeric telegramUserId, @username, or G.../C... address",
              },
            ],
            responses: {
              "200": { description: "Public linked addresses (never returns encrypted vault ciphertext)" },
              "400": { description: "Invalid query parameter" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/v1/connect/requests": {
          post: {
            summary:
              "Create an ephemeral AstroConnect v1 request (auth, sign_message, sign_xdr, or sign_auth_entry)",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["action", "app", "payload"],
                    properties: {
                      action: {
                        type: "string",
                        enum: ["auth", "sign_message", "sign_xdr", "sign_auth_entry"],
                      },
                      ttlSeconds: { type: "integer", minimum: 60, maximum: 300 },
                      app: {
                        type: "object",
                        required: ["name", "botUsername"],
                        properties: {
                          name: { type: "string" },
                          botUsername: { type: "string" },
                          miniAppShortName: { type: "string" },
                          returnStartAppParam: { type: "string" },
                          iconUrl: { type: "string", format: "uri" },
                          origin: { type: "string", format: "uri" },
                        },
                      },
                      payload: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": { description: "Created request with requestId, sig, resultToken, and Telegram deepLink" },
              "400": { description: "Invalid payload or xdrSha256 mismatch" },
              "429": { description: "Rate limit exceeded" },
            },
          },
        },
        "/v1/connect/requests/{requestId}": {
          get: {
            summary: "Poll request status/result (with X-Connect-Token) or load request details (with ?sig=)",
            parameters: [
              { name: "requestId", in: "path", required: true, schema: { type: "string" } },
              { name: "sig", in: "query", required: false, schema: { type: "string" } },
              { name: "X-Connect-Token", in: "header", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Request status/result or Clear-Sign request metadata" },
              "401": { description: "Missing or invalid token/signature" },
              "404": { description: "Request not found" },
              "410": { description: "Request expired" },
            },
          },
        },
        "/v1/connect/requests/{requestId}/complete": {
          post: {
            summary: "Complete (approve or reject) an AstroConnect request from AstroWallet",
            parameters: [
              { name: "requestId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Completed request and verified Telegram Boomerang returnUrl" },
              "400": { description: "Invalid SEP-53 signature or completion payload" },
              "409": { description: "Already completed, cross-network, or unconfirmed txHash" },
            },
          },
        },
      },
    });
  });

  router.get("/llms.txt", (c) => {
    const config = c.get("config");
    const serverUrl = config.pwaOrigin.replace(/\/+$/, "");
    const botUsername = config.tgBotUsername ?? "AstroWalletAppBot";
    const shortName = config.tgMiniAppShortName ?? "wallet";

    const lines = [
      "# AstroWallet & AstroConnect v1",
      "",
      "> Open, non-custodial Stellar (Classic G... + Soroban C...) & TON wallet standard for Telegram Mini Apps.",
      "",
      "## Active Instance",
      `- Network: ${config.network}`,
      `- Network Passphrase: ${config.networkPassphrase}`,
      `- API Base URL: ${serverUrl}`,
      `- Telegram Mini App: https://t.me/${botUsername}/${shortName}`,
      `- OpenAPI Spec: ${serverUrl}/openapi.json`,
      "",
      "## Open Endpoints (CORS Enabled)",
      `- GET ${serverUrl}/v1/identity/resolve?q=<telegramUserId|@username|G...|C...>`,
      `- POST ${serverUrl}/v1/connect/requests  (actions: auth | sign_message | sign_xdr | sign_auth_entry)`,
      `- GET ${serverUrl}/v1/connect/requests/:requestId  (Header: X-Connect-Token: <resultToken>)`,
      `- POST ${serverUrl}/v1/connect/requests/:requestId/complete`,
      "",
      "## Protocol Flow (Telegram ToS 7.3-7.4 Compliant)",
      "1. Your app calls POST /v1/connect/requests with action ('auth', 'sign_message', 'sign_xdr', or 'sign_auth_entry'), app metadata ({ name, botUsername, miniAppShortName?, returnStartAppParam? }), and payload.",
      "2. Server returns { requestId, sig, resultToken, deepLink }.",
      "3. Open deepLink via Telegram.WebApp.openTelegramLink(deepLink) (format: https://t.me/<bot>/<short>?startapp=c-<requestId>-<sig>).",
      "4. User reviews the request in AstroWallet with independent Scan & Shield simulation, signs locally with Argon2id/IndexedDB keys, and gets a safe Telegram Boomerang button back to your bot.",
      "5. Your app polls GET /v1/connect/requests/:requestId with X-Connect-Token: <resultToken> and verifies SEP-53 Ed25519 signatures offline via @astrowallet/connect.",
    ];

    return c.text(lines.join("\n"), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  return router;
}
