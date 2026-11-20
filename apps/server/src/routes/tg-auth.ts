import type { ServerConfig } from "@astrowallet/domain";
import {
  formatConnectChallengeMessage,
  signIntentToken,
  signMiniAppSessionToken,
  verifyIntentToken,
  verifyMiniAppSessionToken,
  verifyTelegramInitData,
  type ConnectChallengePayload,
  type MiniAppSessionClaims,
} from "@astrowallet/tg-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import {
  ConnectAccountSubmissionSchema,
  verifyConnectAccountSubmissions,
} from "./connect-verifier.js";

const TgAuthBodySchema = z.object({
  initData: z.string().trim().min(1).max(8192),
});

const LinkConfirmBodySchema = z.object({
  intentId: z.string().trim().min(1).max(64),
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  accounts: z.array(ConnectAccountSubmissionSchema).min(1).max(10),
});

export type TgAuthRouteEnv = {
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

const MINI_APP_SESSION_TTL_SECONDS = 15 * 60;

export async function authenticateMiniAppSession(c: {
  req: { header(name: string): string | undefined };
  get(key: "config"): ServerConfig;
}): Promise<
  | { ok: true; claims: MiniAppSessionClaims }
  | { ok: false; status: 401 | 403; error: string }
> {
  const authHeader = c.req.header("Authorization")?.trim() ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Missing Bearer session token" };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: "Empty Bearer session token" };
  }
  const config = c.get("config");
  const result = await verifyMiniAppSessionToken(
    token,
    config.network,
    config.intentHmacSecret,
  );
  if (!result.valid) {
    return {
      ok: false,
      status: result.reason === "wrong_network" ? 403 : 401,
      error: `Mini App session ${result.reason}`,
    };
  }
  return { ok: true, claims: result.claims };
}

export function createTgAuthRoutes(): Hono<TgAuthRouteEnv> {
  const router = new Hono<TgAuthRouteEnv>();

  router.post("/auth", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");

    let body: z.infer<typeof TgAuthBodySchema>;
    try {
      body = TgAuthBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid Telegram initData request", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const verified = await verifyTelegramInitData(body.initData, config.tgBotToken, {
      maxAgeSeconds: 300,
    });
    if (!verified.valid) {
      return c.json({ error: `Telegram initData ${verified.reason}` }, 401);
    }

    const tgUser = verified.data.user;
    await repo.upsertTelegramUser({
      telegramUserId: tgUser.id,
      usernameLower: tgUser.usernameLower,
    });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + MINI_APP_SESSION_TTL_SECONDS;
    const sessionToken = await signMiniAppSessionToken(
      {
        telegramUserId: tgUser.id,
        usernameLower: tgUser.usernameLower,
        network: config.network,
        issuedAt: now,
        expiresAt,
      },
      config.intentHmacSecret,
    );

    const linkedAccounts = await repo.listLinkedAddresses(tgUser.id);

    return c.json({
      sessionToken,
      expiresAt,
      user: tgUser,
      startParam: verified.data.startParam,
      linkedAccounts,
    });
  });

  router.get("/me", async (c) => {
    const session = await authenticateMiniAppSession(c);
    if (!session.ok) {
      return c.json({ error: session.error }, session.status);
    }
    const repo = c.get("repo");
    const [user, linkedAccounts] = await Promise.all([
      repo.getUserById(session.claims.telegramUserId),
      repo.listLinkedAddresses(session.claims.telegramUserId),
    ]);
    return c.json({
      user: user ?? {
        telegramUserId: session.claims.telegramUserId,
        usernameLower: session.claims.usernameLower,
        alertsEnabled: true,
      },
      linkedAccounts,
    });
  });

  router.post("/link-challenge", async (c) => {
    const session = await authenticateMiniAppSession(c);
    if (!session.ok) {
      return c.json({ error: session.error }, session.status);
    }

    const config = c.get("config");
    const repo = c.get("repo");
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const intentId = `it_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const challenge: ConnectChallengePayload = {
      challengeId: `ch_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      network: config.network,
      telegramUserId: session.claims.telegramUserId,
      usernameLower: session.claims.usernameLower,
      issuedAt: now,
      expiresAt,
    };
    const message = formatConnectChallengeMessage(challenge);
    const sig = await signIntentToken(
      {
        intentId,
        network: config.network,
        telegramUserId: session.claims.telegramUserId,
        expiresAt,
      },
      config.intentHmacSecret,
    );

    await repo.createSignedIntent({
      intentId,
      network: config.network,
      creatorTelegramUserId: session.claims.telegramUserId,
      actionType: "connect",
      payloadJson: JSON.stringify({ challenge, message }),
      hmacSig: sig,
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    return c.json({
      intentId,
      sig,
      challenge,
      message,
    });
  });

  router.post("/link-confirm", async (c) => {
    const session = await authenticateMiniAppSession(c);
    if (!session.ok) {
      return c.json({ error: session.error }, session.status);
    }

    let body: z.infer<typeof LinkConfirmBodySchema>;
    try {
      body = LinkConfirmBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid link-confirm payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const config = c.get("config");
    const repo = c.get("repo");
    const intent = await repo.getSignedIntent(body.intentId);
    if (!intent) {
      return c.json({ error: "Link challenge intent not found" }, 404);
    }
    if (intent.actionType !== "connect") {
      return c.json({ error: "Intent is not a connect challenge" }, 400);
    }
    if (intent.creatorTelegramUserId !== session.claims.telegramUserId) {
      return c.json({ error: "Intent belongs to another Telegram user" }, 403);
    }

    const check = await verifyIntentToken(
      {
        intentId: intent.intentId,
        network: intent.network,
        telegramUserId: intent.creatorTelegramUserId,
        expiresAt: intent.expiresAt,
      },
      body.sig,
      config.intentHmacSecret,
    );
    if (!check.valid) {
      return c.json(
        { error: `Intent token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }
    if (intent.network !== config.network) {
      return c.json({ error: "Cross-network intent rejected" }, 409);
    }
    if (intent.status !== "pending") {
      return c.json({ error: `Intent already ${intent.status}` }, 409);
    }

    const storedPayload = JSON.parse(intent.payloadJson) as {
      message?: string;
      challenge?: { usernameLower?: string };
    };
    if (!storedPayload.message) {
      return c.json({ error: "Corrupted challenge state" }, 500);
    }

    const verification = await verifyConnectAccountSubmissions({
      config,
      repo,
      telegramUserId: session.claims.telegramUserId,
      challengeMessage: storedPayload.message,
      accounts: body.accounts,
    });
    if (!verification.ok) {
      return c.json({ error: verification.error }, verification.status);
    }

    const linked = await repo.linkVerifiedAddresses({
      telegramUserId: session.claims.telegramUserId,
      usernameLower: session.claims.usernameLower ?? storedPayload.challenge?.usernameLower,
      accounts: verification.verifiedInputs,
    });
    await repo.markIntentConfirmed(intent.intentId);

    return c.json({
      ok: true,
      linkedCount: linked.length,
      accounts: linked,
    });
  });

  return router;
}
