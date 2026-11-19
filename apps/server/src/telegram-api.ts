import type { FetchLike } from "./stellar-verifier.js";

const DEFAULT_TELEGRAM_API_ORIGIN = "https://api.telegram.org";

export interface TelegramMessageTarget {
  chatId?: string | undefined;
  messageId?: string | undefined;
  inlineMessageId?: string | undefined;
}

export interface TelegramApiDeps {
  apiOrigin?: string | undefined;
  fetchFn?: FetchLike | undefined;
}

export async function sendTelegramMessage(
  input: {
    botToken: string;
    chatId: string;
    text: string;
    replyMarkup?: unknown;
  },
  deps: TelegramApiDeps = {},
): Promise<boolean> {
  const origin = (deps.apiOrigin ?? DEFAULT_TELEGRAM_API_ORIGIN).replace(/\/+$/, "");
  const fetchFn = deps.fetchFn ?? fetch;

  const res = await fetchFn(`${origin}/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
      parse_mode: "HTML",
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
    }),
  });
  return res.ok;
}

export async function editTelegramMessage(
  input: {
    botToken: string;
    target: TelegramMessageTarget;
    text: string;
    replyMarkup?: unknown;
  },
  deps: TelegramApiDeps = {},
): Promise<boolean> {
  const origin = (deps.apiOrigin ?? DEFAULT_TELEGRAM_API_ORIGIN).replace(/\/+$/, "");
  const fetchFn = deps.fetchFn ?? fetch;

  const payload: Record<string, unknown> = {
    text: input.text,
    parse_mode: "HTML",
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  };

  if (input.target.inlineMessageId) {
    payload.inline_message_id = input.target.inlineMessageId;
  } else if (input.target.chatId && input.target.messageId) {
    payload.chat_id = input.target.chatId;
    payload.message_id = Number(input.target.messageId);
  } else {
    return false;
  }

  const res = await fetchFn(`${origin}/bot${input.botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok;
}
