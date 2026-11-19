import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Safely loads non-git local developer environment overrides from:
 *   1. ~/.secrets/env (Cloudflare account/API tokens)
 *   2. ~/.secrets/astrowallet/*.env (dedicated AstroWallet secrets)
 *
 * Process environment variables always take precedence.
 * Never logs or returns secret values.
 */
export function loadLocalSecrets(options = {}) {
  const applyToEnv = options.applyToEnv ?? true;
  const secretsRoot = join(homedir(), ".secrets");
  const candidateFiles = [];

  const sharedCloudflareEnv = join(secretsRoot, "env");
  if (existsSync(sharedCloudflareEnv)) {
    candidateFiles.push(sharedCloudflareEnv);
  }

  const walletSecretsDir = join(secretsRoot, "astrowallet");
  if (existsSync(walletSecretsDir)) {
    for (const entry of readdirSync(walletSecretsDir).sort()) {
      if (entry.endsWith(".env")) {
        candidateFiles.push(join(walletSecretsDir, entry));
      }
    }
  }

  const loadedFiles = [];
  const keysLoaded = [];

  for (const filePath of candidateFiles) {
    const raw = readFileSync(filePath, "utf8");
    loadedFiles.push(filePath);

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const match = line.match(/^(?:export\s+)?([A-Z0-9_]{2,64})\s*=\s*(.+)$/);
      if (!match) continue;

      const key = match[1];
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!key || !value) continue;

      if (applyToEnv && !process.env[key]) {
        process.env[key] = value;
      }
      keysLoaded.push(key);
    }
  }

  return { loadedFiles, keysLoaded };
}
