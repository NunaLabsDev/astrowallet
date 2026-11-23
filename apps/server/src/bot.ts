import {
  buildSoroswapQuoteBody,
  createHorizonPathSwapAdapter,
  decimalToStroops7,
  parseSoroswapQuoteOutput,
  stroops7ToDecimal,
} from "@astrowallet/defi";
import {
  ClassicAddressSchema,
  StellarAddressSchema,
  type IntentActionType,
  type ServerConfig,
  type SignedIntent,
} from "@astrowallet/domain";
import {
  createSecurityShield,
  fetchSep42VerifiedAssets,
} from "@astrowallet/security-shield";
import {
  buildMiniAppWebAppUrl,
  buildTelegramMiniAppLink,
  deriveClaimId,
  formatAccountsSummary,
  formatBalancesSummary,
  formatClaimLinkCard,
  formatConnectChallengeMessage,
  formatConnectPrompt,
  formatPaymentIntentCard,
  formatRequestCard,
  formatReserveReportCard,
  formatScanReportCard,
  formatSplitCard,
  formatSwapQuoteCard,
  signIntentToken,
  type AccountBalanceSummaryEntry,
  type AccountReserveEntry,
  type ConnectChallengePayload,
} from "@astrowallet/tg-protocol";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Bot, InlineKeyboard } from "grammy";
import type { ServerRepository } from "./db/repository.js";
import { lookupDirectoryTag, lookupSep29MemoRequired } from "./routes/proxy.js";
import {
  fetchLiveAccountBalances,
  fetchLiveAccountReserveInfo,
  type FetchLike,
} from "./stellar-verifier.js";

export interface BotDependencies {
  fetchFn?: FetchLike | undefined;
  cache?: KVNamespace | undefined;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function createAndSignIntent(
  config: ServerConfig,
  repo: ServerRepository,
  input: {
    intentId?: string | undefined;
    creatorTelegramUserId: string;
    actionType: IntentActionType;
    payload: Record<string, unknown>;
    chatId?: string | undefined;
    ttlSeconds?: number | undefined;
  },
): Promise<{ intent: SignedIntent }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.ttlSeconds ?? 300);
  const intentId = input.intentId ?? generateId("it");
  const hmacSig = await signIntentToken(
    {
      intentId,
      network: config.network,
      telegramUserId: input.creatorTelegramUserId,
      expiresAt,
    },
    config.intentHmacSecret,
  );

  const intent: SignedIntent = {
    intentId,
    network: config.network,
    creatorTelegramUserId: input.creatorTelegramUserId,
    actionType: input.actionType,
    payloadJson: JSON.stringify(input.payload),
    hmacSig,
    chatId: input.chatId,
    status: "pending",
    expiresAt,
    createdAt: now,
  };

  await repo.createSignedIntent(intent);
  return { intent };
}

function appendMiniAppButton(
  keyboard: InlineKeyboard,
  label: string,
  opts: {
    isPrivateChat: boolean;
    config: ServerConfig;
    botUsername?: string | undefined;
    intentId?: string | undefined;
    sig?: string | undefined;
    tab?: string | undefined;
  },
): InlineKeyboard {
  if (opts.isPrivateChat) {
    return keyboard.webApp(
      label,
      buildMiniAppWebAppUrl(opts.config.pwaOrigin, {
        intentId: opts.intentId,
        sig: opts.sig,
        tab: opts.tab,
      }),
    );
  }
  return keyboard.url(
    label,
    buildTelegramMiniAppLink({
      botUsername: opts.config.tgBotUsername ?? opts.botUsername,
      shortName: opts.config.tgMiniAppShortName,
      pwaOrigin: opts.config.pwaOrigin,
      intentId: opts.intentId,
      sig: opts.sig,
      tab: opts.tab,
    }),
  );
}

function parsePositiveAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;
  if (Number(trimmed) <= 0) return null;
  return trimmed;
}

function parseAssetCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(upper)) return null;
  return upper;
}

function divideAmountExact(totalAmount: string, count: number): string | null {
  try {
    const totalStroops = decimalToStroops7(totalAmount);
    const divisor = BigInt(count);
    // Ceiling division so count * shareStroops never underpays the split requester
    const shareStroops = (totalStroops + divisor - 1n) / divisor;
    if (shareStroops <= 0n) return null;
    return stroops7ToDecimal(shareStroops);
  } catch {
    return null;
  }
}

const CONFIRM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateConfirmCode(): string {
  const rand = new Uint8Array(6);
  crypto.getRandomValues(rand);
  let out = "";
  for (const byte of rand) {
    out += CONFIRM_CODE_ALPHABET[byte % CONFIRM_CODE_ALPHABET.length] ?? "A";
  }
  return out;
}

async function resolveRecipient(
  repo: ServerRepository,
  rawTarget: string,
): Promise<{ ok: true; address: string; label: string } | { ok: false; message: string }> {
  const target = rawTarget.trim();
  if (target.startsWith("@")) {
    const cleanUsername = target.slice(1).toLowerCase();
    const user = await repo.getUserByUsername(cleanUsername);
    if (!user) {
      return {
        ok: false,
        message: `@${cleanUsername} has not linked an AstroWallet yet. Ask them to run /connect first.`,
      };
    }
    const accounts = await repo.listLinkedAddresses(user.telegramUserId);
    const defaultAcc = accounts.find((a) => a.isDefault) ?? accounts[0];
    if (!defaultAcc) {
      return {
        ok: false,
        message: `@${cleanUsername} has no active linked addresses yet.`,
      };
    }
    return {
      ok: true,
      address: defaultAcc.address,
      label: `@${cleanUsername} (${defaultAcc.label})`,
    };
  }

  const parsedAddr = StellarAddressSchema.safeParse(target);
  if (!parsedAddr.success) {
    return {
      ok: false,
      message: "Recipient must be a linked @username or valid Stellar G.../C.../M... address.",
    };
  }
  return {
    ok: true,
    address: parsedAddr.data,
    label: `${parsedAddr.data.slice(0, 6)}...${parsedAddr.data.slice(-6)}`,
  };
}

/**
 * Creates a Telegram Multichain Super-Bot instance backed by D1 + Mini App initData/Intent auth.
 * Compliant with Telegram ToS Clause 7.3 (Multichain Wallet Mini App: Stellar + TON Connect).
 */
export function createTelegramBot(
  config: ServerConfig,
  repo: ServerRepository,
  deps: BotDependencies = {},
): Bot {
  const clientOpts: Record<string, unknown> = {};
  if (config.telegramApiOrigin) {
    clientOpts.apiRoot = config.telegramApiOrigin;
  }
  if (deps.fetchFn) {
    clientOpts.fetch = deps.fetchFn;
  }
  const bot = new Bot(
    config.tgBotToken,
    Object.keys(clientOpts).length > 0
      ? ({ client: clientOpts } as ConstructorParameters<typeof Bot>[1])
      : undefined,
  );
  const networkBadge = config.network.toUpperCase();
  const fetchFn = deps.fetchFn ?? fetch;

  bot.catch((err) => {
    console.error(
      "Telegram bot update error:",
      err.error instanceof Error ? err.error.message : "unknown",
    );
  });

  function isExplicitBotMentionInGroup(ctx: {
    chat?: { type?: string } | undefined;
    message?: { text?: string | undefined } | undefined;
    me?: { username?: string | undefined } | undefined;
  }): boolean {
    if (ctx.chat?.type === "private") return true;
    const raw = (ctx.message?.text ?? "").toLowerCase();
    const botUsername = (ctx.me?.username ?? config.tgBotUsername ?? "AstroWalletAppBot").toLowerCase();
    return raw.includes(`@${botUsername}`);
  }

  async function requirePrivateChat(ctx: {
    chat?: { type?: string } | undefined;
    message?: { text?: string | undefined } | undefined;
    me?: { username?: string | undefined } | undefined;
    reply: (text: string) => Promise<unknown>;
  }): Promise<boolean> {
    if (ctx.chat?.type !== "private") {
      if (isExplicitBotMentionInGroup(ctx)) {
        const botHandle = ctx.me?.username ?? config.tgBotUsername ?? "AstroWalletAppBot";
        await ctx.reply(`Please run this command in a private DM with @${botHandle} for security.`);
      }
      return false;
    }
    return true;
  }

  bot.use(async (ctx, next) => {
    if (ctx.from?.username) {
      const tgId = String(ctx.from.id);
      const usernameLower = ctx.from.username.toLowerCase();
      const existing = await repo.getUserById(tgId).catch(() => null);
      if (existing && existing.usernameLower !== usernameLower) {
        await repo
          .upsertTelegramUser({ telegramUserId: tgId, usernameLower })
          .catch(() => undefined);
      }
    }
    await next();
  });

  async function resolveCommandAsset(
    raw: string,
    lookupAddress: string | undefined,
  ): Promise<
    | { ok: true; assetCode: string; assetIssuer?: string | undefined }
    | { ok: false; message: string }
  > {
    const [rawCode = "", rawIssuer, ...extra] = raw.trim().split(":");
    if (extra.length > 0) {
      return { ok: false, message: "Invalid asset format (use XLM or CODE:G...ISSUER)." };
    }
    const assetCode = parseAssetCode(rawCode);
    if (!assetCode) {
      return {
        ok: false,
        message: "Invalid asset code (example: XLM or USDC:G...ISSUER).",
      };
    }

    if (rawIssuer !== undefined) {
      if (assetCode === "XLM") {
        return { ok: false, message: "Native XLM does not require an issuer." };
      }
      const parsedIssuer = ClassicAddressSchema.safeParse(rawIssuer.trim());
      if (!parsedIssuer.success) {
        return {
          ok: false,
          message: `Invalid issuer for ${assetCode}. Expected a Classic G... address.`,
        };
      }
      return { ok: true, assetCode, assetIssuer: parsedIssuer.data };
    }

    if (assetCode === "XLM") {
      return { ok: true, assetCode: "XLM" };
    }

    if (lookupAddress?.startsWith("G")) {
      try {
        const live = await fetchLiveAccountBalances(config, lookupAddress, fetchFn);
        const match = live.balances.find(
          (b) => b.assetCode.toUpperCase() === assetCode && b.assetIssuer,
        );
        if (match?.assetIssuer) {
          return { ok: true, assetCode, assetIssuer: match.assetIssuer };
        }
      } catch {
        // Fall through to SEP-42 lookup
      }
    }

    if (config.sep42AssetListUrls.length > 0) {
      try {
        const verified = await fetchSep42VerifiedAssets(config.sep42AssetListUrls, { fetchFn });
        const match = verified.find((v) => v.code.toUpperCase() === assetCode);
        if (match) {
          return { ok: true, assetCode, assetIssuer: match.issuer };
        }
      } catch {
        // Fall through to explicit issuer instruction
      }
    }

    return {
      ok: false,
      message: `Specify issuer for ${assetCode} as <code>${assetCode}:G...ISSUER</code> (or hold a trustline on your linked Classic account).`,
    };
  }

  bot.command("start", async (ctx) => {
    if (!isExplicitBotMentionInGroup(ctx)) return;
    const keyboard = appendMiniAppButton(
      new InlineKeyboard(),
      "🛡️ Open AstroWallet",
      {
        isPrivateChat: ctx.chat?.type === "private",
        config,
        botUsername: ctx.me?.username,
      },
    )
      .row()
      .url("⚡ AstroDex", "https://t.me/AstroDexBot/dex")
      .url("🚀 AstroGate", "https://t.me/AstroGateSorobanBot/app");

    const caption = [
      `<b>AstroWallet</b> · <code>${networkBadge}</code>`,
      "Non-custodial Stellar &amp; TON wallet inside Telegram.",
      "Tap below to open your wallet, or run /help for quick commands.",
    ].join("\n");

    const bannerUrl = `${config.pwaOrigin.replace(/\/+$/, "")}/telegram/astrowallet-bot-banner.png`;
    try {
      await ctx.replyWithPhoto(bannerUrl, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch {
      await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard });
    }
  });

  bot.command("help", async (ctx) => {
    if (!isExplicitBotMentionInGroup(ctx)) return;
    const botHandle = ctx.me?.username ? `@${ctx.me.username}` : "@AstroWalletAppBot";
    await ctx.reply(
      [
        `<b>AstroWallet</b> · <code>${networkBadge}</code>`,
        "Keys stay on your device — sign every transaction with PIN or biometrics.",
        "",
        "<b>Wallet:</b> /balance · /accounts · /connect · /unlink",
        "<b>Pay &amp; Trade:</b> /pay · /request · /split · /swap",
        "<b>Tools:</b> /scan · /reserve · /alerts",
        `<i>Inline:</i> <code>${botHandle} pay 10 XLM @friend</code>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("connect", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    if (!(await requirePrivateChat(ctx))) return;

    const tgId = String(from.id);
    const usernameLower = from.username?.toLowerCase();
    await repo.upsertTelegramUser({ telegramUserId: tgId, usernameLower });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const confirmCode = generateConfirmCode();
    const challenge: ConnectChallengePayload = {
      challengeId: generateId("ch"),
      network: config.network,
      telegramUserId: tgId,
      usernameLower,
      issuedAt: now,
      expiresAt,
    };

    const { intent } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "connect",
      chatId: String(ctx.chat.id),
      payload: {
        challenge,
        message: formatConnectChallengeMessage(challenge),
        confirmCode,
      },
    });

    const keyboard = appendMiniAppButton(
      new InlineKeyboard(),
      "Open Mini App & Link Wallet",
      {
        isPrivateChat: true,
        config,
        botUsername: ctx.me?.username,
        intentId: intent.intentId,
        sig: intent.hmacSig,
      },
    );

    await ctx.reply(formatConnectPrompt(config.network, 5, confirmCode), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.command("unlink", async (ctx) => {
    if (!ctx.from) return;
    if (!(await requirePrivateChat(ctx))) return;
    const removed = await repo.unlinkUserAddresses(String(ctx.from.id));
    await ctx.reply(
      removed > 0
        ? `Unlinked ${removed} connected wallet account(s) from this Telegram profile.`
        : "No linked wallet accounts were found for this Telegram profile.",
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("unlink_self", async (ctx) => {
    const removed = await repo.unlinkUserAddresses(String(ctx.from.id));
    await ctx.answerCallbackQuery({
      text: removed > 0 ? `Unlinked ${removed} account(s)` : "No linked accounts found",
    });
    if (ctx.callbackQuery.message) {
      await ctx.editMessageText(
        `🔒 Disconnected ${removed} wallet account(s) from your Telegram profile. Run /connect anytime to re-link.`,
      );
    }
  });

  bot.command("accounts", async (ctx) => {
    if (!ctx.from) return;
    if (!(await requirePrivateChat(ctx))) return;
    const tgId = String(ctx.from.id);
    const accounts = await repo.listLinkedAddresses(tgId);
    const keyboard = new InlineKeyboard();
    for (const acc of accounts) {
      if (!acc.isDefault) {
        keyboard.text(`Set Default: ${acc.label}`, `set_default:${acc.address}`).row();
      }
    }

    await ctx.reply(formatAccountsSummary(accounts, config.network), {
      parse_mode: "HTML",
      ...(accounts.some((a) => !a.isDefault) ? { reply_markup: keyboard } : {}),
    });
  });

  bot.callbackQuery(/^set_default:(G[A-Z2-7]{55}|C[A-Z2-7]{55})$/, async (ctx) => {
    const tgId = String(ctx.from.id);
    const address = ctx.match[1];
    if (!address) return;

    const ok = await repo.setDefaultLinkedAddress(tgId, address);
    if (!ok) {
      await ctx.answerCallbackQuery({ text: "Account not found for your user." });
      return;
    }

    const updated = await repo.listLinkedAddresses(tgId);
    const keyboard = new InlineKeyboard();
    for (const acc of updated) {
      if (!acc.isDefault) {
        keyboard.text(`Set Default: ${acc.label}`, `set_default:${acc.address}`).row();
      }
    }

    await ctx.editMessageText(formatAccountsSummary(updated, config.network), {
      parse_mode: "HTML",
      ...(updated.some((a) => !a.isDefault) ? { reply_markup: keyboard } : {}),
    });
    await ctx.answerCallbackQuery({ text: "Default receiving account updated" });
  });

  bot.command("balance", async (ctx) => {
    if (!ctx.from) return;
    if (!(await requirePrivateChat(ctx))) return;
    const tgId = String(ctx.from.id);
    const accounts = await repo.listLinkedAddresses(tgId);
    if (accounts.length === 0) {
      await ctx.reply(formatBalancesSummary([], config.network), { parse_mode: "HTML" });
      return;
    }

    const entries: AccountBalanceSummaryEntry[] = await Promise.all(
      accounts.map(async (acc) => {
        const live = await fetchLiveAccountBalances(config, acc.address, fetchFn);
        return {
          label: acc.label,
          address: acc.address,
          kind: acc.kind,
          funded: live.funded,
          balances: live.balances,
        };
      }),
    );

    await ctx.reply(formatBalancesSummary(entries, config.network), {
      parse_mode: "HTML",
    });
  });

  bot.command("pay", async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${tgId}`;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    if (args.length < 3) {
      await ctx.reply(
        "Usage: <code>/pay &lt;amount&gt; &lt;asset&gt; &lt;@username|address&gt; [memo]</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const amount = parsePositiveAmount(args[0] ?? "");
    if (!amount) {
      await ctx.reply("Invalid amount or asset code (example: <code>/pay 10 XLM @alice</code>)", {
        parse_mode: "HTML",
      });
      return;
    }

    const senderAccounts = await repo.listLinkedAddresses(tgId);
    const senderDefault =
      senderAccounts.find((a) => a.isDefault && a.address.startsWith("G")) ??
      senderAccounts.find((a) => a.address.startsWith("G"));
    const assetRes = await resolveCommandAsset(args[1] ?? "", senderDefault?.address);
    if (!assetRes.ok) {
      await ctx.reply(assetRes.message, { parse_mode: "HTML" });
      return;
    }
    const { assetCode, assetIssuer } = assetRes;

    const rawRecipient = (args[2] ?? "").trim();
    const resolved = await resolveRecipient(repo, rawRecipient);
    if (!resolved.ok) {
      // Viral Telegram Claim Link flow when recipient is an unregistered @username
      if (rawRecipient.startsWith("@") && /^@[A-Za-z0-9_]{5,32}$/.test(rawRecipient)) {
        const recipientHandle = rawRecipient.slice(1).toLowerCase();
        if (!config.claimEscrowContractId) {
          await ctx.reply(
            `@${recipientHandle} has not linked an AstroWallet yet, and Claim Link Escrow is not configured on this server. Ask them to run /connect first.`,
          );
          return;
        }

        const intentId = generateId("it");
        const claimId = await deriveClaimId(intentId);
        const escrowExpiresAt = Math.floor(Date.now() / 1000) + 86_400 * 7;
        const { intent } = await createAndSignIntent(config, repo, {
          intentId,
          creatorTelegramUserId: tgId,
          actionType: "claim",
          chatId: String(ctx.chat.id),
          ttlSeconds: 300,
          payload: {
            amount,
            assetCode,
            ...(assetIssuer ? { assetIssuer } : {}),
            recipientUsername: recipientHandle,
            senderLabel: username,
            claimId,
            escrowContractId: config.claimEscrowContractId,
            escrowExpiresAt,
          },
        });

        const keyboard = appendMiniAppButton(
          new InlineKeyboard(),
          `Fund Escrow (${amount} ${assetCode})`,
          {
            isPrivateChat: ctx.chat?.type === "private",
            config,
            botUsername: ctx.me?.username,
            intentId: intent.intentId,
            sig: intent.hmacSig,
          },
        );
        const sent = await ctx.reply(
          formatClaimLinkCard({
            status: "pending_funding",
            amount,
            assetCode,
            senderLabel: username,
            recipientUsername: recipientHandle,
            network: config.network,
          }),
          { parse_mode: "HTML", reply_markup: keyboard },
        );
        await repo.attachIntentMessageRef(intent.intentId, {
          chatId: String(sent.chat.id),
          messageId: String(sent.message_id),
        });
        return;
      }

      await ctx.reply(resolved.message);
      return;
    }

    const memo = args.length > 3 ? args.slice(3).join(" ").slice(0, 28) : undefined;
    const { intent } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "pay",
      chatId: String(ctx.chat.id),
      payload: {
        amount,
        assetCode,
        ...(assetIssuer ? { assetIssuer } : {}),
        destination: resolved.address,
        recipientLabel: resolved.label,
        senderLabel: username,
        memo,
      },
    });

    const keyboard = appendMiniAppButton(
      new InlineKeyboard(),
      "Sign in Telegram Mini App",
      {
        isPrivateChat: ctx.chat?.type === "private",
        config,
        botUsername: ctx.me?.username,
        intentId: intent.intentId,
        sig: intent.hmacSig,
      },
    );
    const sent = await ctx.reply(
      formatPaymentIntentCard({
        status: "pending",
        amount,
        assetCode,
        senderLabel: username,
        recipientLabel: resolved.label,
        memo,
        network: config.network,
      }),
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await repo.attachIntentMessageRef(intent.intentId, {
      chatId: String(sent.chat.id),
      messageId: String(sent.message_id),
    });
  });

  bot.command("request", async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${tgId}`;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    const amount = parsePositiveAmount(args[0] ?? "");
    if (!amount || !(args[1] ?? "").trim()) {
      await ctx.reply("Usage: <code>/request &lt;amount&gt; &lt;asset&gt; [note]</code>", {
        parse_mode: "HTML",
      });
      return;
    }

    const accounts = await repo.listLinkedAddresses(tgId);
    const targetAcc = accounts.find((a) => a.isDefault) ?? accounts[0];
    if (!targetAcc) {
      await ctx.reply("Link an account with /connect before requesting payments.");
      return;
    }

    const assetRes = await resolveCommandAsset(args[1] ?? "", targetAcc.address);
    if (!assetRes.ok) {
      await ctx.reply(assetRes.message, { parse_mode: "HTML" });
      return;
    }
    const { assetCode, assetIssuer } = assetRes;

    const memo = args.length > 2 ? args.slice(2).join(" ").slice(0, 28) : undefined;
    const { intent } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "request",
      chatId: String(ctx.chat.id),
      payload: {
        amount,
        assetCode,
        ...(assetIssuer ? { assetIssuer } : {}),
        destination: targetAcc.address,
        recipientLabel: username,
        senderLabel: "Any Payer",
        memo,
      },
    });

    const keyboard = appendMiniAppButton(new InlineKeyboard(), "Pay in Mini App", {
      isPrivateChat: ctx.chat?.type === "private",
      config,
      botUsername: ctx.me?.username,
      intentId: intent.intentId,
      sig: intent.hmacSig,
    });
    const sent = await ctx.reply(
      formatRequestCard({
        status: "pending",
        amount,
        assetCode,
        requesterLabel: username,
        recipientAddress: targetAcc.address,
        memo,
        network: config.network,
      }),
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await repo.attachIntentMessageRef(intent.intentId, {
      chatId: String(sent.chat.id),
      messageId: String(sent.message_id),
    });
  });

  bot.command("split", async (ctx) => {
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${tgId}`;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    const totalAmount = parsePositiveAmount(args[0] ?? "");
    const count = Number(args[2]);
    if (!totalAmount || !(args[1] ?? "").trim() || !Number.isInteger(count) || count < 2 || count > 50) {
      await ctx.reply("Usage: <code>/split &lt;total&gt; &lt;asset&gt; &lt;2..50&gt;</code>", {
        parse_mode: "HTML",
      });
      return;
    }

    const accounts = await repo.listLinkedAddresses(tgId);
    const targetAcc = accounts.find((a) => a.isDefault) ?? accounts[0];
    if (!targetAcc) {
      await ctx.reply("Link an account with /connect before creating a split.");
      return;
    }

    const assetRes = await resolveCommandAsset(args[1] ?? "", targetAcc.address);
    if (!assetRes.ok) {
      await ctx.reply(assetRes.message, { parse_mode: "HTML" });
      return;
    }
    const { assetCode, assetIssuer } = assetRes;

    const share = divideAmountExact(totalAmount, count);
    if (!share) {
      await ctx.reply("Split amount per participant is too small.");
      return;
    }
    const { intent } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "split",
      chatId: String(ctx.chat.id),
      payload: {
        amount: share,
        totalAmount,
        participantCount: count,
        assetCode,
        ...(assetIssuer ? { assetIssuer } : {}),
        destination: targetAcc.address,
        recipientLabel: username,
        senderLabel: "Group Member",
      },
    });

    const keyboard = appendMiniAppButton(
      new InlineKeyboard(),
      `Pay Share (${share} ${assetCode})`,
      {
        isPrivateChat: ctx.chat?.type === "private",
        config,
        botUsername: ctx.me?.username,
        intentId: intent.intentId,
        sig: intent.hmacSig,
      },
    );
    const sent = await ctx.reply(
      formatSplitCard({
        amountPerPerson: share,
        totalAmount,
        assetCode,
        participantCount: count,
        requesterLabel: username,
        recipientAddress: targetAcc.address,
        network: config.network,
      }),
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await repo.attachIntentMessageRef(intent.intentId, {
      chatId: String(sent.chat.id),
      messageId: String(sent.message_id),
    });
  });

  bot.command("alerts", async (ctx) => {
    if (!isExplicitBotMentionInGroup(ctx)) return;
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    await repo.upsertTelegramUser({
      telegramUserId: tgId,
      usernameLower: ctx.from.username?.toLowerCase(),
    });
    const arg = (ctx.match ?? "").trim().toLowerCase();

    if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      await repo.setUserAlertsEnabled(tgId, enabled);
      await ctx.reply(
        `Real-time incoming Stellar alerts are now <b>${enabled ? "ON" : "OFF"}</b>.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const user = await repo.getUserById(tgId);
    await ctx.reply(
      `Alerts status: <b>${user?.alertsEnabled ? "ON" : "OFF"}</b>. Use <code>/alerts on</code> or <code>/alerts off</code>.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("reserve", async (ctx) => {
    if (!ctx.from) return;
    if (!(await requirePrivateChat(ctx))) return;
    const tgId = String(ctx.from.id);
    const linked = await repo.listLinkedAddresses(tgId);
    const classicAccounts = linked.filter(
      (acc) => acc.kind === "classic" && acc.address.startsWith("G"),
    );

    if (classicAccounts.length === 0) {
      await ctx.reply(formatReserveReportCard({ entries: [], network: config.network }), {
        parse_mode: "HTML",
      });
      return;
    }

    const entries: AccountReserveEntry[] = await Promise.all(
      classicAccounts.map(async (acc) => {
        const info = await fetchLiveAccountReserveInfo(config, acc.address, fetchFn);
        return {
          label: acc.label,
          address: acc.address,
          funded: info.funded,
          summary: info.summary,
        };
      }),
    );

    const reclaimCandidate = entries.find(
      (e) => e.funded && e.summary && e.summary.reclaimableTrustlines.length > 0,
    );

    const keyboard = new InlineKeyboard();
    if (reclaimCandidate?.summary) {
      const { intent } = await createAndSignIntent(config, repo, {
        creatorTelegramUserId: tgId,
        actionType: "reclaim_reserve",
        chatId: String(ctx.chat.id),
        payload: {
          targetAddress: reclaimCandidate.address,
          targetLabel: reclaimCandidate.label,
          trustlines: reclaimCandidate.summary.reclaimableTrustlines,
          reclaimableXlm: reclaimCandidate.summary.reclaimableXlm,
          amount: reclaimCandidate.summary.reclaimableXlm,
          assetCode: "XLM",
          senderLabel: reclaimCandidate.label,
          recipientLabel: "LumenWipe Reserve Reclaim",
        },
      });
      appendMiniAppButton(
        keyboard,
        `Reclaim +${reclaimCandidate.summary.reclaimableXlm} XLM`,
        {
          isPrivateChat: true,
          config,
          botUsername: ctx.me?.username,
          intentId: intent.intentId,
          sig: intent.hmacSig,
        },
      );
    } else {
      appendMiniAppButton(keyboard, "Open AstroWallet Mini App", {
        isPrivateChat: true,
        config,
        botUsername: ctx.me?.username,
      });
    }

    await ctx.reply(
      formatReserveReportCard({ entries, network: config.network }),
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.command("scan", async (ctx) => {
    if (!isExplicitBotMentionInGroup(ctx)) return;
    const target = (ctx.match ?? "").trim();
    if (!target) {
      await ctx.reply(
        "Usage: <code>/scan &lt;G...|C...|base64_xdr&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const shield = createSecurityShield({
      networkPassphrase: config.networkPassphrase,
      rpcUrls: config.rpcUrls,
      horizonUrls: config.horizonUrls,
      stellarExpertApiBase: config.stellarExpertApiBase,
      sep42AssetListUrls: config.sep42AssetListUrls,
      fetchFn,
      directoryLookup: (addr) => lookupDirectoryTag(config, deps.cache, addr, fetchFn),
      memoRequiredLookup: (addr) => lookupSep29MemoRequired(config, addr, fetchFn),
    });

    const scanner = shield.createScanner();
    const addrParse = StellarAddressSchema.safeParse(target);

    try {
      const report = addrParse.success
        ? await scanner.scanAddress(addrParse.data)
        : await scanner.scanTransactionXdr(target);
      const label = addrParse.success
        ? `${addrParse.data.slice(0, 6)}...${addrParse.data.slice(-6)}`
        : "Transaction Envelope (XDR)";

      await ctx.reply(
        formatScanReportCard({
          targetLabel: label,
          report,
          network: config.network,
        }),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      await ctx.reply(
        `Unable to scan target: ${err instanceof Error ? err.message : "Invalid Stellar address or XDR"}`,
      );
    }
  });

  bot.command("swap", async (ctx) => {
    if (!isExplicitBotMentionInGroup(ctx)) return;
    if (!ctx.from) return;
    const tgId = String(ctx.from.id);
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.length < 3) {
      await ctx.reply(
        "Usage: <code>/swap &lt;amount&gt; &lt;fromAsset&gt; &lt;toAsset&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const amount = parsePositiveAmount(args[0] ?? "");
    const rawFromAsset = (args[1] ?? "").trim();
    const rawToAsset = (args[2] ?? "").trim();
    if (!amount || !rawFromAsset || !rawToAsset) {
      await ctx.reply("Invalid swap parameters.", { parse_mode: "HTML" });
      return;
    }

    try {
      const linked = await repo.listLinkedAddresses(tgId);
      const defaultClassic =
        linked.find((a) => a.isDefault && a.kind === "classic" && a.address.startsWith("G")) ??
        linked.find((a) => a.kind === "classic" && a.address.startsWith("G"));

      const [fromResolved, toResolved] = await Promise.all([
        resolveCommandAsset(rawFromAsset, defaultClassic?.address),
        resolveCommandAsset(rawToAsset, defaultClassic?.address),
      ]);
      if (!fromResolved.ok) {
        await ctx.reply(fromResolved.message, { parse_mode: "HTML" });
        return;
      }
      if (!toResolved.ok) {
        await ctx.reply(toResolved.message, { parse_mode: "HTML" });
        return;
      }
      const fromAsset = fromResolved.assetIssuer
        ? `${fromResolved.assetCode}:${fromResolved.assetIssuer}`
        : fromResolved.assetCode;
      const toAsset = toResolved.assetIssuer
        ? `${toResolved.assetCode}:${toResolved.assetIssuer}`
        : toResolved.assetCode;

      let quote:
        | {
            inputAmount: string;
            expectedOutputAmount: string;
            provider: string;
            priceImpactPct: string;
            unsignedXdr?: string | undefined;
          }
        | undefined;

      if (config.soroswapApiBase && config.soroswapApiKey) {
        try {
          const cleanBase = config.soroswapApiBase.replace(/\/+$/, "");
          const quoteBody = buildSoroswapQuoteBody(
            { fromAsset, toAsset, amount, slippageBps: 50 },
            config.networkPassphrase,
          );
          const authHeaders = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.soroswapApiKey}`,
          };
          const res = await fetchFn(`${cleanBase}/quote?network=${config.network}`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(quoteBody),
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              amountOut?: string | number;
              expectedOutputAmount?: string;
              priceImpactPct?: string;
            };
            const out = parseSoroswapQuoteOutput(data);
            if (out) {
              let unsignedXdr: string | undefined;
              if (defaultClassic) {
                const buildRes = await fetchFn(
                  `${cleanBase}/quote/build?network=${config.network}`,
                  {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({ quote: data, from: defaultClassic.address }),
                    signal: AbortSignal.timeout(8000),
                  },
                ).catch(() => null);
                if (buildRes?.ok) {
                  const built = (await buildRes.json()) as { xdr?: string };
                  unsignedXdr = built.xdr;
                }
              }
              quote = {
                inputAmount: amount,
                expectedOutputAmount: out,
                provider: "soroswap",
                priceImpactPct: data.priceImpactPct ?? "N/A",
                unsignedXdr,
              };
            }
          }
        } catch {
          // Fall through to Horizon Path Payments
        }
      }

      if (!quote) {
        const swapAdapter = createHorizonPathSwapAdapter({
          horizonUrls: config.horizonUrls,
          fetchFn,
        });
        quote = await swapAdapter.getQuote({
          fromAsset,
          toAsset,
          amount,
          slippageBps: 50,
        });
      }

      const { intent } = await createAndSignIntent(config, repo, {
        creatorTelegramUserId: tgId,
        actionType: "swap",
        chatId: String(ctx.chat.id),
        payload: {
          fromAsset,
          toAsset,
          amount: quote.inputAmount,
          expectedOutputAmount: quote.expectedOutputAmount,
          provider: quote.provider,
          priceImpactPct: quote.priceImpactPct,
          unsignedXdr: quote.unsignedXdr,
        },
      });

      const keyboard = appendMiniAppButton(
        new InlineKeyboard(),
        "Review & Sign Swap",
        {
          isPrivateChat: ctx.chat?.type === "private",
          config,
          botUsername: ctx.me?.username,
          intentId: intent.intentId,
          sig: intent.hmacSig,
        },
      );

      const sent = await ctx.reply(
        formatSwapQuoteCard({
          fromAsset,
          toAsset,
          inputAmount: quote.inputAmount,
          expectedOutputAmount: quote.expectedOutputAmount,
          provider: quote.provider,
          priceImpactPct: quote.priceImpactPct,
          network: config.network,
        }),
        { parse_mode: "HTML", reply_markup: keyboard },
      );

      await repo.attachIntentMessageRef(intent.intentId, {
        chatId: String(sent.chat.id),
        messageId: String(sent.message_id),
      });
    } catch (err) {
      await ctx.reply(
        `Swap quote unavailable: ${err instanceof Error ? err.message : "No route found"}`,
      );
    }
  });

  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const parts = query.split(/\s+/).filter(Boolean);
    const verb = (parts[0] ?? "").toLowerCase();
    const tgId = String(ctx.from.id);
    const username = ctx.from.username ? `@${ctx.from.username}` : `User ${tgId}`;

    if (verb === "pay" && parts.length >= 4) {
      const amount = parsePositiveAmount(parts[1] ?? "");
      const assetRes = await resolveCommandAsset(parts[2] ?? "", undefined);
      if (amount && assetRes.ok) {
        const resolved = await resolveRecipient(repo, parts[3] ?? "");
        if (resolved.ok) {
          const now = Math.floor(Date.now() / 1000);
          const payload = {
            amount,
            assetCode: assetRes.assetCode,
            ...(assetRes.assetIssuer ? { assetIssuer: assetRes.assetIssuer } : {}),
            destination: resolved.address,
            recipientLabel: resolved.label,
            senderLabel: username,
          };
          const existing = await repo.findRecentPendingIntent({
            creatorTelegramUserId: tgId,
            actionType: "pay",
            payloadJson: JSON.stringify(payload),
            sinceUnix: now - 60,
          });
          const { intent } = existing
            ? { intent: existing }
            : await createAndSignIntent(config, repo, {
                creatorTelegramUserId: tgId,
                actionType: "pay",
                payload,
              });

          const keyboard = appendMiniAppButton(
            new InlineKeyboard(),
            "Sign in Mini App",
            {
              isPrivateChat: false,
              config,
              botUsername: ctx.me?.username,
              intentId: intent.intentId,
              sig: intent.hmacSig,
            },
          );

          await ctx.answerInlineQuery(
            [
              {
                type: "article",
                id: intent.intentId,
                title: `Send ${amount} ${assetRes.assetCode} to ${resolved.label}`,
                description: `Create a signed ${config.network} payment card`,
                input_message_content: {
                  message_text: formatPaymentIntentCard({
                    status: "pending",
                    amount,
                    assetCode: assetRes.assetCode,
                    senderLabel: username,
                    recipientLabel: resolved.label,
                    network: config.network,
                  }),
                  parse_mode: "HTML",
                },
                reply_markup: keyboard,
              },
            ],
            { cache_time: 0, is_personal: true },
          );
          return;
        }
      }
    }

    const botHandle = ctx.me?.username ? `@${ctx.me.username}` : "the bot";
    await ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: `help_${Date.now()}`,
          title: "Pay via Stellar: pay <amount> <asset> <@user|address>",
          description: "Example: pay 10 XLM @alice",
          input_message_content: {
            message_text: `Use <code>${botHandle} pay 10 XLM @username</code> or /pay inside DM.`,
            parse_mode: "HTML",
          },
        },
      ],
      { cache_time: 0, is_personal: true },
    );
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const inlineMessageId = ctx.chosenInlineResult.inline_message_id;
    const intentId = ctx.chosenInlineResult.result_id;
    if (inlineMessageId && intentId.startsWith("it_")) {
      await repo.attachIntentMessageRef(intentId, { inlineMessageId });
    }
  });

  return bot;
}
