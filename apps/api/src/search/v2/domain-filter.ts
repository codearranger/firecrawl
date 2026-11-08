import { SearchV2Response } from "../../lib/entities";

function hostMatches(url: string | undefined, domains: string[]): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some(d => {
    const domain = d.toLowerCase().replace(/^www\./, "");
    return (
      host === domain || host.endsWith("." + domain) || host === "www." + domain
    );
  });
}

/** Apply includeDomains/excludeDomains to every result list. */
export function filterByDomains(
  results: SearchV2Response,
  includeDomains?: string[],
  excludeDomains?: string[],
): SearchV2Response {
  const include = includeDomains?.filter(Boolean) ?? [];
  const exclude = excludeDomains?.filter(Boolean) ?? [];
  if (include.length === 0 && exclude.length === 0) return results;
  const keep = (url: string | undefined) =>
    (include.length === 0 || hostMatches(url, include)) &&
    !(exclude.length > 0 && hostMatches(url, exclude));
  const out: SearchV2Response = { ...results };
  if (results.web) out.web = results.web.filter(r => keep(r.url));
  if (results.news) out.news = results.news.filter(r => keep(r.url));
  if (results.images) out.images = results.images.filter(r => keep(r.url));
  return out;
}
