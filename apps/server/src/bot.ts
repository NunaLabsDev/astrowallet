import { createHorizonPathSwapAdapter } from "@astrowallet/defi";
import {
  StellarAddressSchema,
  type IntentActionType,
  type ServerConfig,
  type SignedIntent,
} from "@astrowallet/domain";
import { createSecurityShield } from "@astrowallet/security-shield";
import {
  buildIntentDeepLink,
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
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function createAndSignIntent(
  config: ServerConfig,
  repo: ServerRepository,
  input: {
    creatorTelegramUserId: string;
    actionType: IntentActionType;
    payload: Record<string, unknown>;
    chatId?: string | undefined;
    ttlSeconds?: number | undefined;
  },
): Promise<{ intent: SignedIntent; deepLink: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.ttlSeconds ?? 300);
  const intentId = generateId("it");
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
  const deepLink = buildIntentDeepLink(config.pwaOrigin, intentId, hmacSig);
  return { intent, deepLink };
}

function buildPwaAppUrl(pwaOrigin: string): string {
  return `${pwaOrigin.replace(/\/+$/, "")}/app`;
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
 * Creates a Telegram Super-Bot instance backed by D1 + HMAC-signed Intent links.
 * Strictly Bot-only + Inline Mode (zero Mini App WebView, zero TON dependency, zero private keys).
 */
export function createTelegramBot(
  config: ServerConfig,
  repo: ServerRepository,
  deps: BotDependencies = {},
): Bot {
  const bot = new Bot(config.tgBotToken);
  const networkBadge = config.network.toUpperCase();
  const fetchFn = deps.fetchFn ?? fetch;

  bot.command("start", async (ctx) => {
    const keyboard = new InlineKeyboard().url(
      "Open AstroWallet App",
      buildPwaAppUrl(config.pwaOrigin),
    );

    await ctx.reply(
      [
        `<b>AstroWallet [${networkBadge}]</b>`,
        "Non-custodial Stellar &amp; Soroban Super-Bot.",
        "",
        "• /connect — Link your SEP-0005 accounts",
        "• /accounts — Switch default receiving account",
        "• /balance — Live balances across linked accounts",
        "• /pay &lt;amount&gt; &lt;asset&gt; &lt;@user|address&gt; [memo]",
        "• /request &lt;amount&gt; &lt;asset&gt; [note]",
        "• /split &lt;amount&gt; &lt;asset&gt; &lt;count&gt;",
        "• /scan &lt;address|xdr&gt; — Pre-sign Scan &amp; Shield analyzer",
        "• /swap &lt;amount&gt; &lt;from&gt; &lt;to&gt; — Soroswap / Path quote",
        "• /reserve — Classic XLM reserve &amp; LumenWipe reclaimer",
        "• /alerts [on|off] — Toggle real-time payment alerts",
        "• /help — Full command guide",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.command("help", async (ctx) => {
    const botHandle = ctx.me?.username ? `@${ctx.me.username}` : "the bot";
    await ctx.reply(
      [
        `<b>AstroWallet [${networkBadge}] Help</b>`,
        "Your SEP-0005 seed phrase never leaves your phone. Sign intents in the PWA with your PIN or Fingerprint.",
        "",
        "<b>Commands:</b>",
        "/connect, /accounts, /balance, /pay, /request, /split, /scan, /swap, /reserve, /alerts",
        `<b>Inline Mode:</b> Type <code>${botHandle} pay 10 XLM @friend</code> in any chat.`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("connect", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const tgId = String(from.id);
    const usernameLower = from.username?.toLowerCase();
    await repo.upsertTelegramUser({ telegramUserId: tgId, usernameLower });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const challenge: ConnectChallengePayload = {
      challengeId: generateId("ch"),
      network: config.network,
      telegramUserId: tgId,
      usernameLower,
      issuedAt: now,
      expiresAt,
    };

    const { deepLink } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "connect",
      chatId: String(ctx.chat.id),
      payload: {
        challenge,
        message: formatConnectChallengeMessage(challenge),
      },
    });

    const keyboard = new InlineKeyboard().url(
      "Link Wallet (PIN / Fingerprint)",
      deepLink,
    );

    await ctx.reply(formatConnectPrompt(config.network, 5), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.command("accounts", async (ctx) => {
    if (!ctx.from) return;
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
    const assetCode = parseAssetCode(args[1] ?? "");
    if (!amount || !assetCode) {
      await ctx.reply("Invalid amount or asset code (example: <code>/pay 10 XLM @alice</code>)", {
        parse_mode: "HTML",
      });
      return;
    }

    const rawRecipient = (args[2] ?? "").trim();
    const resolved = await resolveRecipient(repo, rawRecipient);
    if (!resolved.ok) {
      // Viral Telegram Claim Link flow when recipient is an unregistered @username
      if (rawRecipient.startsWith("@") && /^@[A-Za-z0-9_]{5,32}$/.test(rawRecipient)) {
        const recipientHandle = rawRecipient.slice(1).toLowerCase();
        const { intent, deepLink } = await createAndSignIntent(config, repo, {
          creatorTelegramUserId: tgId,
          actionType: "claim",
          chatId: String(ctx.chat.id),
          ttlSeconds: 86_400 * 7,
          payload: {
            amount,
            assetCode,
            recipientUsername: recipientHandle,
            senderLabel: username,
          },
        });

        const keyboard = new InlineKeyboard().url(
          `Fund & Claim ${amount} ${assetCode}`,
          deepLink,
        );
        const sent = await ctx.reply(
          formatClaimLinkCard({
            status: "open",
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
    const { intent, deepLink } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "pay",
      chatId: String(ctx.chat.id),
      payload: {
        amount,
        assetCode,
        destination: resolved.address,
        recipientLabel: resolved.label,
        senderLabel: username,
        memo,
      },
    });

    const keyboard = new InlineKeyboard().url(
      "Sign with PIN / Fingerprint",
      deepLink,
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
    const assetCode = parseAssetCode(args[1] ?? "");
    if (!amount || !assetCode) {
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

    const memo = args.length > 2 ? args.slice(2).join(" ").slice(0, 28) : undefined;
    const { intent, deepLink } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "request",
      chatId: String(ctx.chat.id),
      payload: {
        amount,
        assetCode,
        destination: targetAcc.address,
        recipientLabel: username,
        senderLabel: "Any Payer",
        memo,
      },
    });

    const keyboard = new InlineKeyboard().url("Pay with PIN / Fingerprint", deepLink);
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
    const assetCode = parseAssetCode(args[1] ?? "");
    const count = Number(args[2]);
    if (!totalAmount || !assetCode || !Number.isInteger(count) || count < 2 || count > 50) {
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

    const share = (Number(totalAmount) / count).toFixed(2);
    const { intent, deepLink } = await createAndSignIntent(config, repo, {
      creatorTelegramUserId: tgId,
      actionType: "split",
      chatId: String(ctx.chat.id),
      payload: {
        amount: share,
        totalAmount,
        participantCount: count,
        assetCode,
        destination: targetAcc.address,
        recipientLabel: username,
        senderLabel: "Group Member",
      },
    });

    const keyboard = new InlineKeyboard().url(
      `Pay Share (${share} ${assetCode})`,
      deepLink,
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
      const { deepLink } = await createAndSignIntent(config, repo, {
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
      keyboard.url(
        `Reclaim +${reclaimCandidate.summary.reclaimableXlm} XLM in PWA`,
        deepLink,
      );
    } else {
      keyboard.url("Open AstroWallet App", buildPwaAppUrl(config.pwaOrigin));
    }

    await ctx.reply(
      formatReserveReportCard({ entries, network: config.network }),
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.command("scan", async (ctx) => {
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
      sep42AssetListUrls: [],
      directoryLookup: (addr) => lookupDirectoryTag(config, undefined, addr, fetchFn),
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
    const fromAsset = (args[1] ?? "").trim();
    const toAsset = (args[2] ?? "").trim();
    if (!amount || !fromAsset || !toAsset) {
      await ctx.reply("Invalid swap parameters.", { parse_mode: "HTML" });
      return;
    }

    try {
      const swapAdapter = createHorizonPathSwapAdapter({
        horizonUrls: config.horizonUrls,
        fetchFn,
      });
      const quote = await swapAdapter.getQuote({
        fromAsset,
        toAsset,
        amount,
        slippageBps: 50,
      });

      const { deepLink } = await createAndSignIntent(config, repo, {
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

      const keyboard = new InlineKeyboard().url(
        "Review & Sign Swap (PIN / Fingerprint)",
        deepLink,
      );

      await ctx.reply(
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
      const assetCode = parseAssetCode(parts[2] ?? "");
      if (amount && assetCode) {
        const resolved = await resolveRecipient(repo, parts[3] ?? "");
        if (resolved.ok) {
          const { intent, deepLink } = await createAndSignIntent(config, repo, {
            creatorTelegramUserId: tgId,
            actionType: "pay",
            payload: {
              amount,
              assetCode,
              destination: resolved.address,
              recipientLabel: resolved.label,
              senderLabel: username,
            },
          });

          const keyboard = new InlineKeyboard().url(
            "Sign with PIN / Fingerprint",
            deepLink,
          );

          await ctx.answerInlineQuery(
            [
              {
                type: "article",
                id: intent.intentId,
                title: `Send ${amount} ${assetCode} to ${resolved.label}`,
                description: `Create a signed ${config.network} payment card`,
                input_message_content: {
                  message_text: formatPaymentIntentCard({
                    status: "pending",
                    amount,
                    assetCode,
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
