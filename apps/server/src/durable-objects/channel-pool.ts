import type { DurableObjectState } from "@cloudflare/workers-types";

const LEASE_TTL_MS = 30_000;

interface LeaseRecord {
  leaseId: string;
  channelAddress: string;
  channelIndex: number;
  expiresAtMs: number;
}

/**
 * Atomic single-threaded lease manager over RELAY_CHANNEL_ACCOUNTS to prevent
 * concurrent `tx_bad_seq` collisions during viral transaction bursts.
 */
export class ChannelPoolDO {
  private readonly leases = new Map<string, LeaseRecord>();
  private roundRobinCursor = 0;

  constructor(_state: DurableObjectState, _env: unknown) {}

  private pruneExpired(nowMs: number): void {
    for (const [leaseId, lease] of this.leases.entries()) {
      if (lease.expiresAtMs <= nowMs) {
        this.leases.delete(leaseId);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nowMs = Date.now();
    this.pruneExpired(nowMs);

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        ok: true,
        activeLeases: this.leases.size,
      });
    }

    if (url.pathname === "/acquire" && request.method === "POST") {
      let body: { channels?: unknown; exclude?: unknown };
      try {
        body = (await request.json()) as { channels?: unknown; exclude?: unknown };
      } catch {
        return Response.json({ error: "Invalid acquire payload" }, { status: 400 });
      }
      const channels = Array.isArray(body.channels)
        ? body.channels.filter((c): c is string => typeof c === "string" && c.length > 0)
        : [];
      if (channels.length === 0) {
        return Response.json({ error: "No channel accounts configured" }, { status: 400 });
      }
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
          expiresAtMs: nowMs + LEASE_TTL_MS,
        });
        this.roundRobinCursor = (idx + 1) % channels.length;
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
      if (typeof body.leaseId === "string") {
        this.leases.delete(body.leaseId);
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
