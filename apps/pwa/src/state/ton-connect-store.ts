import type { TonNetwork } from "@astrowallet/domain";
import type { TonWalletVersion } from "@astrowallet/ton-core";

const TC_DB_NAME = "astrowallet_ton_connect_v1";
const TC_DB_VERSION = 1;
const TC_STORE_NAME = "ton_connect_sessions";

export interface StoredTonConnectSession {
  scopeId?: string | undefined;
  walletClientId: string;
  walletSecretHex: string;
  dappClientId: string;
  dappName: string;
  dappUrl: string;
  manifestUrl: string;
  network: TonNetwork;
  connectedAddress: string;
  derivationIndex?: number | undefined;
  walletVersion?: TonWalletVersion | undefined;
  createdAt: number;
  lastEventId?: string | undefined;
}

function openTonConnectDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TC_DB_NAME, TC_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TC_STORE_NAME)) {
        db.createObjectStore(TC_STORE_NAME, { keyPath: "walletClientId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open TON Connect store"));
  });
}

export async function loadTonConnectSessions(
  scopeId?: string,
): Promise<StoredTonConnectSession[]> {
  try {
    const db = await openTonConnectDb();
    try {
      const all = await new Promise<StoredTonConnectSession[]>((resolve, reject) => {
        const tx = db.transaction(TC_STORE_NAME, "readonly");
        const store = tx.objectStore(TC_STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () =>
          resolve(Array.isArray(req.result) ? (req.result as StoredTonConnectSession[]) : []);
        req.onerror = () => reject(req.error ?? new Error("Failed to read TON Connect sessions"));
      });
      const cleanScope = scopeId?.trim();
      return all.filter((s) => (cleanScope ? s.scopeId === cleanScope : !s.scopeId));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function saveTonConnectSession(session: StoredTonConnectSession): Promise<void> {
  const db = await openTonConnectDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TC_STORE_NAME, "readwrite");
      tx.objectStore(TC_STORE_NAME).put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save TON Connect session"));
    });
  } finally {
    db.close();
  }
}

export async function removeTonConnectSession(walletClientId: string): Promise<void> {
  const db = await openTonConnectDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TC_STORE_NAME, "readwrite");
      tx.objectStore(TC_STORE_NAME).delete(walletClientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete TON Connect session"));
    });
  } finally {
    db.close();
  }
}

export async function clearAllTonConnectSessions(scopeId?: string): Promise<void> {
  try {
    const cleanScope = scopeId?.trim();
    if (cleanScope) {
      const scoped = await loadTonConnectSessions(cleanScope);
      await Promise.all(scoped.map((s) => removeTonConnectSession(s.walletClientId)));
      return;
    }
    const db = await openTonConnectDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(TC_STORE_NAME, "readwrite");
        tx.objectStore(TC_STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Failed to clear TON Connect sessions"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Ignore when IndexedDB unavailable
  }
}
