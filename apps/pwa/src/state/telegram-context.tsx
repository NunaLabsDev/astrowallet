import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EncryptedVaultBackupEnvelopeSchema,
  type EncryptedVaultBackupEnvelope,
  type PwaConfig,
  type TelegramUserBinding,
} from "@astrowallet/domain";
import { parseStartAppParam, type ParsedStartAppParam } from "@astrowallet/tg-protocol";
import {
  initTelegramMiniApp,
  isInsideTelegramMiniApp,
  shouldAllowMiniAppAccess,
  tgCloudStorageGet,
  tgCloudStorageRemove,
  tgCloudStorageSet,
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
  hasEncryptedBackup: boolean;
  backupUpdatedAt: number | null;
  cloudBackupJson: string | null;
  cloudBackupError: string | null;
  checkingCloudBackup: boolean;
  refreshTelegramAuth(): Promise<void>;
  refreshLinkedAccounts(): Promise<void>;
  refreshCloudBackup(): Promise<string | null>;
  uploadEncryptedBackup(envelopeJson: string): Promise<{
    d1Saved: boolean;
    tgCloudSaved: boolean;
    updatedAt: number;
  }>;
  deleteEncryptedBackup(): Promise<void>;
}

const MAX_TG_CLOUD_STORAGE_BYTES = 3900;

function cloudStorageKey(network: string): string {
  return `aw_zk_vault_${network}`;
}

function parseEnvelopeCandidate(raw: string | null): EncryptedVaultBackupEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = EncryptedVaultBackupEnvelopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [tgUser, setTgUser] = useState<TelegramProfileUser | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<readonly TelegramUserBinding[]>([]);
  const [startParamRoute, setStartParamRoute] = useState<ParsedStartAppParam | null>(null);

  const [hasEncryptedBackup, setHasEncryptedBackup] = useState(false);
  const [backupUpdatedAt, setBackupUpdatedAt] = useState<number | null>(null);
  const [cloudBackupJson, setCloudBackupJson] = useState<string | null>(null);
  const [cloudBackupError, setCloudBackupError] = useState<string | null>(null);
  const [checkingCloudBackup, setCheckingCloudBackup] = useState(false);

  const sessionTokenRef = useRef<string | null>(null);
  const sessionExpiresAtRef = useRef<number | null>(null);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const networkRef = useRef(config.network);
  sessionTokenRef.current = sessionToken;
  sessionExpiresAtRef.current = sessionExpiresAt;
  networkRef.current = config.network;

  const refreshSessionToken = useCallback(
    async (tokenOverride?: string | null): Promise<string | null> => {
      const current = tokenOverride ?? sessionTokenRef.current;
      if (!current) return null;
      if (refreshPromiseRef.current) {
        return refreshPromiseRef.current;
      }
      const run = (async () => {
        try {
          const base = config.apiBaseUrl.replace(/\/+$/, "");
          const res = await fetch(`${base}/v1/tg/refresh`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${current}`,
              "X-Astro-Network": networkRef.current,
            },
          });
          if (!res.ok) return current;
          const data = (await res.json()) as {
            sessionToken?: string;
            expiresAt?: number;
          };
          if (data.sessionToken && typeof data.expiresAt === "number") {
            sessionTokenRef.current = data.sessionToken;
            sessionExpiresAtRef.current = data.expiresAt;
            setSessionToken(data.sessionToken);
            setSessionExpiresAt(data.expiresAt);
            return data.sessionToken;
          }
          return current;
        } catch {
          return current;
        } finally {
          refreshPromiseRef.current = null;
        }
      })();
      refreshPromiseRef.current = run;
      return run;
    },
    [config.apiBaseUrl],
  );

  const ensureFreshSessionToken = useCallback(async (): Promise<string | null> => {
    const current = sessionTokenRef.current;
    const exp = sessionExpiresAtRef.current;
    if (!current) return null;
    const now = Math.floor(Date.now() / 1000);
    if (exp && exp - now < 60) {
      return refreshSessionToken(current);
    }
    return current;
  }, [refreshSessionToken]);

  useEffect(() => {
    if (!sessionToken || !sessionExpiresAt || typeof window === "undefined") {
      return undefined;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const delayMs = Math.max(5_000, (sessionExpiresAt - nowSec - 180) * 1000);
    const timer = window.setTimeout(() => {
      void refreshSessionToken(sessionToken);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [sessionToken, sessionExpiresAt, refreshSessionToken]);

  const loadCloudBackupWithToken = useCallback(
    async (
      token: string | null,
      serverHintHasBackup: boolean,
      targetNetwork: string = networkRef.current,
    ): Promise<string | null> => {
      setCheckingCloudBackup(true);
      setCloudBackupError(null);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        type ServerFetchResult =
          | { kind: "found"; envelope: EncryptedVaultBackupEnvelope; updatedAt: number }
          | { kind: "empty" }
          | { kind: "error"; message: string };

        const fetchServer: Promise<ServerFetchResult> =
          token && serverHintHasBackup
            ? fetch(`${base}/v1/tg/vault-backup`, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "X-Astro-Network": targetNetwork,
                },
              })
                .then(async (res): Promise<ServerFetchResult> => {
                  if (!res.ok) {
                    return {
                      kind: "error",
                      message: `Server backup check returned ${res.status}`,
                    };
                  }
                  const data = (await res.json()) as {
                    hasBackup?: boolean;
                    backup?: { envelope?: unknown; updatedAt?: number };
                  };
                  if (!data.hasBackup || !data.backup?.envelope) {
                    return { kind: "empty" };
                  }
                  const valid = EncryptedVaultBackupEnvelopeSchema.safeParse(data.backup.envelope);
                  return valid.success
                    ? {
                        kind: "found",
                        envelope: valid.data,
                        updatedAt: data.backup.updatedAt ?? valid.data.updatedAt,
                      }
                    : { kind: "error", message: "Stored encrypted backup envelope failed validation" };
                })
                .catch(() => ({
                  kind: "error",
                  message: "Network error while loading your Telegram encrypted backup",
                }))
            : Promise.resolve({ kind: "empty" });

        const fetchTgCloud = tgCloudStorageGet(cloudStorageKey(targetNetwork)).then((raw) => {
          const valid = parseEnvelopeCandidate(raw);
          return valid ? { envelope: valid, updatedAt: valid.updatedAt } : null;
        });

        const [serverResult, tgCandidate] = await Promise.all([fetchServer, fetchTgCloud]);
        const serverCandidate = serverResult.kind === "found" ? serverResult : null;
        const winner =
          serverCandidate && tgCandidate
            ? serverCandidate.updatedAt >= tgCandidate.updatedAt
              ? serverCandidate
              : tgCandidate
            : serverCandidate ?? tgCandidate;

        if (!winner) {
          if (serverHintHasBackup && serverResult.kind === "error") {
            setCloudBackupJson(null);
            setHasEncryptedBackup(true);
            setCloudBackupError("Unable to load your Telegram encrypted backup right now. Tap Retry.");
            return null;
          }
          setCloudBackupJson(null);
          setHasEncryptedBackup(false);
          setBackupUpdatedAt(null);
          return null;
        }

        const compact = JSON.stringify(winner.envelope);
        setCloudBackupJson(compact);
        setHasEncryptedBackup(true);
        setBackupUpdatedAt(winner.updatedAt);
        setCloudBackupError(null);
        return compact;
      } finally {
        setCheckingCloudBackup(false);
      }
    },
    [config.apiBaseUrl],
  );

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
      setSessionExpiresAt(null);
      setTgUser(null);
      setAuthStatus("outside");
      setAuthError(null);
      setCloudBackupJson(null);
      setHasEncryptedBackup(false);
      setBackupUpdatedAt(null);
      setCloudBackupError(null);
      return;
    }

    setAuthStatus("checking");
    setAuthError(null);
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/tg/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": networkRef.current,
        },
        body: JSON.stringify({ initData: wa.initData }),
      });
      const body = (await res.json()) as {
        error?: string;
        sessionToken?: string;
        expiresAt?: number;
        user?: TelegramProfileUser;
        startParam?: string;
        linkedAccounts?: TelegramUserBinding[];
        hasEncryptedBackup?: boolean;
        backupUpdatedAt?: number;
      };
      if (!res.ok || !body.sessionToken || !body.user) {
        throw new Error(body.error ?? `Telegram Mini App verification failed (${res.status})`);
      }
      sessionTokenRef.current = body.sessionToken;
      sessionExpiresAtRef.current =
        typeof body.expiresAt === "number" ? body.expiresAt : null;
      setSessionToken(body.sessionToken);
      setSessionExpiresAt(typeof body.expiresAt === "number" ? body.expiresAt : null);
      setTgUser(body.user);
      setLinkedAccounts(Array.isArray(body.linkedAccounts) ? body.linkedAccounts : []);
      setHasEncryptedBackup(Boolean(body.hasEncryptedBackup));
      setBackupUpdatedAt(typeof body.backupUpdatedAt === "number" ? body.backupUpdatedAt : null);
      if (body.startParam) {
        const parsed = parseStartAppParam(body.startParam);
        if (parsed) setStartParamRoute(parsed);
      }
      setAuthStatus("verified");

      void loadCloudBackupWithToken(
        body.sessionToken,
        Boolean(body.hasEncryptedBackup),
      );
    } catch (err) {
      sessionTokenRef.current = null;
      sessionExpiresAtRef.current = null;
      setSessionToken(null);
      setSessionExpiresAt(null);
      setAuthStatus("error");
      setAuthError(
        err instanceof Error ? err.message : "Failed to verify Telegram Mini App session",
      );
    }
  }, [config.apiBaseUrl, loadCloudBackupWithToken]);

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  const refreshLinkedAccounts = useCallback(async () => {
    const activeToken = await ensureFreshSessionToken();
    if (!activeToken) return;
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/tg/me`, {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "X-Astro-Network": networkRef.current,
        },
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        linkedAccounts?: TelegramUserBinding[];
        hasEncryptedBackup?: boolean;
        backupUpdatedAt?: number;
      };
      if (Array.isArray(body.linkedAccounts)) {
        setLinkedAccounts(body.linkedAccounts);
      }
      if (typeof body.hasEncryptedBackup === "boolean") {
        setHasEncryptedBackup(body.hasEncryptedBackup);
      }
      if (typeof body.backupUpdatedAt === "number") {
        setBackupUpdatedAt(body.backupUpdatedAt);
      }
    } catch {
      // Ignore transient network errors on background profile refresh
    }
  }, [config.apiBaseUrl, ensureFreshSessionToken]);

  useEffect(() => {
    if (!sessionToken || authStatus !== "verified") return;
    void refreshLinkedAccounts();
  }, [config.network, sessionToken, authStatus, refreshLinkedAccounts]);

  const refreshCloudBackup = useCallback(async (): Promise<string | null> => {
    const activeToken = await ensureFreshSessionToken();
    return loadCloudBackupWithToken(activeToken, true);
  }, [ensureFreshSessionToken, loadCloudBackupWithToken]);

  const uploadEncryptedBackup = useCallback(
    async (
      envelopeJson: string,
    ): Promise<{ d1Saved: boolean; tgCloudSaved: boolean; updatedAt: number }> => {
      const parsed = EncryptedVaultBackupEnvelopeSchema.parse(JSON.parse(envelopeJson));
      const compact = JSON.stringify(parsed);
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const activeToken = await ensureFreshSessionToken();

      let serverUpdatedAt = parsed.updatedAt;
      const d1Promise = activeToken
        ? fetch(`${base}/v1/tg/vault-backup`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${activeToken}`,
            },
            body: JSON.stringify({ envelope: parsed }),
          })
            .then(async (res) => {
              if (!res.ok) return false;
              const data = (await res.json()) as { ok?: boolean; updatedAt?: number };
              if (typeof data.updatedAt === "number") {
                serverUpdatedAt = data.updatedAt;
              }
              return Boolean(data.ok);
            })
            .catch(() => false)
        : Promise.resolve(false);

      const tgCloudPromise =
        new TextEncoder().encode(compact).byteLength <= MAX_TG_CLOUD_STORAGE_BYTES
          ? tgCloudStorageSet(cloudStorageKey(config.network), compact)
          : Promise.resolve(false);

      const [d1Saved, tgCloudSaved] = await Promise.all([d1Promise, tgCloudPromise]);
      if (!d1Saved && !tgCloudSaved) {
        throw new Error("Unable to sync encrypted vault backup to Telegram or server.");
      }

      setCloudBackupJson(compact);
      setHasEncryptedBackup(true);
      setBackupUpdatedAt(serverUpdatedAt);
      setCloudBackupError(null);
      return { d1Saved, tgCloudSaved, updatedAt: serverUpdatedAt };
    },
    [config.apiBaseUrl, config.network, ensureFreshSessionToken],
  );

  const deleteEncryptedBackup = useCallback(async () => {
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    const activeToken = await ensureFreshSessionToken();
    if (activeToken) {
      const res = await fetch(`${base}/v1/tg/vault-backup`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `Failed to delete server cloud backup (${res.status})`);
      }
    }
    await tgCloudStorageRemove(cloudStorageKey(config.network));
    setCloudBackupJson(null);
    setHasEncryptedBackup(false);
    setBackupUpdatedAt(null);
    setCloudBackupError(null);
  }, [config.apiBaseUrl, config.network, ensureFreshSessionToken]);

  const allowed = shouldAllowMiniAppAccess({
    inTelegram,
    allowDevOutsideTelegram: config.allowDevOutsideTelegram,
    authStatus,
  });

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
        hasEncryptedBackup,
        backupUpdatedAt,
        cloudBackupJson,
        cloudBackupError,
        checkingCloudBackup,
        refreshTelegramAuth: authenticate,
        refreshLinkedAccounts,
        refreshCloudBackup,
        uploadEncryptedBackup,
        deleteEncryptedBackup,
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
