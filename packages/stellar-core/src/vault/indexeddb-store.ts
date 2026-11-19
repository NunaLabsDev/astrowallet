import type { EncryptedVaultEnvelope } from "./crypto.js";

const DB_NAME = "astrowallet_vault_v1";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const PRIMARY_VAULT_KEY = "primary_vault";
const BIOMETRIC_WRAP_KEY = "biometric_wrap";

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

export async function saveEncryptedVault(envelope: EncryptedVaultEnvelope): Promise<void> {
  await idbPut(PRIMARY_VAULT_KEY, envelope);
}

export async function loadEncryptedVault(): Promise<EncryptedVaultEnvelope | null> {
  return idbGet<EncryptedVaultEnvelope>(PRIMARY_VAULT_KEY);
}

export async function hasEncryptedVault(): Promise<boolean> {
  const vault = await loadEncryptedVault();
  return vault !== null;
}

export async function deleteEncryptedVault(): Promise<void> {
  await idbDelete(PRIMARY_VAULT_KEY);
  await idbDelete(BIOMETRIC_WRAP_KEY);
}

export async function saveBiometricRecord(record: BiometricWrapRecord): Promise<void> {
  await idbPut(BIOMETRIC_WRAP_KEY, record);
}

export async function loadBiometricRecord(): Promise<BiometricWrapRecord | null> {
  return idbGet<BiometricWrapRecord>(BIOMETRIC_WRAP_KEY);
}

export async function clearBiometricRecord(): Promise<void> {
  await idbDelete(BIOMETRIC_WRAP_KEY);
}
