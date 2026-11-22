import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.wrangler/**",
      "coverage/**",
      ".agents/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/pwa/**/*.ts", "apps/pwa/**/*.tsx"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "grammy", message: "apps/pwa must never import server bot packages." },
            { name: "hono", message: "apps/pwa must never import server framework packages." },
          ],
          patterns: [
            { group: ["cloudflare:*"], message: "apps/pwa must never import Cloudflare runtime modules." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/server/**/*.ts"],
    languageOptions: {
      globals: globals.serviceworker,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "apps/server must never import React." },
            { name: "react-dom", message: "apps/server must never import React DOM." },
            {
              name: "@astrowallet/stellar-core",
              message: "apps/server must remain non-custodial and never import @astrowallet/stellar-core.",
            },
            {
              name: "@astrowallet/ton-core",
              message: "apps/server must remain non-custodial and never import @astrowallet/ton-core.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "@astrowallet/domain must stay pure." },
            { name: "react-dom", message: "@astrowallet/domain must stay pure." },
            { name: "grammy", message: "@astrowallet/domain must stay pure." },
            { name: "hono", message: "@astrowallet/domain must stay pure." },
            { name: "hash-wasm", message: "@astrowallet/domain must stay pure." },
          ],
          patterns: [
            { group: ["@stellar/*"], message: "@astrowallet/domain must not depend on Stellar SDKs." },
            { group: ["@ton/*"], message: "@astrowallet/domain must not depend on TON SDKs." },
            { group: ["cloudflare:*"], message: "@astrowallet/domain must not depend on Cloudflare." },
            { group: ["@astrowallet/*"], message: "@astrowallet/domain is the root layer and cannot import peer packages." },
            { group: ["@noble/*"], message: "@astrowallet/domain must not depend on crypto primitives." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/stellar-core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "stellar-core cannot import UI frameworks." },
            { name: "react-dom", message: "stellar-core cannot import UI frameworks." },
            { name: "grammy", message: "stellar-core cannot import Telegram bot SDKs." },
            { name: "hono", message: "stellar-core cannot import HTTP server frameworks." },
            { name: "@astrowallet/security-shield", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/defi", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/tg-protocol", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/ton-core", message: "Peer package import forbidden by hexagonal DAG." },
          ],
          patterns: [
            { group: ["cloudflare:*"], message: "stellar-core cannot import Cloudflare modules." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ton-core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "ton-core cannot import UI frameworks." },
            { name: "react-dom", message: "ton-core cannot import UI frameworks." },
            { name: "grammy", message: "ton-core cannot import Telegram bot SDKs." },
            { name: "hono", message: "ton-core cannot import HTTP server frameworks." },
            { name: "@astrowallet/stellar-core", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/security-shield", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/defi", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/tg-protocol", message: "Peer package import forbidden by hexagonal DAG." },
          ],
          patterns: [
            { group: ["@stellar/*"], message: "ton-core cannot import Stellar SDKs." },
            { group: ["cloudflare:*"], message: "ton-core cannot import Cloudflare modules." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/security-shield/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "security-shield cannot import UI frameworks." },
            { name: "react-dom", message: "security-shield cannot import UI frameworks." },
            { name: "grammy", message: "security-shield cannot import Telegram bot SDKs." },
            { name: "hono", message: "security-shield cannot import HTTP server frameworks." },
            { name: "@astrowallet/stellar-core", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/defi", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/tg-protocol", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/ton-core", message: "Peer package import forbidden by hexagonal DAG." },
          ],
          patterns: [
            { group: ["cloudflare:*"], message: "security-shield cannot import Cloudflare modules directly." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/defi/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "defi cannot import UI frameworks." },
            { name: "react-dom", message: "defi cannot import UI frameworks." },
            { name: "grammy", message: "defi cannot import Telegram bot SDKs." },
            { name: "hono", message: "defi cannot import HTTP server frameworks." },
            { name: "@astrowallet/stellar-core", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/security-shield", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/tg-protocol", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/ton-core", message: "Peer package import forbidden by hexagonal DAG." },
          ],
          patterns: [
            { group: ["cloudflare:*"], message: "defi cannot import Cloudflare modules." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/tg-protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "tg-protocol cannot import UI frameworks." },
            { name: "react-dom", message: "tg-protocol cannot import UI frameworks." },
            { name: "grammy", message: "tg-protocol must stay transport-agnostic." },
            { name: "hono", message: "tg-protocol must stay transport-agnostic." },
            { name: "@astrowallet/stellar-core", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/security-shield", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/defi", message: "Peer package import forbidden by hexagonal DAG." },
            { name: "@astrowallet/ton-core", message: "Peer package import forbidden by hexagonal DAG." },
          ],
          patterns: [
            { group: ["cloudflare:*"], message: "tg-protocol cannot import Cloudflare modules." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/connect-sdk/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "connect-sdk must stay framework-agnostic." },
            { name: "react-dom", message: "connect-sdk must stay framework-agnostic." },
            { name: "grammy", message: "connect-sdk must stay server-agnostic." },
            { name: "hono", message: "connect-sdk must stay server-agnostic." },
          ],
          patterns: [
            { group: ["@astrowallet/*"], message: "connect-sdk must stay standalone for npm consumers." },
            { group: ["@stellar/*"], message: "connect-sdk must stay dependency-light without @stellar/*." },
            { group: ["cloudflare:*"], message: "connect-sdk cannot import Cloudflare modules." },
          ],
        },
      ],
    },
  },
);
