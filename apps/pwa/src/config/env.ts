import { parsePwaConfig, type PwaConfig } from "@astrowallet/domain";

export type PwaEnvResult =
  | { ok: true; config: PwaConfig }
  | { ok: false; error: string };

export function loadPwaEnv(): PwaEnvResult {
  try {
    const config = parsePwaConfig(import.meta.env as Record<string, unknown>);
    return { ok: true, config };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid PWA environment configuration",
    };
  }
}
