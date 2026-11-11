/**
 * Egress proxy for Hangar sandboxes. Sandboxes sit on an internal-only Docker
 * network; this HTTP/CONNECT proxy is their only way out. It refuses targets
 * that resolve to private, loopback, link-local or other internal addresses
 * (so session code cannot reach the LAN, the Firecrawl services, or cloud
 * metadata endpoints) and optionally chains to an upstream proxy.
 */
import { Server } from "proxy-chain";
import { ssrfPrepareRequest } from "./ssrf.js";

const PORT = Number(process.env.PORT ?? 3128);
const ALLOW_LOCAL = (process.env.EGRESS_ALLOW_LOCAL ?? "false").toLowerCase() === "true";

function upstreamProxyUrl(): string | undefined {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined;
  const url = new URL(server.includes("://") ? server : `http://${server}`);
  if (process.env.PROXY_USERNAME) url.username = process.env.PROXY_USERNAME;
  if (process.env.PROXY_PASSWORD) url.password = process.env.PROXY_PASSWORD;
  return url.toString();
}

const server = new Server({
  port: PORT,
  host: "0.0.0.0",
  prepareRequestFunction: ssrfPrepareRequest({
    allowLocal: ALLOW_LOCAL,
    upstreamProxyUrl: upstreamProxyUrl(),
  }),
});

server.on("requestFailed", ({ error, request }: any) => {
  console.warn(`egress refused/failed ${request?.url ?? ""}: ${error?.message ?? error}`);
});

server.listen().then(() => {
  console.log(
    `hangar egress listening on ${PORT} (upstream: ${upstreamProxyUrl() ? "yes" : "direct"}, allowLocal: ${ALLOW_LOCAL})`,
  );
});
