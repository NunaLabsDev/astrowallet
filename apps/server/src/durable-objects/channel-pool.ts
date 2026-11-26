import type { DurableObjectState } from "@cloudflare/workers-types";

const DEFAULT_LEASE_TTL_MS = 12_000;
const MIN_LEASE_TTL_MS = 3_000;
const MAX_LEASE_TTL_MS = 30_000;
const STORAGE_KEY = "channel_pool_state_v1";

interface LeaseRecord {
  leaseId: string;
  channelAddress: string;
  channelIndex: number;
  expiresAtMs: number;
}

interface PersistedPoolState {
  leases: LeaseRecord[];
  roundRobinCursor: number;
}

/**
 * Atomic single-threaded lease manager over RELAY_CHANNEL_ACCOUNTS to prevent
 * concurrent `tx_bad_seq` collisions during viral transaction bursts.
 * Persists active leases in DO storage so evictions/restarts do not drop in-flight locks.
 */
export class ChannelPoolDO {
  private readonly state: DurableObjectState | undefined;
  private readonly leases = new Map<string, LeaseRecord>();
  private roundRobinCursor = 0;
  private hydrated = false;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const storage = this.state?.storage;
    if (!storage || typeof storage.get !== "function") return;
    const saved = await storage.get<PersistedPoolState>(STORAGE_KEY).catch(() => undefined);
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.roundRobinCursor === "number" && Number.isFinite(saved.roundRobinCursor)) {
      this.roundRobinCursor = Math.max(0, Math.trunc(saved.roundRobinCursor));
    }
    if (Array.isArray(saved.leases)) {
      for (const lease of saved.leases) {
        if (
          lease &&
          typeof lease.leaseId === "string" &&
          typeof lease.channelAddress === "string" &&
          typeof lease.expiresAtMs === "number"
        ) {
          this.leases.set(lease.leaseId, lease);
        }
      }
    }
  }

  private async persist(): Promise<void> {
    const storage = this.state?.storage;
    if (!storage || typeof storage.put !== "function") return;
    await storage
      .put<PersistedPoolState>(STORAGE_KEY, {
        leases: Array.from(this.leases.values()),
        roundRobinCursor: this.roundRobinCursor,
      })
      .catch(() => undefined);
  }

  private pruneExpired(nowMs: number): boolean {
    let changed = false;
    for (const [leaseId, lease] of this.leases.entries()) {
      if (lease.expiresAtMs <= nowMs) {
        this.leases.delete(leaseId);
        changed = true;
      }
    }
    return changed;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureHydrated();
    const url = new URL(request.url);
    const nowMs = Date.now();
    const pruned = this.pruneExpired(nowMs);
    if (pruned) {
      await this.persist();
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        ok: true,
        activeLeases: this.leases.size,
      });
    }

    if (url.pathname === "/acquire" && request.method === "POST") {
      let body: { channels?: unknown; exclude?: unknown; ttlMs?: unknown };
      try {
        body = (await request.json()) as {
          channels?: unknown;
          exclude?: unknown;
          ttlMs?: unknown;
        };
      } catch {
        return Response.json({ error: "Invalid acquire payload" }, { status: 400 });
      }
      const channels = Array.isArray(body.channels)
        ? body.channels.filter((c): c is string => typeof c === "string" && c.length > 0)
        : [];
      if (channels.length === 0) {
        return Response.json({ error: "No channel accounts configured" }, { status: 400 });
      }
      const rawTtl = typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
        ? Math.trunc(body.ttlMs)
        : DEFAULT_LEASE_TTL_MS;
      const ttlMs = Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, rawTtl));
      const excluded = new Set(
        Array.isArray(body.exclude)
          ? body.exclude.filter((c): c is string => typeof c === "string")
          : [],
      );
      const activeAddresses = new Set(
        Array.from(this.leases.values()).map((l) => l.channelAddress),
      );

      for (let offset = 0; offset < channels.length; offset += 1) {
        const idx = (this.roundRobinCursor + offset) % channels.length;
        const addr = channels[idx]!;
        if (excluded.has(addr) || activeAddresses.has(addr)) {
          continue;
        }
        const leaseId = `ch_${crypto.randomUUID()}`;
        this.leases.set(leaseId, {
          leaseId,
          channelAddress: addr,
          channelIndex: idx,
          expiresAtMs: nowMs + ttlMs,
        });
        this.roundRobinCursor = (idx + 1) % channels.length;
        await this.persist();
        return Response.json({
          ok: true,
          leaseId,
          channelAddress: addr,
          channelIndex: idx,
        });
      }

      return Response.json(
        { error: "All relay channel accounts are currently busy; retry shortly" },
        { status: 429 },
      );
    }

    if (url.pathname === "/release" && request.method === "POST") {
      let body: { leaseId?: unknown };
      try {
        body = (await request.json()) as { leaseId?: unknown };
      } catch {
        return Response.json({ error: "Invalid release payload" }, { status: 400 });
      }
      if (typeof body.leaseId === "string" && this.leases.delete(body.leaseId)) {
        await this.persist();
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
