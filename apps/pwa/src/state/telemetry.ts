import type { StellarNetwork } from "@astrowallet/domain";

export type TelemetryEventType =
  | "app_open"
  | "wallet_created"
  | "wallet_imported"
  | "wallet_linked"
  | "tx_sent"
  | "swap_executed"
  | "trustline_added"
  | "token_inspected"
  | "nft_viewed"
  | "stats_viewed";

export function detectTelegramPlatform(): string {
  const tg = (
    window as {
      Telegram?: { WebApp?: { platform?: string } };
    }
  ).Telegram?.WebApp;
  return tg?.platform?.trim() || "web";
}

export function detectUserLanguage(): string {
  const tgLang = (
    window as {
      Telegram?: { WebApp?: { initDataUnsafe?: { user?: { language_code?: string } } } };
    }
  ).Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  return tgLang?.trim() || navigator.language?.slice(0, 8) || "en";
}

export function reportTelemetryEvent(input: {
  apiBaseUrl?: string | undefined;
  network: StellarNetwork;
  sessionToken?: string | null | undefined;
  eventType: TelemetryEventType;
  txHash?: string | undefined;
  assetCode?: string | undefined;
  amountEst?: string | undefined;
}): void {
  if (!input.apiBaseUrl) return;
  const base = input.apiBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Astro-Network": input.network,
  };
  if (input.sessionToken) {
    headers.Authorization = `Bearer ${input.sessionToken}`;
  }

  void fetch(`${base}/v1/metrics/event`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventType: input.eventType,
      platform: detectTelegramPlatform(),
      lang: detectUserLanguage(),
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.assetCode ? { assetCode: input.assetCode } : {}),
      ...(input.amountEst ? { amountEst: input.amountEst } : {}),
    }),
  }).catch(() => undefined);
}
