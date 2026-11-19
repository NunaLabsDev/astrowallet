import {
  deriveKeyArgon2id,
  type Argon2idParams,
} from "./crypto.js";

export interface KdfWorkerRequest {
  id: number;
  pinOrPassphrase: string;
  salt: Uint8Array;
  params: Argon2idParams;
  preferWasm: boolean;
}

export type KdfWorkerResponse =
  | { id: number; ok: true; keyBytes: Uint8Array; engine: "wasm" | "noble-js" }
  | { id: number; ok: false; error: string };

interface WorkerSelfScope {
  onmessage: ((event: MessageEvent<KdfWorkerRequest>) => void) | null;
  postMessage(message: KdfWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerSelfScope;

scope.onmessage = async (event: MessageEvent<KdfWorkerRequest>) => {
  const { id, pinOrPassphrase, salt, params, preferWasm } = event.data;
  try {
    const result = await deriveKeyArgon2id(pinOrPassphrase, salt, params, {
      preferWasm,
    });
    const copy = new Uint8Array(result.keyBytes);
    result.keyBytes.fill(0);
    scope.postMessage(
      { id, ok: true, keyBytes: copy, engine: result.engine },
      [copy.buffer],
    );
  } catch (err) {
    scope.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : "Argon2id worker error",
    });
  }
};
