import { useEffect } from "react";

export interface TelegramBackButton {
  isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred(type: "error" | "success" | "warning"): void;
  selectionChanged(): void;
}

export interface TelegramBiometricManager {
  isInited?: boolean;
  isBiometricAvailable?: boolean;
  biometricType?: string;
  isAccessRequested?: boolean;
  isAccessGranted?: boolean;
  isBiometricTokenSaved?: boolean;
  init(cb?: () => void): void;
  requestAccess(params: { reason?: string }, cb?: (granted: boolean) => void): void;
  authenticate(
    params: { reason?: string },
    cb?: (ok: boolean, token?: string) => void,
  ): void;
  updateBiometricToken?(token: string, cb?: (updated: boolean) => void): void;
  openSettings?(): void;
}

export interface TelegramDeviceSecureStorage {
  setItem(
    key: string,
    value: string,
    cb?: (err: string | null, stored?: boolean) => void,
  ): void;
  getItem(
    key: string,
    cb?: (err: string | null, value?: string | null) => void,
  ): void;
  removeItem(
    key: string,
    cb?: (err: string | null, removed?: boolean) => void,
  ): void;
}

export interface TelegramSafeAreaInset {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface TelegramWebAppInstance {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id?: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    start_param?: string;
  };
  platform?: string;
  version?: string;
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  isExpanded?: boolean;
  viewportStableHeight?: number;
  safeAreaInset?: TelegramSafeAreaInset;
  contentSafeAreaInset?: TelegramSafeAreaInset;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  openTelegramLink?(url: string): void;
  BackButton?: TelegramBackButton;
  HapticFeedback?: TelegramHapticFeedback;
  BiometricManager?: TelegramBiometricManager;
  SecureStorage?: TelegramDeviceSecureStorage;
}

export type TelegramAuthStatus = "checking" | "verified" | "outside" | "error";

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === "undefined") return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebAppInstance } }).Telegram;
  return tg?.WebApp ?? null;
}

export function isInsideTelegramMiniApp(): boolean {
  const wa = getTelegramWebApp();
  return Boolean(wa && typeof wa.initData === "string" && wa.initData.trim().length > 0);
}

/**
 * Pure access gate check enforcing 100% Telegram-only operation (with Testnet-only local dev flag).
 */
export function shouldAllowMiniAppAccess(input: {
  inTelegram: boolean;
  allowDevOutsideTelegram: boolean;
  authStatus: TelegramAuthStatus;
}): boolean {
  if (!input.inTelegram) {
    return input.allowDevOutsideTelegram;
  }
  return input.authStatus === "verified";
}

export function initTelegramMiniApp(): TelegramWebAppInstance | null {
  const wa = getTelegramWebApp();
  if (!wa) return null;
  try {
    wa.ready();
    wa.expand();
    wa.setHeaderColor?.("#060E24");
    wa.setBackgroundColor?.("#060E24");
    wa.disableVerticalSwipes?.();

    if (typeof document !== "undefined") {
      const topInset =
        (wa.safeAreaInset?.top ?? 0) + (wa.contentSafeAreaInset?.top ?? 0);
      const bottomInset =
        (wa.safeAreaInset?.bottom ?? 0) + (wa.contentSafeAreaInset?.bottom ?? 0);
      if (topInset > 0) {
        document.documentElement.style.setProperty("--tg-safe-area-inset-top", `${topInset}px`);
      }
      if (bottomInset > 0) {
        document.documentElement.style.setProperty(
          "--tg-safe-area-inset-bottom",
          `${bottomInset}px`,
        );
      }
    }
  } catch {
    // Non-fatal in partially mocked WebViews
  }
  return wa;
}

export function triggerTelegramHaptic(
  kind: "success" | "warning" | "error" | "impact" | "selection",
): void {
  const hf = getTelegramWebApp()?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === "selection") {
      hf.selectionChanged();
    } else if (kind === "impact") {
      hf.impactOccurred("medium");
    } else {
      hf.notificationOccurred(kind);
    }
  } catch {
    // Ignore haptic errors
  }
}

export function useTelegramBackButton(visible: boolean, onBack: () => void): void {
  useEffect(() => {
    const bb = getTelegramWebApp()?.BackButton;
    if (!bb) return undefined;
    if (!visible) {
      bb.hide();
      return undefined;
    }
    bb.onClick(onBack);
    bb.show();
    return () => {
      bb.offClick(onBack);
      bb.hide();
    };
  }, [visible, onBack]);
}

export function setTelegramClosingConfirmation(enabled: boolean): void {
  const wa = getTelegramWebApp();
  if (!wa) return;
  try {
    if (enabled) {
      wa.enableClosingConfirmation?.();
    } else {
      wa.disableClosingConfirmation?.();
    }
  } catch {
    // Ignore
  }
}

export function isTelegramBiometricAvailable(): Promise<boolean> {
  const bm = getTelegramWebApp()?.BiometricManager;
  if (!bm) return Promise.resolve(false);
  if (bm.isInited) {
    return Promise.resolve(Boolean(bm.isBiometricAvailable));
  }
  return new Promise((resolve) => {
    try {
      bm.init(() => {
        resolve(Boolean(bm.isBiometricAvailable));
      });
    } catch {
      resolve(false);
    }
  });
}

export function authenticateTelegramBiometric(
  reason: string,
): Promise<{ authenticated: boolean; token?: string | undefined }> {
  const bm = getTelegramWebApp()?.BiometricManager;
  if (!bm) {
    return Promise.resolve({ authenticated: false });
  }
  return new Promise((resolve) => {
    const runAuth = () => {
      const doAuth = () => {
        bm.authenticate({ reason }, (ok, token) => {
          resolve({ authenticated: Boolean(ok), token });
        });
      };
      if (bm.isAccessGranted) {
        doAuth();
        return;
      }
      bm.requestAccess({ reason }, (granted) => {
        if (!granted) {
          resolve({ authenticated: false });
          return;
        }
        doAuth();
      });
    };

    try {
      if (bm.isInited) {
        runAuth();
      } else {
        bm.init(() => runAuth());
      }
    } catch {
      resolve({ authenticated: false });
    }
  });
}

export function updateTelegramBiometricToken(token: string): Promise<boolean> {
  const bm = getTelegramWebApp()?.BiometricManager;
  if (!bm?.updateBiometricToken) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      bm.updateBiometricToken?.(token, (updated) => resolve(Boolean(updated)));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Bot API 9.0 device-local SecureStorage helpers (iOS Keychain / Android Keystore only; never CloudStorage).
 */
export function tgSecureStorageGet(key: string): Promise<string | null> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      store.getItem(key, (err, value) => {
        if (err || typeof value !== "string") {
          resolve(null);
        } else {
          resolve(value);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

export function tgSecureStorageSet(key: string, value: string): Promise<boolean> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      store.setItem(key, value, (err, stored) => resolve(!err && Boolean(stored ?? true)));
    } catch {
      resolve(false);
    }
  });
}

export function tgSecureStorageRemove(key: string): Promise<boolean> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      store.removeItem(key, (err, removed) => resolve(!err && Boolean(removed ?? true)));
    } catch {
      resolve(false);
    }
  });
}
