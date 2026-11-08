/**
 * URL discovery for /map when fire-engine search and the Firecrawl index are
 * not available (self-hosted). Two open-source-backed sources:
 *  - SearXNG `site:` search (if SEARXNG_ENDPOINT is set)
 *  - links found on the start page itself (fetch, then playwright)
 */
import { config } from "../config";
import { scrapeOptions, ScrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import { Engine } from "../scraper/scrapeURL/engines";
import { searxng_search } from "../search/searxng";
import { CostTracking } from "./cost-tracking";
import type { WebCrawler } from "../scraper/WebScraper/crawler";
import { logger as _logger } from "./logger";
import { toSearxngMapQuery } from "./map-searxng-query";

export { toSearxngMapQuery };

export function canUseSearxngForMap(): boolean {
  return !!config.SEARXNG_ENDPOINT;
}

export async function searxngMapSearch(
  mapQuery: string,
  numResults: number,
  page: number,
): Promise<{ url: string; title?: string; description?: string }[]> {
  try {
    return await searxng_search(toSearxngMapQuery(mapQuery), {
      num_results: numResults,
      page,
    });
  } catch (error) {
    _logger.warn("SearXNG map search failed", { error });
    return [];
  }
}

/**
 * Scrape the start URL and return the links on it. Used when sitemaps,
 * search and the index together found fewer URLs than requested.
 */
export async function discoverLinksFromPage({
  url,
  crawler,
  abort,
  zeroDataRetention,
  location,
  headers,
  timeoutMs = 20000,
}: {
  url: string;
  crawler: WebCrawler;
  abort?: AbortSignal;
  zeroDataRetention: boolean;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<string[]> {
  const forceEngine: Engine[] = [
    "fetch",
    ...(config.PLAYWRIGHT_MICROSERVICE_URL ? ["playwright" as const] : []),
  ];
  try {
    const response = await scrapeURL(
      "map-links;" + crypto.randomUUID(),
      url,
      scrapeOptions.parse({
        formats: ["rawHtml"],
        timeout: timeoutMs,
        ...(location ? { location } : {}),
        ...(headers ? { headers } : {}),
      }),
      {
        forceEngine,
        v0DisableJsDom: true,
        orgId: null,
        externalAbort: abort
          ? {
              signal: abort,
              tier: "external",
              throwable() {
                return new Error("Map link discovery aborted");
              },
            }
          : undefined,
        teamId: "map-links",
        zeroDataRetention,
      },
      new CostTracking(),
    );
    if (!response.success || !response.document.rawHtml) {
      return [];
    }
    const landed = response.document.metadata.url ?? url;
    const links = await crawler.extractLinksFromContent(
      response.document.rawHtml,
      landed,
      response.document.metadata.contentType,
    );
    return [landed, ...links];
  } catch (error) {
    _logger.warn("Map link discovery failed", { error, url });
    return [];
  }
}
