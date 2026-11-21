import type { EncryptedVaultEnvelope } from "./crypto.js";

const DB_NAME = "astrowallet_vault_v1";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const PRIMARY_VAULT_KEY = "primary_vault";
const LEGACY_VAULT_CLAIMED_BY_KEY = "legacy_vault_claimed_by";
const BIOMETRIC_WRAP_KEY = "biometric_wrap";
const CONTACTS_KEY = "contacts_v1";
const PIN_LOCKOUT_KEY = "pin_lockout_v1";

function scopedKey(base: string, scopeId?: string): string {
  const clean = scopeId?.trim();
  return clean ? `${base}:${clean}` : base;
}

const MAX_PIN_ATTEMPTS_BEFORE_LOCK = 5;
const BASE_PIN_LOCKOUT_MS = 30_000;
const MAX_PIN_LOCKOUT_MS = 15 * 60_000;

export interface PinLockoutState {
  failedAttempts: number;
  lockedUntilMs: number;
}

export interface ContactEntry {
  id: string;
  label: string;
  address: string;
  defaultMemo?: string | undefined;
  createdAt: number;
}

export interface BiometricWrapRecord {
  credentialIdB64: string;
  prfSaltB64: string;
  ivB64: string;
  wrappedPinCiphertextB64: string;
  createdAt: number;
}

function openVaultDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is required for non-custodial vault storage"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB vault"));
  });
}

async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // Best-effort storage persistence
  }
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openVaultDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read error"));
    });
  } finally {
    db.close();
  }
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  await requestPersistentStorage();
  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write error"));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete error"));
    });
  } finally {
    db.close();
  }
}

export async function saveEncryptedVault(
  envelope: EncryptedVaultEnvelope,
  scopeId?: string,
): Promise<void> {
  await idbPut(scopedKey(PRIMARY_VAULT_KEY, scopeId), envelope);
}

export async function loadEncryptedVault(
  scopeId?: string,
): Promise<EncryptedVaultEnvelope | null> {
  const key = scopedKey(PRIMARY_VAULT_KEY, scopeId);
  const existing = await idbGet<EncryptedVaultEnvelope>(key);
  if (existing || !scopeId?.trim()) {
    return existing;
  }
  // One-time safe migration for single-user vaults created before Telegram ID scoping
  const legacy = await idbGet<EncryptedVaultEnvelope>(PRIMARY_VAULT_KEY);
  const claimedBy = await idbGet<string>(LEGACY_VAULT_CLAIMED_BY_KEY);
  if (legacy && (!claimedBy || claimedBy === scopeId.trim())) {
    await idbPut(key, legacy);
    await idbPut(LEGACY_VAULT_CLAIMED_BY_KEY, scopeId.trim());
    return legacy;
  }
  return null;
}

export async function hasEncryptedVault(scopeId?: string): Promise<boolean> {
  const vault = await loadEncryptedVault(scopeId);
  return vault !== null;
}

export async function deleteEncryptedVault(scopeId?: string): Promise<void> {
  await idbDelete(scopedKey(PRIMARY_VAULT_KEY, scopeId));
  await idbDelete(scopedKey(BIOMETRIC_WRAP_KEY, scopeId));
  await idbDelete(scopedKey(PIN_LOCKOUT_KEY, scopeId));
  if (!scopeId?.trim()) {
    await idbDelete(LEGACY_VAULT_CLAIMED_BY_KEY);
  }
}

export async function saveBiometricRecord(
  record: BiometricWrapRecord,
  scopeId?: string,
): Promise<void> {
  await idbPut(scopedKey(BIOMETRIC_WRAP_KEY, scopeId), record);
}

export async function loadBiometricRecord(scopeId?: string): Promise<BiometricWrapRecord | null> {
  return idbGet<BiometricWrapRecord>(scopedKey(BIOMETRIC_WRAP_KEY, scopeId));
}

export async function clearBiometricRecord(scopeId?: string): Promise<void> {
  await idbDelete(scopedKey(BIOMETRIC_WRAP_KEY, scopeId));
}

export async function loadContacts(scopeId?: string): Promise<ContactEntry[]> {
  const list = await idbGet<ContactEntry[]>(scopedKey(CONTACTS_KEY, scopeId));
  return Array.isArray(list) ? list : [];
}

export async function saveContacts(
  contacts: readonly ContactEntry[],
  scopeId?: string,
): Promise<void> {
  await idbPut(scopedKey(CONTACTS_KEY, scopeId), [...contacts]);
}

export async function getPinLockoutState(scopeId?: string): Promise<PinLockoutState> {
  try {
    const state = await idbGet<PinLockoutState>(scopedKey(PIN_LOCKOUT_KEY, scopeId));
    if (
      state &&
      typeof state.failedAttempts === "number" &&
      Number.isFinite(state.failedAttempts) &&
      typeof state.lockedUntilMs === "number" &&
      Number.isFinite(state.lockedUntilMs)
    ) {
      return state;
    }
  } catch {
    // Non-IndexedDB test or fallback environments
  }
  return { failedAttempts: 0, lockedUntilMs: 0 };
}

export async function recordFailedPinAttempt(
  nowMs: number = Date.now(),
  scopeId?: string,
): Promise<PinLockoutState> {
  const prev = await getPinLockoutState(scopeId);
  const failedAttempts = prev.failedAttempts + 1;
  let lockedUntilMs = prev.lockedUntilMs;
  if (failedAttempts >= MAX_PIN_ATTEMPTS_BEFORE_LOCK) {
    const exponent = failedAttempts - MAX_PIN_ATTEMPTS_BEFORE_LOCK;
    const backoff = Math.min(BASE_PIN_LOCKOUT_MS * 2 ** exponent, MAX_PIN_LOCKOUT_MS);
    lockedUntilMs = Math.max(prev.lockedUntilMs, nowMs + backoff);
  }
  const next: PinLockoutState = { failedAttempts, lockedUntilMs };
  try {
    await idbPut(scopedKey(PIN_LOCKOUT_KEY, scopeId), next);
  } catch {
    // Ignore IDB errors in restricted contexts while returning computed state
  }
  return next;
}

export async function clearPinLockoutState(scopeId?: string): Promise<void> {
  try {
    await idbDelete(scopedKey(PIN_LOCKOUT_KEY, scopeId));
  } catch {
    // Ignore when IDB is unavailable
  }
}
