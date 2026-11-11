/**
 * Browser session lifecycle for the Hangar controller.
 *
 * Each session is one sandbox container (apps/hangar/sandbox) on an
 * internal-only network. State is persisted to DATA_DIR/state.json so
 * sessions survive a controller restart.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createContainer,
  inspectContainer,
  listContainers,
  removeContainer,
  stopContainer,
} from "./docker.js";

export const config = {
  dataDir: process.env.DATA_DIR ?? "/data",
  dataVolume: process.env.DATA_VOLUME ?? "hangar-data",
  sandboxImage: process.env.SANDBOX_IMAGE ?? "firecrawl-hangar-sandbox",
  sandboxNetwork: process.env.SANDBOX_NETWORK ?? "hangar-sandbox",
  egressProxy: process.env.EGRESS_PROXY ?? "http://hangar-egress:3128",
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:3030").replace(/\/$/, ""),
  maxSessions: Number(process.env.MAX_SESSIONS ?? 4),
  sandboxMemoryMb: Number(process.env.SANDBOX_MEMORY_MB ?? 2048),
  sandboxCpus: Number(process.env.SANDBOX_CPUS ?? 1.5),
  sandboxRuntime: process.env.SANDBOX_RUNTIME || undefined, // e.g. "runsc" (gVisor)
  retentionDays: Number(process.env.RETENTION_DAYS ?? 7),
  startTimeoutSec: Number(process.env.START_TIMEOUT_SEC ?? 60),
};

export type Status =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type Session = {
  id: string;
  owner: string;
  status: Status;
  created_at: number;
  ended_at: number | null;
  max_expires_at: number | null;
  idle_timeout_seconds: number;
  recording: boolean;
  live_view: boolean;
  interactive: boolean;
  block_ads: boolean;
  profile: { name: string; save_changes: boolean } | null;
  profile_saved_at: number | null;
  proxy: unknown;
  idempotency_key: string | null;
  error: string | null;
  container_id: string | null;
  ip: string | null;
  last_activity: number; // epoch ms
  sandbox_token: string;
  cdp_token: string;
  view_token: string;
  control_token: string;
  recording_token: string;
};

const now = () => Math.floor(Date.now() / 1000);
const token = () => crypto.randomBytes(24).toString("base64url");

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();
const waiters = new Map<string, Set<() => void>>();
const statePath = () => path.join(config.dataDir, "state.json");
let saveTimer: NodeJS.Timeout | null = null;

function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = statePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...sessions.values()]));
    fs.renameSync(tmp, statePath());
  }, 200);
}

function update(session: Session, patch: Partial<Session>): void {
  const before = session.status;
  Object.assign(session, patch);
  persist();
  if (session.status !== before) {
    for (const wake of waiters.get(session.id) ?? []) wake();
    waiters.delete(session.id);
  }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function allSessions(): Session[] {
  return [...sessions.values()];
}

function isActive(s: Session): boolean {
  return s.status === "starting" || s.status === "running" || s.status === "stopping";
}

/** Public view of a session, per the Hangar API (epoch seconds). */
export function view(s: Session, withUrls = false) {
  const base = {
    id: s.id,
    status: s.status,
    created_at: s.created_at,
    ended_at: s.ended_at,
    max_expires_at: s.max_expires_at,
    recording: s.recording,
    profile_saved_at: s.profile_saved_at,
    error: s.error,
  };
  if (!withUrls) return base;
  const wsBase = config.publicUrl.replace(/^http/, "ws");
  return {
    ...base,
    cdp_url: `${wsBase}/cdp/${s.id}/${s.cdp_token}`,
    ...(s.live_view
      ? {
          view_url: `${config.publicUrl}/view/${s.id}/${s.view_token}`,
          ...(s.interactive
            ? { control_url: `${config.publicUrl}/control/${s.id}/${s.control_token}` }
            : {}),
        }
      : {}),
    ...(s.recording
      ? { playlist_url: `${config.publicUrl}/recordings/${s.id}/${s.recording_token}/index.m3u8` }
      : {}),
  };
}

/** Resolves when the session's status changes, or after `seconds`. */
export async function waitForChange(id: string, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, seconds * 1000);
    function done() {
      clearTimeout(timer);
      waiters.get(id)?.delete(done);
      resolve();
    }
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id)!.add(done);
  });
}

// ---------------------------------------------------------------------------
// Paths (owner and profile names never reach the filesystem unhashed)
// ---------------------------------------------------------------------------

const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function ownerKey(owner: string): string {
  return crypto.createHash("sha256").update(owner).digest("hex").slice(0, 32);
}

function profileSubpath(owner: string, name: string): string {
  return path.posix.join("profiles", ownerKey(owner), name);
}

function recordingSubpath(id: string): string {
  return path.posix.join("recordings", id);
}

export function recordingDir(id: string): string {
  return path.join(config.dataDir, recordingSubpath(id));
}

function ensureDir(subpath: string): void {
  fs.mkdirSync(path.join(config.dataDir, subpath), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Sandbox agent calls
// ---------------------------------------------------------------------------

export function sandboxUrl(s: Session, p: string): string {
  if (!s.ip) throw new HttpError(409, "Browser is not running");
  return `http://${s.ip}:8080${p}`;
}

async function sandboxFetch(s: Session, p: string, init: RequestInit & { timeoutMs?: number } = {}) {
  return await fetch(sandboxUrl(s, p), {
    ...init,
    headers: { ...(init.headers ?? {}), "x-sandbox-token": s.sandbox_token },
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
}

export function touch(s: Session): void {
  s.last_activity = Date.now();
}

// ---------------------------------------------------------------------------
// Create / stop / execute
// ---------------------------------------------------------------------------

export type CreateBody = {
  owner?: string;
  max_lifetime_seconds?: number;
  idle_timeout_seconds?: number;
  live_view?: { enabled?: boolean; interactive?: boolean };
  recording?: { enabled?: boolean };
  execution?: { enabled?: boolean };
  extensions?: string[];
  profile?: { name: string; save_changes?: boolean };
  proxy?: unknown;
};

const idempotency = new Map<string, string>();

export async function createSession(body: CreateBody, idempotencyKey: string | null): Promise<Session> {
  if (idempotencyKey) {
    const existingId = idempotency.get(idempotencyKey);
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) return existing;
  }
  const owner = String(body.owner ?? "default");
  const active = allSessions().filter(isActive);
  if (active.length >= config.maxSessions) {
    throw new HttpError(429, `Too many browser sessions (max ${config.maxSessions})`);
  }

  let profile: Session["profile"] = null;
  if (body.profile) {
    if (!PROFILE_NAME.test(body.profile.name)) throw new HttpError(400, "Invalid profile name");
    profile = { name: body.profile.name, save_changes: body.profile.save_changes !== false };
    const writer = active.find(
      s => s.owner === owner && s.profile?.name === profile!.name && s.profile.save_changes,
    );
    if (writer && profile.save_changes) {
      throw new HttpError(409, "Profile is in use by another session that saves changes");
    }
  }

  const lifetime = Math.min(Math.max(Number(body.max_lifetime_seconds ?? 600), 30), 6 * 3600);
  const idle = Math.min(Math.max(Number(body.idle_timeout_seconds ?? 300), 10), 6 * 3600);
  const id = crypto.randomUUID();
  const created = now();
  const session: Session = {
    id,
    owner,
    status: "starting",
    created_at: created,
    ended_at: null,
    max_expires_at: created + lifetime,
    idle_timeout_seconds: idle,
    recording: !!body.recording?.enabled,
    live_view: body.live_view?.enabled !== false,
    interactive: !!body.live_view?.interactive,
    block_ads: (body.extensions ?? []).includes("ublock"),
    profile,
    profile_saved_at: null,
    proxy: body.proxy ?? null,
    idempotency_key: idempotencyKey,
    error: null,
    container_id: null,
    ip: null,
    last_activity: Date.now(),
    sandbox_token: token(),
    cdp_token: token(),
    view_token: token(),
    control_token: token(),
    recording_token: token(),
  };
  sessions.set(id, session);
  if (idempotencyKey) idempotency.set(idempotencyKey, id);
  persist();

  const mounts: Parameters<typeof createContainer>[0]["mounts"] = [];
  if (profile) {
    const sub = profileSubpath(owner, profile.name);
    ensureDir(sub);
    mounts.push({ volume: config.dataVolume, subpath: sub, target: "/profile", readOnly: !profile.save_changes });
  }
  if (session.recording) {
    ensureDir(recordingSubpath(id));
    mounts.push({ volume: config.dataVolume, subpath: recordingSubpath(id), target: "/recording", readOnly: false });
  }

  try {
    const containerId = await createContainer({
      name: `hangar-sb-${id}`,
      image: config.sandboxImage,
      env: {
        SANDBOX_TOKEN: session.sandbox_token,
        PROFILE_MODE: profile ? (profile.save_changes ? "rw" : "ro") : "none",
        RECORD: session.recording ? "1" : "0",
        BLOCK_ADS: session.block_ads ? "1" : "0",
        EGRESS_PROXY: config.egressProxy,
      },
      labels: { "hangar.session": id, "hangar.owner": ownerKey(owner) },
      network: config.sandboxNetwork,
      mounts,
      memoryBytes: config.sandboxMemoryMb * 1024 * 1024,
      nanoCpus: Math.round(config.sandboxCpus * 1e9),
      pidsLimit: 1024,
      shmBytes: 512 * 1024 * 1024,
      runtime: config.sandboxRuntime,
    });
    update(session, { container_id: containerId });
  } catch (error) {
    update(session, {
      status: "failed",
      ended_at: now(),
      error: `Failed to start sandbox: ${error instanceof Error ? error.message : error}`,
    });
    return session;
  }

  void waitUntilReady(session);
  return session;
}

async function waitUntilReady(session: Session): Promise<void> {
  const deadline = Date.now() + config.startTimeoutSec * 1000;
  while (Date.now() < deadline && session.status === "starting") {
    try {
      const info = await inspectContainer(session.container_id!, config.sandboxNetwork);
      if (!info) throw new Error("container disappeared");
      if (!info.running) throw new Error(`sandbox exited with code ${info.exitCode}`);
      if (info.ip && session.ip !== info.ip) update(session, { ip: info.ip });
      if (session.ip) {
        const res = await sandboxFetch(session, "/health", { timeoutMs: 3000 });
        if (res.ok) {
          update(session, { status: "running", last_activity: Date.now() });
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error && /exited|disappeared/.test(error.message)) {
        await teardown(session, "failed", error.message);
        return;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (session.status === "starting") {
    await teardown(session, "failed", "Sandbox did not become ready in time");
  }
}

async function teardown(session: Session, status: "stopped" | "failed", error: string | null): Promise<void> {
  if (session.container_id) {
    await stopContainer(session.container_id).catch(() => {});
    await removeContainer(session.container_id).catch(() => {});
  }
  const ended = now();
  update(session, {
    status,
    ended_at: ended,
    error,
    ip: null,
    ...(status === "stopped" && session.profile?.save_changes ? { profile_saved_at: ended } : {}),
  });
}

export async function stopSession(session: Session): Promise<void> {
  if (session.status === "stopped" || session.status === "failed" || session.status === "stopping") return;
  const wasRunning = session.status === "running";
  update(session, { status: "stopping" });
  void (async () => {
    if (wasRunning && session.ip) {
      // Graceful: the sandbox flushes the recording and profile, then exits.
      await sandboxFetch(session, "/shutdown", { method: "POST", timeoutMs: 5000 }).catch(() => {});
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const info = await inspectContainer(session.container_id!, config.sandboxNetwork).catch(() => null);
        if (!info || !info.running) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    await teardown(session, "stopped", null);
  })();
}

export async function executeInSession(session: Session, body: any) {
  if (session.status !== "running") throw new HttpError(409, `Browser is ${session.status}`);
  const timeout = Math.min(Math.max(Number(body.timeout ?? 30), 1), 300);
  touch(session);
  const res = await sandboxFetch(session, "/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: body.code, language: body.language ?? "node", timeout }),
    timeoutMs: (timeout + 15) * 1000,
  });
  touch(session);
  if (!res.ok) throw new HttpError(502, `Sandbox execute failed: ${res.status}`);
  return await res.json();
}

export async function deleteProfile(owner: string, name: string): Promise<number> {
  if (!PROFILE_NAME.test(name)) throw new HttpError(400, "Invalid profile name");
  const inUse = allSessions().some(s => isActive(s) && s.owner === owner && s.profile?.name === name);
  if (inUse) throw new HttpError(409, "Profile is in use by an active session");
  fs.rmSync(path.join(config.dataDir, profileSubpath(owner, name)), { recursive: true, force: true });
  return now();
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

async function supervise(): Promise<void> {
  for (const session of allSessions()) {
    if (session.status !== "running") continue;
    try {
      const info = await inspectContainer(session.container_id!, config.sandboxNetwork);
      if (!info || !info.running) {
        await teardown(
          session,
          info?.exitCode === 0 ? "stopped" : "failed",
          info?.exitCode === 0 ? null : `Sandbox exited (code ${info?.exitCode ?? "unknown"})`,
        );
        continue;
      }
      const res = await sandboxFetch(session, "/status", { timeoutMs: 3000 });
      if (res.ok) {
        const st = (await res.json()) as { lastActivity: number };
        if (st.lastActivity > session.last_activity) session.last_activity = st.lastActivity;
      }
      const idleFor = (Date.now() - session.last_activity) / 1000;
      if (session.max_expires_at !== null && now() >= session.max_expires_at) {
        await stopSession(session);
      } else if (idleFor >= session.idle_timeout_seconds) {
        await stopSession(session);
      }
    } catch {
      // Transient; retried next tick.
    }
  }
  // Retention for finished sessions and their recordings.
  const cutoff = now() - config.retentionDays * 86400;
  for (const session of allSessions()) {
    if (!isActive(session) && session.ended_at !== null && session.ended_at < cutoff) {
      fs.rmSync(recordingDir(session.id), { recursive: true, force: true });
      sessions.delete(session.id);
      if (session.idempotency_key) idempotency.delete(session.idempotency_key);
      persist();
    }
  }
}

export async function initSessions(): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    for (const s of JSON.parse(fs.readFileSync(statePath(), "utf8")) as Session[]) {
      sessions.set(s.id, s);
      if (s.idempotency_key) idempotency.set(s.idempotency_key, s.id);
    }
  } catch {}
  // Reconcile with Docker after a restart.
  const containers = await listContainers("hangar.session").catch(() => []);
  const known = new Set(containers.map(c => c.Labels["hangar.session"]));
  for (const c of containers) {
    const s = sessions.get(c.Labels["hangar.session"]);
    if (!s || !isActive(s)) await removeContainer(c.Id).catch(() => {});
  }
  for (const s of allSessions()) {
    if (!isActive(s)) continue;
    if (!known.has(s.id)) {
      update(s, { status: "failed", ended_at: now(), error: "Sandbox lost during controller restart", ip: null });
    } else if (s.status === "starting") {
      void waitUntilReady(s);
    } else if (s.status === "stopping") {
      await teardown(s, "stopped", null);
    }
  }
  setInterval(() => void supervise(), 5000);
}
