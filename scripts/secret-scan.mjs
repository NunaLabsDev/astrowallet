import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const TARGET_ROOTS = ["packages", "apps", "contracts", "scripts"];
const ALLOWED_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".mts", ".rs"]);

const RULES = [
  {
    name: "Hardcoded Stellar network passphrase",
    regex: /(Test SDF Network\s*;\s*September 2015|Public Global Stellar Network\s*;\s*September 2015)/g,
  },
  {
    name: "Hardcoded Stellar / TON / Relayer / Explorer / Aggregator endpoint URL",
    regex: /https?:\/\/(?:horizon(?:-testnet)?\.stellar\.org|soroban-testnet\.stellar\.org|rpc(?:-testnet)?\.stellar\.org|friendbot\.stellar\.org|channels\.openzeppelin\.com|api\.stellar\.expert|api\.soroswap\.finance|(?:testnet\.)?toncenter\.com|bridge\.tonapi\.io)/gi,
  },
  {
    name: "Exposed sk_ API key",
    regex: /\bsk_[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    name: "Exposed GitHub PAT token",
    regex: /\bgh[pou]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "Exposed Stellar secret seed (S...)",
    regex: /\bS[A-Z2-7]{55}\b/g,
  },
  {
    name: "Exposed Telegram bot token",
    regex: /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/g,
  },
];

function walkSrcFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "target" ||
      entry === "test_snapshots" ||
      entry === ".wrangler" ||
      entry === ".turbo"
    ) {
      continue;
    }
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      walkSrcFiles(fullPath, out);
      continue;
    }
    if (!st.isFile()) continue;

    const rel = relative(ROOT, fullPath).replace(/\\/g, "/");
    if (rel === "scripts/secret-scan.mjs") continue;
    const isCodeRoot =
      rel.includes("/src/") ||
      rel.startsWith("apps/pwa/functions/") ||
      rel.startsWith("scripts/");
    if (!isCodeRoot) continue;
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;

    const dot = entry.lastIndexOf(".");
    const ext = dot >= 0 ? entry.slice(dot) : "";
    if (!ALLOWED_EXTS.has(ext)) continue;

    out.push(fullPath);
  }
  return out;
}

const files = TARGET_ROOTS.flatMap((dir) => walkSrcFiles(join(ROOT, dir)));
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  let content = readFileSync(file, "utf8");
  if (rel.endsWith(".rs")) {
    const testIdx = content.indexOf("#[cfg(test)]");
    if (testIdx >= 0) {
      content = content.slice(0, testIdx);
    }
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(line)) {
        violations.push(`${rel}:${i + 1} [${rule.name}]`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Secret & zero-hardcoding audit failed:");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(`Secret & zero-hardcoding scan clean across ${files.length} source file(s).`);
