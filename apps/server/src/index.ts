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
  },
};
