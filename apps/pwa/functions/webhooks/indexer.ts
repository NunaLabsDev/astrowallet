import { forwardToWorker, type PagesProxyContext } from "../_proxy.js";

export function onRequest(context: PagesProxyContext): Promise<Response> {
  return forwardToWorker(context);
}
