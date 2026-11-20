import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { PwaConfig, TelegramUserBinding } from "@astrowallet/domain";
import { parseStartAppParam, type ParsedStartAppParam } from "@astrowallet/tg-protocol";
import {
  getTelegramWebApp,
  initTelegramMiniApp,
  isInsideTelegramMiniApp,
  shouldAllowMiniAppAccess,
  type TelegramAuthStatus,
} from "../telegram/webapp.js";

export interface TelegramProfileUser {
  id: string;
  username?: string | undefined;
  usernameLower?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  languageCode?: string | undefined;
}

export interface TelegramContextValue {
  inTelegram: boolean;
  allowed: boolean;
  authStatus: TelegramAuthStatus;
  authError: string | null;
  sessionToken: string | null;
  tgUser: TelegramProfileUser | null;
  linkedAccounts: readonly TelegramUserBinding[];
  startParamRoute: ParsedStartAppParam | null;
  refreshTelegramAuth(): Promise<void>;
  refreshLinkedAccounts(): Promise<void>;
}

const TelegramContext = createContext<TelegramContextValue | null>(null);

export function TelegramProvider({
  config,
  children,
}: {
  config: PwaConfig;
  children: ReactNode;
}) {
  const [inTelegram, setInTelegram] = useState<boolean>(() => isInsideTelegramMiniApp());
  const [authStatus, setAuthStatus] = useState<TelegramAuthStatus>(() =>
    isInsideTelegramMiniApp() ? "checking" : "outside",
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [tgUser, setTgUser] = useState<TelegramProfileUser | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<readonly TelegramUserBinding[]>([]);
  const [startParamRoute, setStartParamRoute] = useState<ParsedStartAppParam | null>(null);

  const authenticate = useCallback(async () => {
    const wa = initTelegramMiniApp();
    const inside = Boolean(wa && typeof wa.initData === "string" && wa.initData.trim().length > 0);
    setInTelegram(inside);

    const searchParam =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tgWebAppStartParam") ?? undefined
        : undefined;
    const rawStartParam = wa?.initDataUnsafe?.start_param ?? searchParam;
    if (rawStartParam) {
      setStartParamRoute(parseStartAppParam(rawStartParam));
    }

    if (!inside || !wa) {
      setSessionToken(null);
      setTgUser(null);
      setAuthStatus("outside");
      setAuthError(null);
      return;
    }

    setAuthStatus("checking");
    setAuthError(null);
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/tg/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: wa.initData }),
      });
      const body = (await res.json()) as {
        error?: string;
        sessionToken?: string;
        user?: TelegramProfileUser;
        startParam?: string;
        linkedAccounts?: TelegramUserBinding[];
      };
      if (!res.ok || !body.sessionToken || !body.user) {
        throw new Error(body.error ?? `Telegram Mini App verification failed (${res.status})`);
      }
      setSessionToken(body.sessionToken);
      setTgUser(body.user);
      setLinkedAccounts(Array.isArray(body.linkedAccounts) ? body.linkedAccounts : []);
      if (body.startParam) {
        const parsed = parseStartAppParam(body.startParam);
        if (parsed) setStartParamRoute(parsed);
      }
      setAuthStatus("verified");
    } catch (err) {
      setSessionToken(null);
      setAuthStatus("error");
      setAuthError(
        err instanceof Error ? err.message : "Failed to verify Telegram Mini App session",
      );
    }
  }, [config.apiBaseUrl]);

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  const refreshLinkedAccounts = useCallback(async () => {
    if (!sessionToken) return;
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/tg/me`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { linkedAccounts?: TelegramUserBinding[] };
      if (Array.isArray(body.linkedAccounts)) {
        setLinkedAccounts(body.linkedAccounts);
      }
    } catch {
      // Ignore transient network errors on background profile refresh
    }
  }, [config.apiBaseUrl, sessionToken]);

  const allowed = shouldAllowMiniAppAccess({
    inTelegram,
    allowDevOutsideTelegram: config.allowDevOutsideTelegram,
    authStatus,
  });

  // Expose helper check in dev mode only if needed via getTelegramWebApp
  void getTelegramWebApp;

  return (
    <TelegramContext.Provider
      value={{
        inTelegram,
        allowed,
        authStatus,
        authError,
        sessionToken,
        tgUser,
        linkedAccounts,
        startParamRoute,
        refreshTelegramAuth: authenticate,
        refreshLinkedAccounts,
      }}
    >
      {children}
    </TelegramContext.Provider>
  );
}

export function useTelegram(): TelegramContextValue {
  const ctx = useContext(TelegramContext);
  if (!ctx) {
    throw new Error("useTelegram must be used inside TelegramProvider");
  }
  return ctx;
}
