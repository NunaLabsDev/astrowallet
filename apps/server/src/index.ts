import { createApp } from "./app.js";

export { ChainWatcherDO } from "./durable-objects/chain-watcher.js";

const app = createApp();

export default {
  fetch: app.fetch,
};
