/**
 * Self-hosted stand-in for the Bigtable scrape state that interact reads.
 *
 * `/v2/scrape/:jobId/interact` needs to know which team owns a scrape and how
 * to replay it (URL, waitFor, actions). The hosted API keeps that in Bigtable;
 * self-hosted deployments without Bigtable and without DB authentication keep
 * a small Redis record instead, for the same 24 hours. Zero-data-retention
 * scrapes are never stored.
 */
import { config } from "../config";
import { redisEvictConnection } from "../services/redis";
import type { ScrapeReplayContext } from "./scrape-interact/scrape-replay";

const RETENTION_SECONDS = 24 * 60 * 60;
const key = (id: string) => `selfhost:scrape-replay:${id}`;

export type SelfHostedScrapeReplay = {
  teamId: string;
  replay: ScrapeReplayContext;
  completedAtMs: number;
};

export function selfHostedReplayEnabled(): boolean {
  return !config.USE_DB_AUTHENTICATION && !config.BIGTABLE_SCRAPE_STATE_TABLE;
}

export async function writeSelfHostedScrapeReplay(
  id: string,
  record: SelfHostedScrapeReplay,
): Promise<void> {
  if (!selfHostedReplayEnabled()) return;
  await redisEvictConnection.set(
    key(id),
    JSON.stringify(record),
    "EX",
    RETENTION_SECONDS,
  );
}

export async function readSelfHostedScrapeReplay(
  id: string,
): Promise<SelfHostedScrapeReplay | null> {
  if (!selfHostedReplayEnabled()) return null;
  const raw = await redisEvictConnection.get(key(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SelfHostedScrapeReplay;
  } catch {
    return null;
  }
}
