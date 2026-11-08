import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { filterByDomains } from "./domain-filter";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  usOnly = false,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  usOnly?: boolean;
}): Promise<SearchV2Response> {
  // The fallback backends below take no US-only routing.
  if (usOnly && !config.FIRE_ENGINE_BETA_URL) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
        usOnly,
      });

      return results;
    }

    // includeDomains/excludeDomains reach the fallback providers as the
    // site: chain baked into the query; SearXNG results are also filtered
    // here since many of its engines ignore site: operators.
    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const results = filterByDomains(
        await searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
          safe,
          type,
        }),
        includeDomains,
        excludeDomains,
      );
      if (
        (results.web && results.web.length > 0) ||
        (results.news && results.news.length > 0) ||
        (results.images && results.images.length > 0)
      )
        return results;
    }

    logger.info("Using DuckDuckGo search");
    const ddgResults = await ddgSearch(query, num_results, {
      tbs,
      lang,
      country,
      proxy,
      timeout,
    });
    if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
