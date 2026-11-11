/**
 * Hangar controller: a self-hosted implementation of the browser service the
 * Firecrawl API calls through HANGAR_URL (see apps/api/src/lib/hangar.ts).
 *
 * Two listeners:
 *   API_PORT (3040)     internal API for the Firecrawl API, no auth (keep it
 *                       on the private Docker network)
 *     POST   /v1/browsers[?wait=N]            create (Idempotency-Key aware)
 *     GET    /v1/browsers/:id[?wait=N]        status, long-poll on change
 *     POST   /v1/browsers/:id/stop
 *     POST   /v1/browsers/:id/execute
 *     DELETE /v1/profiles/:name?owner=…
 *   PUBLIC_PORT (3030)  what end users reach, guarded by per-session tokens
 *     WS     /cdp/:id/:token                  CDP for Playwright/Puppeteer
 *     GET    /view/:id/:token                 live view (read-only)
 *     GET    /control/:id/:token              live view with input
 *     WS     /screencast/:id/:token
 *     GET    /recordings/:id/:token/(index.m3u8|segment-N.ts)
 *
 * Requests from the sandbox network are refused on both listeners, so
 * session code cannot drive the controller or other sessions.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  config,
  createSession,
  deleteProfile,
  executeInSession,
  getSession,
  HttpError,
  initSessions,
  recordingDir,
  sandboxUrl,
  stopSession,
  touch,
  view,
  waitForChange,
  type Session,
} from "./sessions.js";
import { liveViewPage } from "./liveview.js";
import { inSubnet } from "./net.js";

const API_PORT = Number(process.env.API_PORT ?? 3040);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 3030);
const SANDBOX_SUBNET = process.env.SANDBOX_SUBNET ?? ""; // e.g. 172.31.250.0/24

function fromSandbox(req: http.IncomingMessage): boolean {
  return inSubnet(req.socket.remoteAddress, SANDBOX_SUBNET);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Internal API
// ---------------------------------------------------------------------------

const api = http.createServer(async (req, res) => {
  if (fromSandbox(req)) return json(res, 403, { error: "forbidden" });
  const url = new URL(req.url ?? "/", "http://hangar");
  const parts = url.pathname.split("/").filter(Boolean);
  const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0), 0), 60);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }
    // POST /v1/browsers
    if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "browsers") {
      const body = await readJson(req);
      const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
      const session = await createSession(body, key);
      if (session.status === "starting") await waitForChange(session.id, wait);
      return json(res, 200, view(session, true));
    }
    if (parts[0] === "v1" && parts[1] === "browsers" && parts[2]) {
      const session = getSession(parts[2]);
      if (!session) return json(res, 404, { error: "browser not found" });
      if (req.method === "GET" && parts.length === 3) {
        const before = session.status;
        if (wait > 0 && (before === "starting" || before === "running" || before === "stopping")) {
          await waitForChange(session.id, wait);
        }
        return json(res, 200, view(session));
      }
      if (req.method === "POST" && parts[3] === "stop") {
        await stopSession(session);
        return json(res, 200, view(session));
      }
      if (req.method === "POST" && parts[3] === "execute") {
        const body = await readJson(req);
        if (typeof body.code !== "string") throw new HttpError(400, "code is required");
        return json(res, 200, await executeInSession(session, body));
      }
    }
    // DELETE /v1/profiles/:name?owner=
    if (req.method === "DELETE" && parts[0] === "v1" && parts[1] === "profiles" && parts[2]) {
      const owner = url.searchParams.get("owner") ?? "default";
      const deletedAt = await deleteProfile(owner, decodeURIComponent(parts[2]));
      return json(res, 200, { deleted_at: deletedAt });
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error("api error", error);
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// Public gateway
// ---------------------------------------------------------------------------

type Access = { session: Session; kind: "cdp" | "view" | "control" | "recording" };

function resolveAccess(id: string | undefined, tok: string | undefined): Access | null {
  if (!id || !tok) return null;
  const session = getSession(id);
  if (!session) return null;
  if (tokenMatches(tok, session.cdp_token)) return { session, kind: "cdp" };
  if (session.live_view && tokenMatches(tok, session.view_token)) return { session, kind: "view" };
  if (session.live_view && session.interactive && tokenMatches(tok, session.control_token))
    return { session, kind: "control" };
  if (session.recording && tokenMatches(tok, session.recording_token)) return { session, kind: "recording" };
  return null;
}

const SEGMENT = /^(index\.m3u8|segment-\d{5}\.ts)$/;

const gateway = http.createServer((req, res) => {
  if (fromSandbox(req)) return json(res, 403, { error: "forbidden" });
  const url = new URL(req.url ?? "/", "http://hangar");
  const [route, id, tok, file] = url.pathname.split("/").filter(Boolean);
  const access = resolveAccess(id, tok);

  if (req.method === "GET" && (route === "view" || route === "control")) {
    if (!access || access.kind !== route) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    return res.end(liveViewPage(access.kind === "control"));
  }
  if (req.method === "GET" && route === "recordings") {
    if (!access || access.kind !== "recording" || !file || !SEGMENT.test(file)) {
      return json(res, 404, { error: "not found" });
    }
    const filePath = path.join(recordingDir(access.session.id), file);
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      "access-control-allow-origin": "*",
      "cache-control": file.endsWith(".m3u8") ? "no-store" : "max-age=86400",
    });
    return fs.createReadStream(filePath).pipe(res);
  }
  json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

gateway.on("upgrade", (req, socket, head) => {
  if (fromSandbox(req)) return socket.destroy();
  const url = new URL(req.url ?? "/", "http://hangar");
  const [route, id, tok] = url.pathname.split("/").filter(Boolean);
  const access = resolveAccess(id, tok);
  const session = access?.session;
  let upstreamPath: string | null = null;
  if (route === "cdp" && access?.kind === "cdp") upstreamPath = "/cdp";
  if (route === "screencast" && (access?.kind === "view" || access?.kind === "control")) {
    upstreamPath = `/screencast?control=${access.kind === "control" ? 1 : 0}`;
  }
  if (!session || !upstreamPath || session.status !== "running") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, client => {
    const target = sandboxUrl(session, upstreamPath!).replace(/^http/, "ws");
    const upstream = new WebSocket(target, {
      headers: { "x-sandbox-token": session.sandbox_token },
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    const pending: { data: any; binary: boolean }[] = [];
    upstream.on("open", () => {
      for (const m of pending) upstream.send(m.data, { binary: m.binary });
      pending.length = 0;
    });
    client.on("message", (data, binary) => {
      touch(session);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else pending.push({ data, binary });
    });
    upstream.on("message", (data, binary) => client.send(data, { binary }));
    const close = () => {
      client.close();
      upstream.close();
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", error => {
      console.warn(`gateway upstream error for ${session.id}: ${error.message}`);
      close();
    });
    upstream.on("unexpected-response", (_req, response) => {
      console.warn(`gateway upstream refused for ${session.id}: HTTP ${response.statusCode}`);
      close();
    });
  });
});

async function main(): Promise<void> {
  await initSessions();
  api.listen(API_PORT, "0.0.0.0", () => console.log(`hangar api on :${API_PORT}`));
  gateway.listen(PUBLIC_PORT, "0.0.0.0", () =>
    console.log(`hangar gateway on :${PUBLIC_PORT} (public url ${config.publicUrl})`),
  );
}

void main();
