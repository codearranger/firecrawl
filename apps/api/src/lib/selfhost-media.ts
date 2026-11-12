/**
 * Self-hosted media store for screenshots and action PDFs.
 *
 * The hosted API returns screenshots as short URLs to objects in a media
 * bucket. Self-hosted, the playwright-service returns them inline as base64
 * data: URLs, which makes every response that includes one ~100 KB+ and
 * overflows tool/LLM context windows (e.g. MCP clients). When
 * SELF_HOSTED_MEDIA_DIR is set, inline media is written there and replaced by
 * an unguessable URL served by GET /v2/media/:name. Files expire after
 * SELF_HOSTED_MEDIA_TTL_HOURS. Zero-data-retention scrapes stay inline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { config } from "../config";
import { logger } from "./logger";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  pdf: "application/pdf",
};
const DATA_URL = /^data:(image\/png|image\/jpeg|application\/pdf);base64,/;
export const MEDIA_NAME = /^[A-Za-z0-9_-]{32}\.(png|jpg|pdf)$/;

export function selfHostedMediaEnabled(): boolean {
  return !!config.SELF_HOSTED_MEDIA_DIR;
}

function publicBase(): string {
  return (
    config.SELF_HOSTED_MEDIA_PUBLIC_URL ?? "http://localhost:3002"
  ).replace(/\/$/, "");
}

/**
 * Store a data: URL and return its public URL. Anything that is not an
 * inline png/jpeg/pdf (for example an http URL) is returned unchanged.
 */
export async function storeInlineMedia(value: string): Promise<string> {
  const match = value.match(DATA_URL);
  if (!match || !config.SELF_HOSTED_MEDIA_DIR) return value;
  const ext = EXTENSIONS[match[1]];
  const name = `${crypto.randomBytes(24).toString("base64url")}.${ext}`;
  const bytes = Buffer.from(value.slice(match[0].length), "base64");
  await fs.promises.mkdir(config.SELF_HOSTED_MEDIA_DIR, { recursive: true });
  await fs.promises.writeFile(
    path.join(config.SELF_HOSTED_MEDIA_DIR, name),
    bytes,
  );
  return `${publicBase()}/v2/media/${name}`;
}

export async function mediaController(req: Request, res: Response) {
  const name = String(req.params.name ?? "");
  if (!config.SELF_HOSTED_MEDIA_DIR || !MEDIA_NAME.test(name)) {
    return res.status(404).json({ success: false, error: "Not found" });
  }
  const filePath = path.join(config.SELF_HOSTED_MEDIA_DIR, name);
  try {
    await fs.promises.access(filePath);
  } catch {
    return res.status(404).json({ success: false, error: "Not found" });
  }
  res.setHeader("Content-Type", CONTENT_TYPES[name.split(".").pop()!]);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(filePath).pipe(res);
}

/** Delete media older than the TTL. */
export async function cleanupSelfHostedMedia(): Promise<number> {
  const dir = config.SELF_HOSTED_MEDIA_DIR;
  if (!dir) return 0;
  const cutoff = Date.now() - config.SELF_HOSTED_MEDIA_TTL_HOURS * 3600_000;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!MEDIA_NAME.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
        removed++;
      }
    } catch {}
  }
  return removed;
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startSelfHostedMediaCleanup(): void {
  if (!selfHostedMediaEnabled() || cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupSelfHostedMedia().then(
      removed =>
        removed > 0 &&
        logger.info("Removed expired self-hosted media", { removed }),
      error => logger.warn("Self-hosted media cleanup failed", { error }),
    );
  }, 3600_000);
  cleanupTimer.unref();
}
