/**
 * Rewrites Firecrawl's map query (`site:https://www.example.com/path` or
 * `<search> site:example.com`) into a form SearXNG engines understand: the
 * bare hostname, plus the path as a keyword-free inurl-less site filter.
 */
export function toSearxngMapQuery(mapQuery: string): string {
  return mapQuery.replace(/site:(\S+)/g, (_, target: string) => {
    try {
      const parsed = new URL(
        target.includes("://") ? target : `https://${target}`,
      );
      const host = parsed.hostname.replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/$/, "");
      return `site:${host}${path}`;
    } catch {
      return `site:${target}`;
    }
  });
}
