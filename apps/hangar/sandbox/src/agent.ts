/**
 * Hangar sandbox agent. One instance runs inside every browser-session
 * container and owns that session's Chromium:
 *
 *   - launches Chromium with remote debugging on 127.0.0.1 only
 *   - POST /execute     runs node / python / bash code against the browser
 *   - WS   /cdp         authenticated CDP passthrough for clients
 *   - WS   /screencast  live view frames (and input, for control clients)
 *   - records the session to HLS when RECORD=1
 *   - POST /shutdown    flushes the recording and profile, then exits
 *
 * Every request must carry the per-session token (header x-sandbox-token or
 * ?token=). Chromium's own debugging port is never reachable from outside
 * the container.
 */
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { runCode, type ExecuteRequest } from "./execute.js";
import { Recorder } from "./recorder.js";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.SANDBOX_TOKEN ?? "";
const DEBUG_PORT = 9222;
const PROFILE_MODE = process.env.PROFILE_MODE ?? "none"; // none | rw | ro
const PROFILE_SOURCE = "/profile";
const RECORD = process.env.RECORD === "1";
const RECORDING_DIR = "/recording";
const BLOCK_ADS = process.env.BLOCK_ADS === "1";
const EGRESS_PROXY = process.env.EGRESS_PROXY ?? "";
const VIEWPORT = { width: 1280, height: 800 };
const STATE_FILE = "/tmp/hangar-state.json";

if (!TOKEN) {
  console.error("SANDBOX_TOKEN is required");
  process.exit(1);
}

const state = {
  ready: false,
  lastActivity: Date.now(),
  currentTargetId: null as string | null,
  error: null as string | null,
};

export function touch(): void {
  state.lastActivity = Date.now();
}

function checkToken(req: http.IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://sandbox");
  const given = String(
    req.headers["x-sandbox-token"] ?? url.searchParams.get("token") ?? "",
  );
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------

function userDataDir(): string {
  if (PROFILE_MODE === "rw") return PROFILE_SOURCE;
  const dir = "/tmp/chrome-profile";
  fs.mkdirSync(dir, { recursive: true });
  if (PROFILE_MODE === "ro" && fs.existsSync(PROFILE_SOURCE)) {
    // A read-only profile: start from a copy so the saved one never changes.
    fs.cpSync(PROFILE_SOURCE, dir, { recursive: true });
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.rmSync(path.join(dir, lock), { force: true });
    }
  }
  return dir;
}

let chromeProcess: ChildProcess | null = null;
let browser: Browser | null = null;

async function waitForDebugger(timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const body = (await res.json()) as { webSocketDebuggerUrl: string };
      return body.webSocketDebuggerUrl;
    } catch {
      if (Date.now() > deadline) throw new Error("Chromium did not start");
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

async function launchChromium(): Promise<void> {
  const dataDir = userDataDir();
  if (PROFILE_MODE === "rw") {
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.rmSync(path.join(dataDir, lock), { force: true });
    }
  }
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${dataDir}`,
    "--headless=new",
    // The container is the sandbox: no user namespaces are available to
    // Chromium's own sandbox once every capability is dropped.
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--password-store=basic",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...(EGRESS_PROXY ? [`--proxy-server=${EGRESS_PROXY}`] : []),
    ...(BLOCK_ADS && fs.existsSync("/opt/ublock/manifest.json")
      ? ["--load-extension=/opt/ublock", "--disable-extensions-except=/opt/ublock"]
      : []),
    "about:blank",
  ];
  chromeProcess = spawn(chromium.executablePath(), args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  chromeProcess.stderr?.on("data", () => {});
  chromeProcess.on("exit", code => {
    if (!shuttingDown) {
      state.error = `Chromium exited unexpectedly (code ${code})`;
      console.error(state.error);
      process.exit(2);
    }
  });
  await waitForDebugger();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  context.on("page", () => touch());
}

async function targetIdOf(page: Page): Promise<string | null> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const info = await cdp.send("Target.getTargetInfo");
    await cdp.detach().catch(() => {});
    return info.targetInfo.targetId;
  } catch {
    return null;
  }
}

/** The page live view, recording and new executions start from. */
export async function currentPage(): Promise<Page | null> {
  if (!browser) return null;
  const pages = browser
    .contexts()
    .flatMap(c => c.pages())
    .filter(p => !p.isClosed() && !p.url().startsWith("chrome-extension://"));
  if (pages.length === 0) return null;
  if (state.currentTargetId) {
    for (const p of pages) {
      if ((await targetIdOf(p)) === state.currentTargetId) return p;
    }
  }
  return pages[pages.length - 1];
}

export function setCurrentTarget(targetId: string | null): void {
  if (targetId) state.currentTargetId = targetId;
}

// ---------------------------------------------------------------------------
// Screencast (live view + recording)
// ---------------------------------------------------------------------------

type Viewer = { ws: WebSocket; control: boolean };
const viewers = new Set<Viewer>();
let recorder: Recorder | null = null;
let castSession: CDPSession | null = null;
let castTarget: string | null = null;
let lastFrame: Buffer | null = null;

async function ensureScreencast(): Promise<void> {
  if (viewers.size === 0 && !recorder) {
    if (castSession) {
      await castSession.send("Page.stopScreencast").catch(() => {});
      await castSession.detach().catch(() => {});
      castSession = null;
      castTarget = null;
    }
    return;
  }
  const page = await currentPage();
  if (!page) return;
  const targetId = await targetIdOf(page);
  if (castSession && targetId === castTarget) return;
  if (castSession) await castSession.detach().catch(() => {});
  castSession = await page.context().newCDPSession(page);
  castTarget = targetId;
  castSession.on("Page.screencastFrame", async frame => {
    lastFrame = Buffer.from(frame.data, "base64");
    castSession
      ?.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {});
    for (const viewer of viewers) {
      if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(lastFrame);
    }
  });
  await castSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
  });
}

setInterval(() => {
  if (state.ready) ensureScreencast().catch(() => {});
}, 1500);

// Recording: re-emit the latest frame at a constant rate so HLS timing
// matches wall-clock time even when the page is static.
setInterval(() => {
  if (recorder && lastFrame) recorder.write(lastFrame);
}, 1000 / Recorder.FPS);

async function dispatchInput(event: any): Promise<void> {
  if (!castSession) return;
  touch();
  switch (event.type) {
    case "mouse":
      await castSession.send("Input.dispatchMouseEvent", {
        type: event.action, // mousePressed | mouseReleased | mouseMoved | mouseWheel
        x: event.x,
        y: event.y,
        button: event.button ?? "left",
        clickCount: event.clickCount ?? 1,
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
      });
      break;
    case "key":
      await castSession.send("Input.dispatchKeyEvent", {
        type: event.action, // keyDown | keyUp | char
        key: event.key,
        code: event.code,
        text: event.text,
      });
      break;
    case "navigate": {
      const page = await currentPage();
      await page?.goto(String(event.url)).catch(() => {});
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP / WebSocket server
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const viewer of viewers) viewer.ws.close();
  if (recorder) await recorder.finish();
  // A clean Chromium exit is what flushes cookies, local storage and the
  // SQLite journals into the profile. For a connectOverCDP browser,
  // Playwright's browser.close() only disconnects, so ask Chromium itself
  // to close and wait for the process to exit.
  const exited = new Promise<void>(resolve => {
    if (!chromeProcess || chromeProcess.exitCode !== null) return resolve();
    chromeProcess.once("exit", () => resolve());
  });
  const waitExit = (ms: number) =>
    Promise.race([exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);
  try {
    const cdp = await browser?.newBrowserCDPSession();
    await cdp?.send("Browser.close");
  } catch {}
  if (!(await waitExit(15000))) {
    chromeProcess?.kill("SIGTERM");
    if (!(await waitExit(5000))) chromeProcess?.kill("SIGKILL");
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ stoppedAt: Date.now() }));
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  if (!checkToken(req)) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://sandbox");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, state.ready ? 200 : 503, { ready: state.ready, error: state.error });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return json(res, 200, {
        ready: state.ready,
        lastActivity: state.lastActivity,
        currentTargetId: state.currentTargetId,
        recording: !!recorder,
      });
    }
    if (req.method === "POST" && url.pathname === "/execute") {
      touch();
      const body = (await readJson(req)) as ExecuteRequest;
      const result = await runCode(body, state.currentTargetId);
      if (result.currentTargetId) setCurrentTarget(result.currentTargetId);
      touch();
      const { currentTargetId: _ignored, ...publicResult } = result;
      return json(res, 200, publicResult);
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      json(res, 202, { stopping: true });
      void shutdown();
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  if (!checkToken(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://sandbox");
  if (url.pathname === "/cdp") {
    // Raw passthrough to Chromium's browser-level endpoint.
    let upstreamUrl: string;
    try {
      upstreamUrl = await waitForDebugger(5000);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      // Messages that arrive before Chromium's socket opens are queued with
      // their frame type: CDP only accepts text frames, and ws would send a
      // queued Buffer as binary.
      const pending: { data: any; binary: boolean }[] = [];
      upstream.on("open", () => {
        for (const m of pending) upstream.send(m.data, { binary: m.binary });
        pending.length = 0;
      });
      client.on("message", (data, isBinary) => {
        touch();
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push({ data, binary: isBinary });
      });
      upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      const closeBoth = () => {
        client.close();
        upstream.close();
      };
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
      client.on("error", closeBoth);
      upstream.on("error", closeBoth);
    });
    return;
  }
  if (url.pathname === "/screencast") {
    const control = url.searchParams.get("control") === "1";
    wss.handleUpgrade(req, socket, head, ws => {
      const viewer: Viewer = { ws, control };
      viewers.add(viewer);
      if (lastFrame) ws.send(lastFrame);
      void ensureScreencast();
      ws.on("message", data => {
        if (!viewer.control) return;
        try {
          void dispatchInput(JSON.parse(data.toString()));
        } catch {}
      });
      ws.on("close", () => {
        viewers.delete(viewer);
        void ensureScreencast();
      });
    });
    return;
  }
  socket.destroy();
});

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

async function main(): Promise<void> {
  server.listen(PORT, "0.0.0.0");
  try {
    await launchChromium();
    if (RECORD) {
      recorder = new Recorder(RECORDING_DIR, VIEWPORT);
      await recorder.start();
    }
    state.ready = true;
    void ensureScreencast();
    console.log("sandbox ready");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    console.error("sandbox failed to start:", state.error);
  }
}

void main();
