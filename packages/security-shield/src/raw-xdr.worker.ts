import { decodeTransactionEnvelope } from "./decoder.js";

export interface RawXdrInspectRequest {
  id: number;
  xdrBase64: string;
  networkPassphrase: string;
}

export type RawXdrInspectResponse =
  | { id: number; ok: true; jsonPretty: string }
  | { id: number; ok: false; error: string };

interface WorkerSelfScope {
  onmessage: ((event: MessageEvent<RawXdrInspectRequest>) => void) | null;
  postMessage(message: RawXdrInspectResponse): void;
}

const scope = globalThis as unknown as WorkerSelfScope;

scope.onmessage = (event: MessageEvent<RawXdrInspectRequest>) => {
  const { id, xdrBase64, networkPassphrase } = event.data;
  try {
    const decoded = decodeTransactionEnvelope(xdrBase64, networkPassphrase);
    scope.postMessage({
      id,
      ok: true,
      jsonPretty: JSON.stringify(decoded, null, 2),
    });
  } catch (err) {
    scope.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : "Failed to decode XDR",
    });
  }
};
