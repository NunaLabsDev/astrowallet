import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

function collectConfiguredConnectOrigins(env: Record<string, string | undefined>): string[] {
  const origins = new Set<string>();
  const urlKeys = [
    "VITE_API_BASE_URL",
    "VITE_STELLAR_RPC_URLS",
    "VITE_HORIZON_URLS",
    "VITE_FRIENDBOT_URL",
    "VITE_SEP42_ASSET_LIST_URLS",
    "VITE_TON_RPC_URLS",
    "VITE_TON_BRIDGE_URL",
    "VITE_NEAR_INTENTS_API_BASE",
    "VITE_CCTP_BRIDGE_URL",
    "VITE_ASTRODEX_API_BASE_URL",
    "VITE_ALT_ASTRODEX_API_BASE_URL",
    "VITE_ALT_STELLAR_RPC_URLS",
    "VITE_ALT_HORIZON_URLS",
    "VITE_ALT_TON_RPC_URLS",
    "VITE_ALT_FRIENDBOT_URL",
    "VITE_ALT_SEP42_ASSET_LIST_URLS",
  ];
  for (const key of urlKeys) {
    const raw = env[key];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        origins.add(new URL(trimmed).origin);
      } catch {
        // Skip invalid entries cleanly
      }
    }
  }
  return Array.from(origins).sort();
}

function cspConnectSrcPlugin(env: Record<string, string | undefined>): Plugin {
  return {
    name: "astrowallet-csp-connect-src",
    closeBundle() {
      const configuredOrigins = collectConfiguredConnectOrigins(env);
      if (configuredOrigins.length === 0) return;
      const distHeaders = path.resolve(process.cwd(), "dist/_headers");
      if (!existsSync(distHeaders)) return;
      const raw = readFileSync(distHeaders, "utf8");
      const updated = raw.replace(/connect-src\s+'self'([^;]*);/, (_match, existing: string) => {
        const merged = new Set(
          existing
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .concat(configuredOrigins),
        );
        return `connect-src 'self' ${Array.from(merged).join(" ")};`;
      });
      writeFileSync(distHeaders, updated, "utf8");
    },
  };
}

function loadFallbackEnvExample(dir: string): Record<string, string> {
  const examplePath = path.resolve(dir, ".env.example");
  if (!existsSync(examplePath)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(examplePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key.startsWith("VITE_") && val !== "") {
      out[key] = val;
    }
  }
  return out;
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "VITE_");
  const hasExplicitNetwork = Boolean(
    fileEnv.VITE_STELLAR_NETWORK?.trim() || process.env.VITE_STELLAR_NETWORK?.trim(),
  );
  const exampleEnv = hasExplicitNetwork ? {} : loadFallbackEnvExample(process.cwd());
  if (!hasExplicitNetwork) {
    for (const [k, v] of Object.entries(exampleEnv)) {
      if (process.env[k] === undefined && fileEnv[k] === undefined) {
        process.env[k] = v;
      }
    }
  }
  const combinedEnv: Record<string, string | undefined> = {
    ...exampleEnv,
    ...fileEnv,
    ...process.env,
  };
  if (combinedEnv.VITE_STELLAR_NETWORK?.trim() === "mainnet") {
    if (combinedEnv.VITE_FRIENDBOT_URL?.trim()) {
      throw new Error("Mainnet build aborted: VITE_FRIENDBOT_URL must be empty on mainnet");
    }
    if (combinedEnv.VITE_ALLOW_DEV_OUTSIDE_TELEGRAM?.trim().toLowerCase() === "true") {
      throw new Error(
        "Mainnet build aborted: VITE_ALLOW_DEV_OUTSIDE_TELEGRAM cannot be true on mainnet",
      );
    }
  }
  return {
    plugins: [react(), cspConnectSrcPlugin(combinedEnv)],
    worker: {
      format: "es",
    },
    build: {
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("preload-helper")) {
              return "vite-preload";
            }
            if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
              return "vendor-react";
            }
            if (id.includes("@stellar/") || id.includes("stellar-base") || id.includes("js-xdr")) {
              return "vendor-stellar";
            }
            if (id.includes("@ton/") || id.includes("tweetnacl")) {
              return "vendor-ton";
            }
            if (id.includes("@noble/") || id.includes("@scure/") || id.includes("hash-wasm")) {
              return "vendor-crypto";
            }
            return undefined;
          },
        },
      },
    },
  };
});
