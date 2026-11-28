import { parseServerConfig } from "@astrowallet/domain";
import { createApp, type WorkerBindings } from "./app.js";
import { createD1Repository } from "./db/repository.js";

export { ChainWatcherDO } from "./durable-objects/chain-watcher.js";
export { ChannelPoolDO } from "./durable-objects/channel-pool.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, env: WorkerBindings): Promise<void> {
    if (!env.DB) return;
    const repo = createD1Repository(env.DB);
    await repo.purgeExpiredRecords(Math.floor(Date.now() / 1000));
    // Wake the payment-alert watcher; it hibernates again after 30 min without activity.
    if (env.CHAIN_WATCHER) {
      try {
        const config = parseServerConfig(env as unknown as Record<string, unknown>);
        const stub = env.CHAIN_WATCHER.get(env.CHAIN_WATCHER.idFromName(`watcher:${config.network}`));
        await stub.fetch("https://chain-watcher.internal/ensure", { method: "POST" });
      } catch {
        // Never fail the cron because the watcher is unavailable
      }
    }
  },
};
