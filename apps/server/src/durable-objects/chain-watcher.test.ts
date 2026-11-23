import { describe, expect, it, vi } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { WorkerBindings } from "../app.js";
import { ChainWatcherDO } from "./chain-watcher.js";

function createMockDoState() {
  const store = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const state = {
    storage: {
      get: vi.fn(async <T>(key: string) => store.get(key) as T | undefined),
      put: vi.fn(async (key: string, val: unknown) => {
        store.set(key, val);
      }),
      getAlarm: vi.fn(async () => alarmAt),
      setAlarm: vi.fn(async (ts: number) => {
        alarmAt = ts;
      }),
    },
  } as unknown as DurableObjectState;
  return { state, store };
}

function createMockD1(watched: Array<{ telegramUserId: string; address: string; label: string }>) {
  const claimedKeys = new Set<string>();
  return {
    prepare: vi.fn((sql: string) => {
      const bind = (...args: unknown[]) => ({
        all: vi.fn(async () => {
          if (sql.includes("FROM linked_addresses")) {
            return {
              results: watched.map((w) => ({
                telegram_user_id: w.telegramUserId,
                address: w.address,
                label: w.label,
              })),
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => null),
        run: vi.fn(async () => {
          if (sql.includes("INSERT OR IGNORE INTO alert_dedup")) {
            const key = String(args[0] ?? "");
            const isNew = !claimedKeys.has(key);
            claimedKeys.add(key);
            return { meta: { changes: isNew ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        }),
      });
      return {
        bind,
        all: vi.fn(async () => {
          if (sql.includes("FROM linked_addresses")) {
            return {
              results: watched.map((w) => ({
                telegram_user_id: w.telegramUserId,
                address: w.address,
                label: w.label,
              })),
            };
          }
          return { results: [] };
        }),
      };
    }),
  };
}

function makeEnv(db: ReturnType<typeof createMockD1>): WorkerBindings {
  return {
    DB: db as unknown as WorkerBindings["DB"],
    STELLAR_NETWORK: "mainnet",
    STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    HORIZON_URLS: "https://horizon.example.org",
    STELLAR_RPC_URLS: "https://rpc.example.org",
    TG_BOT_TOKEN: "123456:TEST_TOKEN_SECRET",
    TG_WEBHOOK_SECRET: "secret-header-token-1234",
    TG_BOT_USERNAME: "AstroWalletAppBot",
    TELEGRAM_API_ORIGIN: "https://tg.example.org",
    PWA_ORIGIN: "https://astrowallet.example.org",
    ALLOWED_ORIGINS: "https://astrowallet.example.org",
    INTENT_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  } as unknown as WorkerBindings;
}

describe("ChainWatcherDO anti-flood & cursor seeding", () => {
  const ADDR = "GCOKDLYTDOFSLBXOA4PGNSEG6RAYZN2THJJHZ5PFB2RT4GIZWR2N4RGD";

  it("seeds initial cursor at HEAD (order=desc&limit=1) with 0 Telegram alerts", async () => {
    const { state, store } = createMockDoState();
    const db = createMockD1([{ telegramUserId: "1572614676", address: ADDR, label: "external" }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/payments?")) {
        expect(url).toContain("order=desc");
        expect(url).toContain("limit=1");
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  paging_token: "999999999-1",
                  transaction_hash: "tx-latest",
                  created_at: "2024-01-01T00:00:00Z",
                  type: "payment",
                  from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                  to: ADDR,
                  amount: "5.0000000",
                  asset_type: "native",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    try {
      const watcher = new ChainWatcherDO(state, makeEnv(db));
      await watcher.alarm();
      expect(store.get(`pay_cursor:mainnet:${ADDR}`)).toBe("999999999-1");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores historical payments older than 15 minutes and fast-forwards stuck cursor to HEAD", async () => {
    const { state, store } = createMockDoState();
    store.set(`pay_cursor:mainnet:${ADDR}`, "1000-1");
    const db = createMockD1([{ telegramUserId: "1572614676", address: ADDR, label: "external" }]);
    let tgCalls = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("tg.example.org")) {
        tgCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("order=asc")) {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  paging_token: "2000-1",
                  transaction_hash: "tx-old",
                  created_at: "2022-05-01T12:00:00Z",
                  type: "payment",
                  from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                  to: ADDR,
                  amount: "1.4800000",
                  asset_type: "native",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("order=desc")) {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [{ paging_token: "888888888-1" }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const watcher = new ChainWatcherDO(state, makeEnv(db));
      await watcher.alarm();
      expect(tgCalls).toBe(0);
      expect(store.get(`pay_cursor:mainnet:${ADDR}`)).toBe("888888888-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("alerts once for fresh payment >= 0.05 XLM and skips 1-stroop dust", async () => {
    const { state, store } = createMockDoState();
    store.set(`pay_cursor:mainnet:${ADDR}`, "888888888-1");
    const db = createMockD1([{ telegramUserId: "1572614676", address: ADDR, label: "external" }]);
    let tgCalls = 0;
    const freshIso = new Date().toISOString();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("tg.example.org")) {
        tgCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("order=asc")) {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  paging_token: "888888889-1",
                  transaction_hash: "tx-dust",
                  created_at: freshIso,
                  type: "payment",
                  from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                  to: ADDR,
                  amount: "0.0000001",
                  asset_type: "native",
                },
                {
                  paging_token: "888888890-1",
                  transaction_hash: "tx-fresh",
                  created_at: freshIso,
                  type: "payment",
                  from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                  to: ADDR,
                  amount: "0.5000000",
                  asset_type: "native",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const watcher = new ChainWatcherDO(state, makeEnv(db));
      await watcher.alarm();
      expect(tgCalls).toBe(1);
      expect(store.get(`pay_cursor:mainnet:${ADDR}`)).toBe("888888890-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
