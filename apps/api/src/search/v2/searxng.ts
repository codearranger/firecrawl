import axios from "axios";
import { config } from "../../config";
import {
  SearchResultType,
  SearchV2Response,
  WebSearchResult,
} from "../../lib/entities";
import { logger } from "../../lib/logger";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  num_results: number;
  page?: number;
  type?: SearchResultType | SearchResultType[];
}

type ImageResult = NonNullable<SearchV2Response["images"]>[number];
type NewsResult = NonNullable<SearchV2Response["news"]>[number];

// Google-style tbs recency (qdr:d/w/m/y) -> SearXNG time_range.
const TBS_TIME_RANGE: Record<string, string> = {
  "qdr:d": "day",
  "qdr:w": "week",
  "qdr:m": "month",
  "qdr:y": "year",
};

export function tbsToTimeRange(tbs: string | undefined): string | undefined {
  if (!tbs) return undefined;
  const match = tbs.match(/qdr:[dwmy]/);
  return match ? TBS_TIME_RANGE[match[0]] : undefined;
}

function parseResolution(resolution: unknown): {
  width?: number;
  height?: number;
} {
  if (typeof resolution !== "string") return {};
  const match = resolution.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function mapSearxngWeb(results: any[]): WebSearchResult[] {
  return results.map(a => ({
    url: a.url,
    title: a.title,
    description: a.content,
  }));
}

export function mapSearxngNews(results: any[]): NewsResult[] {
  return results.map((a, i) => ({
    url: a.url,
    title: a.title,
    snippet: a.content,
    date: a.publishedDate ?? a.pubdate ?? undefined,
    imageUrl: a.img_src || a.thumbnail || undefined,
    position: i + 1,
  }));
}

export function mapSearxngImages(results: any[]): ImageResult[] {
  return results
    .map((a, i) => {
      const { width, height } = parseResolution(a.resolution);
      return {
        title: a.title,
        imageUrl: a.img_src || a.thumbnail_src || undefined,
        imageWidth: width,
        imageHeight: height,
        url: a.url,
        position: i + 1,
      };
    })
    .filter(r => !!r.imageUrl);
}

function normalizeTypes(
  type: SearchResultType | SearchResultType[] | undefined,
): SearchResultType[] {
  if (!type) return ["web"];
  return Array.isArray(type) ? type : [type];
}

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;
  const timeRange = tbsToTimeRange(options.tbs);

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const fetchPage = async (
    page: number,
    category: "web" | "news" | "images",
  ): Promise<any[]> => {
    const params = {
      q: q,
      language: options.lang,
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      // SEARXNG_ENGINES usually names general web engines, which return
      // nothing for the news/images categories, so only apply it to web.
      engines: category === "web" ? (config.SEARXNG_ENGINES ?? "") : "",
      categories:
        category === "web" ? (config.SEARXNG_CATEGORIES ?? "") : category,
      pageno: page,
      format: "json",
      ...(timeRange ? { time_range: timeRange } : {}),
      // 2 = strict; omitted otherwise so the instance default applies
      ...(options.safe ? { safesearch: 2 } : {}),
    };

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;
    return data && Array.isArray(data.results) ? data.results : [];
  };

  const collect = async (
    category: "web" | "news" | "images",
  ): Promise<any[]> => {
    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / resultsPerPage),
    );
    let results: any[] = [];
    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      const pageResults = await fetchPage(startPage + pageOffset, category);
      if (pageResults.length === 0) {
        break;
      }
      results = results.concat(pageResults);
      if (results.length >= requestedResults) {
        break;
      }
    }
    return results.slice(0, requestedResults);
  };

  if (requestedResults === 0) {
    return {};
  }

  const response: SearchV2Response = {};
  for (const type of normalizeTypes(options.type)) {
    try {
      if (type === "web") {
        const web = mapSearxngWeb(await collect("web"));
        if (web.length > 0) response.web = web;
      } else if (type === "news") {
        const news = mapSearxngNews(await collect("news"));
        if (news.length > 0) response.news = news;
      } else if (type === "images") {
        const images = mapSearxngImages(await collect("images"));
        if (images.length > 0) response.images = images;
      }
    } catch (error) {
      logger.error(`There was an error searching SearXNG`, { error, type });
    }
  }
  return response;
}
