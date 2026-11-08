import { config } from "../config";
import { isUuidV7Id } from "./bigtable-row-key";
import { logger } from "./logger";
import {
  readApiJobAccess,
  type ApiJobAccess,
  type ApiJobKind,
} from "./job-access-store";

type OperationalJobAccess = {
  teamId: string;
  kind: ApiJobKind;
  clientOrigin?: string;
  expiresAtMs: number;
  zeroDataRetentionMinutes?: number;
};

/**
 * Who owns a job and until when it may be fetched, from the Bigtable job
 * access row that logRequest (and, for crawl and batch children, logScrape)
 * writes. A missing or expired row is the documented end of the job's
 * fetchable life; there is no other store to ask. A failed read is an
 * outage, not a missing job: it is rethrown so the caller answers an error
 * rather than a 404 for a job that exists.
 */
async function resolveOperationalJobAccess(params: {
  id: string;
  kinds: readonly ApiJobKind[];
}): Promise<OperationalJobAccess | null> {
  // An id that is not a UUIDv7 names no row: not found, not an outage.
  if (!isUuidV7Id(params.id)) return null;
  let access: ApiJobAccess | null;
  try {
    access = await readApiJobAccess(params.id);
  } catch (error) {
    logger.error("Bigtable job access read failed", {
      error,
      jobId: params.id,
    });
    throw error;
  }
  if (!access) return null;
  return params.kinds.includes(access.kind) ? access : null;
}

export function getScrapeJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["scrape"] });
}

export function getExtractJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["extract", "agent"] });
}

/** How long a self-hosted agent job stays fetchable (matches the default). */
const SELF_HOSTED_AGENT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

export function getAgentJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  // Self-hosted without DB auth or Bigtable: there is a single "bypass"
  // team and no job-access store, so ownership is not tracked. The agent
  // service (EXTRACT_V3_BETA_URL) is the source of truth for whether the
  // job exists, like /v2/extract/:id in the same mode.
  if (!config.USE_DB_AUTHENTICATION && !config.BIGTABLE_JOB_ACCESS_TABLE) {
    if (!isUuidV7Id(id)) return Promise.resolve(null);
    return Promise.resolve({
      teamId: "bypass",
      kind: "agent",
      expiresAtMs: Date.now() + SELF_HOSTED_AGENT_ACCESS_TTL_MS,
    });
  }
  return resolveOperationalJobAccess({ id, kinds: ["agent"] });
}

export function getCrawlJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["crawl", "batch_scrape"] });
}
