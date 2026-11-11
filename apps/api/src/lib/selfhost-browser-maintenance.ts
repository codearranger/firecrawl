/**
 * Self-hosted browser session upkeep. In the hosted deployment the index
 * worker reconciles browser sessions with Hangar and flushes execute activity
 * to Postgres; that worker only runs with DB authentication. When the API is
 * self-hosted with a local session database (DATABASE_URL without
 * USE_DB_AUTHENTICATION) and a Hangar (HANGAR_URL), run the same two loops
 * here. Reconciliation takes a redlock, so several API processes are safe.
 */
import { config } from "../config";
import { selfHostedSessionDb } from "../db/connection";
import { reconcileBrowserSessions } from "./browser-lifecycle";
import { processBrowserSessionActivityJobs } from "./browser-session-activity";
import { logger } from "./logger";

const RECONCILE_INTERVAL_MS = 15_000;
const ACTIVITY_INTERVAL_MS = 10_000;

export function startSelfHostedBrowserMaintenance(): (() => void) | undefined {
  if (!selfHostedSessionDb || !config.HANGAR_URL) return undefined;
  logger.info("Starting self-hosted browser session maintenance");
  const reconcile = setInterval(() => {
    void reconcileBrowserSessions().catch(error =>
      logger.warn("Self-hosted browser reconcile failed", { error }),
    );
  }, RECONCILE_INTERVAL_MS);
  const activity = setInterval(() => {
    void processBrowserSessionActivityJobs().catch(error =>
      logger.warn("Self-hosted browser activity flush failed", { error }),
    );
  }, ACTIVITY_INTERVAL_MS);
  return () => {
    clearInterval(reconcile);
    clearInterval(activity);
  };
}
