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

export interface TelegramCloudStorage {
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
  DeviceStorage?: TelegramDeviceSecureStorage;
  CloudStorage?: TelegramCloudStorage;
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
      const leftInset =
        (wa.safeAreaInset?.left ?? 0) + (wa.contentSafeAreaInset?.left ?? 0);
      const rightInset =
        (wa.safeAreaInset?.right ?? 0) + (wa.contentSafeAreaInset?.right ?? 0);
      if (topInset > 0) {
        document.documentElement.style.setProperty("--tg-safe-area-inset-top", `${topInset}px`);
      }
      if (bottomInset > 0) {
        document.documentElement.style.setProperty(
          "--tg-safe-area-inset-bottom",
          `${bottomInset}px`,
        );
      }
      if (leftInset > 0) {
        document.documentElement.style.setProperty("--tg-safe-area-inset-left", `${leftInset}px`);
      }
      if (rightInset > 0) {
        document.documentElement.style.setProperty(
          "--tg-safe-area-inset-right",
          `${rightInset}px`,
        );
      }
      if (
        typeof wa.viewportStableHeight === "number" &&
        Number.isFinite(wa.viewportStableHeight) &&
        wa.viewportStableHeight > 0
      ) {
        document.documentElement.style.setProperty(
          "--tg-viewport-stable-height",
          `${Math.round(wa.viewportStableHeight)}px`,
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

/**
 * Copies text to clipboard with safe execCommand fallback for restricted Telegram WebViews.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
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

const DEVICE_STORAGE_TIMEOUT_MS = 1500;

/**
 * Bot API 9.0 device-local SecureStorage helpers (iOS Keychain / Android Keystore only; never CloudStorage).
 */
export function tgSecureStorageGet(key: string): Promise<string | null> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.getItem(key, (err, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (err || typeof value !== "string") {
          resolve(null);
        } else {
          resolve(value);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

export function tgSecureStorageSet(key: string, value: string): Promise<boolean> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.setItem(key, value, (err, stored) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(stored ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

export function tgSecureStorageRemove(key: string): Promise<boolean> {
  const store = getTelegramWebApp()?.SecureStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.removeItem(key, (err, removed) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(removed ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/**
 * Bot API 9.0 non-sensitive DeviceStorage helpers (~5MB per bot) with localStorage fallback
 * for fast client-side market & metadata SWR caching.
 */
export function tgDeviceStorageGet(key: string): Promise<string | null> {
  const store = getTelegramWebApp()?.DeviceStorage;
  if (!store) {
    try {
      return Promise.resolve(
        typeof window !== "undefined" ? window.localStorage.getItem(key) : null,
      );
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          resolve(typeof window !== "undefined" ? window.localStorage.getItem(key) : null);
        } catch {
          resolve(null);
        }
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.getItem(key, (err, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (!err && typeof value === "string") {
          resolve(value);
          return;
        }
        try {
          resolve(typeof window !== "undefined" ? window.localStorage.getItem(key) : null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

export function tgDeviceStorageSet(key: string, value: string): Promise<boolean> {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignore localStorage quota errors
  }
  const store = getTelegramWebApp()?.DeviceStorage;
  if (!store) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.setItem(key, value, (err, stored) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(stored ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

export function tgDeviceStorageRemove(key: string): Promise<boolean> {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors
  }
  const store = getTelegramWebApp()?.DeviceStorage;
  if (!store) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, DEVICE_STORAGE_TIMEOUT_MS);
    try {
      store.removeItem(key, (err, removed) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(removed ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

const CLOUD_STORAGE_TIMEOUT_MS = 2500;

/**
 * Telegram CloudStorage wrappers used ONLY for Zero-Knowledge AGVAULT ciphertext envelopes
 * (never plaintext mnemonics, private keys, PINs, or passwords).
 */
export function tgCloudStorageGet(key: string): Promise<string | null> {
  const store = getTelegramWebApp()?.CloudStorage;
  if (!store) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, CLOUD_STORAGE_TIMEOUT_MS);
    try {
      store.getItem(key, (err, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (err || typeof value !== "string" || value.trim().length === 0) {
          resolve(null);
        } else {
          resolve(value);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

export function tgCloudStorageSet(key: string, value: string): Promise<boolean> {
  const store = getTelegramWebApp()?.CloudStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, CLOUD_STORAGE_TIMEOUT_MS);
    try {
      store.setItem(key, value, (err, stored) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(stored ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

export function tgCloudStorageRemove(key: string): Promise<boolean> {
  const store = getTelegramWebApp()?.CloudStorage;
  if (!store) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, CLOUD_STORAGE_TIMEOUT_MS);
    try {
      store.removeItem(key, (err, removed) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(!err && Boolean(removed ?? true));
      });
    } catch {
      if (!settled) {
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(false);
      }
    }
  });
}
