import {
  mapSearxngImages,
  mapSearxngNews,
  mapSearxngWeb,
  tbsToTimeRange,
} from "./searxng";
import { filterByDomains } from "./domain-filter";

describe("searxng result mapping", () => {
  it("maps web results", () => {
    expect(
      mapSearxngWeb([
        { url: "https://a.test", title: "A", content: "about a" },
      ]),
    ).toEqual([{ url: "https://a.test", title: "A", description: "about a" }]);
  });

  it("maps news results with date and image", () => {
    expect(
      mapSearxngNews([
        {
          url: "https://n.test/1",
          title: "N",
          content: "snippet",
          publishedDate: "2026-11-08T00:00:00",
          thumbnail: "https://n.test/t.jpg",
        },
      ]),
    ).toEqual([
      {
        url: "https://n.test/1",
        title: "N",
        snippet: "snippet",
        date: "2026-11-08T00:00:00",
        imageUrl: "https://n.test/t.jpg",
        position: 1,
      },
    ]);
  });

  it("maps image results, parses resolution and drops results with no image", () => {
    expect(
      mapSearxngImages([
        {
          url: "https://p.test",
          title: "P",
          img_src: "https://p.test/i.png",
          resolution: "800 x 600",
        },
        {
          url: "https://q.test",
          title: "Q",
          thumbnail_src: "https://q.test/t.png",
        },
        { url: "https://r.test", title: "R" },
      ]),
    ).toEqual([
      {
        title: "P",
        imageUrl: "https://p.test/i.png",
        imageWidth: 800,
        imageHeight: 600,
        url: "https://p.test",
        position: 1,
      },
      {
        title: "Q",
        imageUrl: "https://q.test/t.png",
        imageWidth: undefined,
        imageHeight: undefined,
        url: "https://q.test",
        position: 2,
      },
    ]);
  });

  it("converts tbs recency to time_range", () => {
    expect(tbsToTimeRange("qdr:w")).toBe("week");
    expect(tbsToTimeRange("sbd:1,qdr:m")).toBe("month");
    expect(tbsToTimeRange("cdr:1")).toBeUndefined();
    expect(tbsToTimeRange(undefined)).toBeUndefined();
  });
});

describe("filterByDomains", () => {
  const results = {
    web: [
      { url: "https://firecrawl.dev/a", title: "a", description: "" },
      { url: "https://docs.firecrawl.dev/b", title: "b", description: "" },
      { url: "https://other.test/c", title: "c", description: "" },
    ],
  };

  it("keeps only included domains and their subdomains", () => {
    expect(
      filterByDomains(results, ["firecrawl.dev"]).web!.map((r: any) => r.url),
    ).toEqual(["https://firecrawl.dev/a", "https://docs.firecrawl.dev/b"]);
  });

  it("drops excluded domains", () => {
    expect(
      filterByDomains(results, undefined, ["docs.firecrawl.dev"]).web!.map(
        (r: any) => r.url,
      ),
    ).toEqual(["https://firecrawl.dev/a", "https://other.test/c"]);
  });

  it("is a no-op without filters", () => {
    expect(filterByDomains(results)).toBe(results);
  });
});
