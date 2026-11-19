import {
  DEFAULT_ARGON2ID_PARAMS,
  deriveKeyArgon2id,
  type Argon2idParams,
  type KdfRunOptions,
} from "./crypto.js";
import type { KdfWorkerRequest, KdfWorkerResponse } from "./argon2.worker.js";

let nextJobId = 1;

/**
 * Derives an Argon2id key off the main thread inside a dedicated Web Worker,
 * seamlessly falling back to in-context derivation if Workers are unavailable.
 */
export async function deriveKeyInWorker(
  pinOrPassphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
  options: KdfRunOptions = {},
): Promise<{ keyBytes: Uint8Array<ArrayBuffer>; engine: "wasm" | "noble-js" }> {
  const preferWasm = options.preferWasm ?? true;

  if (typeof Worker === "undefined") {
    return deriveKeyArgon2id(pinOrPassphrase, salt, params, options);
  }

  try {
    const worker = new Worker(new URL("./argon2.worker.js", import.meta.url), {
      type: "module",
    });
    const id = nextJobId;
    nextJobId += 1;

    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.terminate();
      };

      worker.onmessage = (event: MessageEvent<KdfWorkerResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        if (!event.data.ok) {
          reject(new Error(event.data.error));
          return;
        }
        const safeCopy = new Uint8Array(new ArrayBuffer(event.data.keyBytes.byteLength));
        safeCopy.set(event.data.keyBytes);
        resolve({ keyBytes: safeCopy, engine: event.data.engine });
      };

      worker.onerror = () => {
        cleanup();
        deriveKeyArgon2id(pinOrPassphrase, salt, params, options)
          .then(resolve)
          .catch(reject);
      };

      const req: KdfWorkerRequest = {
        id,
        pinOrPassphrase,
        salt,
        params,
        preferWasm,
      };
      worker.postMessage(req);
    });
  } catch {
    return deriveKeyArgon2id(pinOrPassphrase, salt, params, options);
  }
}
