/**
 * Self-hosted open-source replacements for cloud-only features:
 *  - playwright-service screenshots, actions, mobile and location emulation
 *    (PLAYWRIGHT_EXTENDED_FEATURES)
 *  - SearXNG news and image search
 *  - map discovery without fire-engine or the index (SearXNG site: search and
 *    links on the start page)
 *  - /v2/agent backed by apps/agent-service (EXTRACT_V3_BETA_URL)
 * Scanned-PDF OCR through apps/ocr-service is covered by parse-fire-pdf.test.ts.
 */
import request from "supertest";
import { config } from "../../../config";
import {
  concurrentIf,
  HAS_AI,
  HAS_FIRE_ENGINE,
  HAS_PLAYWRIGHT,
  scrapeTimeout,
  TEST_API_URL,
  TEST_SELF_HOST,
} from "../lib";
import { Identity, idmux, map, scrape, scrapeRaw, search } from "./lib";

const HAS_EXTENDED_PLAYWRIGHT =
  TEST_SELF_HOST &&
  !HAS_FIRE_ENGINE &&
  HAS_PLAYWRIGHT &&
  !!config.PLAYWRIGHT_EXTENDED_FEATURES;
const HAS_SEARXNG = TEST_SELF_HOST && !!config.SEARXNG_ENDPOINT;
const HAS_LOCAL_AGENT =
  TEST_SELF_HOST && !!config.EXTRACT_V3_BETA_URL && HAS_AI;

// Public pages with stable content; self-hosted runs reach the internet.
const EXAMPLE = "https://example.com";
// Has no sitemap.xml, so self-hosted map relies on the new fallbacks.
const NO_SITEMAP_SITE = "https://www.iana.org";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "selfhost-oss-features",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

describe("self-hosted playwright extended features", () => {
  concurrentIf(HAS_EXTENDED_PLAYWRIGHT)(
    "screenshot format returns an image",
    async () => {
      const doc = await scrape(
        { url: EXAMPLE, formats: ["screenshot"], timeout: scrapeTimeout },
        identity,
      );
      expect(doc.screenshot).toMatch(/^data:image\/png;base64,/);
    },
    scrapeTimeout,
  );

  concurrentIf(HAS_EXTENDED_PLAYWRIGHT)(
    "full-page jpeg screenshot honors quality",
    async () => {
      const doc = await scrape(
        {
          url: EXAMPLE,
          formats: [{ type: "screenshot", fullPage: true, quality: 60 }],
          timeout: scrapeTimeout,
        },
        identity,
      );
      expect(doc.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    },
    scrapeTimeout,
  );

  concurrentIf(HAS_EXTENDED_PLAYWRIGHT)(
    "actions run in order and return their results",
    async () => {
      const doc = await scrape(
        {
          url: EXAMPLE,
          formats: ["markdown"],
          actions: [
            {
              type: "executeJavascript",
              script:
                "document.body.insertAdjacentHTML('afterbegin', '<p>Changed by action</p>'); return 41 + 1;",
            },
            { type: "wait", milliseconds: 200 },
            { type: "scrape" },
            { type: "screenshot" },
          ],
          timeout: scrapeTimeout,
        },
        identity,
      );
      expect(doc.actions?.javascriptReturns).toEqual([
        { type: "number", value: 42 },
      ]);
      expect(doc.actions?.scrapes?.[0]?.html).toContain("Changed by action");
      expect(doc.actions?.screenshots?.[0]).toMatch(/^data:image\/png;base64,/);
      // The final document reflects the page after the actions.
      expect(doc.markdown).toContain("Changed by action");
    },
    scrapeTimeout,
  );

  concurrentIf(HAS_EXTENDED_PLAYWRIGHT)(
    "mobile and location emulation reach the page",
    async () => {
      const doc = await scrape(
        {
          url: EXAMPLE,
          formats: ["markdown"],
          mobile: true,
          location: { country: "DE", languages: ["de-DE"] },
          actions: [
            {
              type: "executeJavascript",
              script:
                "return [navigator.userAgent.includes('Mobile'), navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone];",
            },
          ],
          timeout: scrapeTimeout,
        },
        identity,
      );
      expect(doc.actions?.javascriptReturns?.[0]?.value).toEqual([
        true,
        "de-DE",
        "Europe/Berlin",
      ]);
    },
    scrapeTimeout,
  );

  concurrentIf(HAS_EXTENDED_PLAYWRIGHT)(
    "a failing action fails the scrape",
    async () => {
      const raw = await scrapeRaw(
        {
          url: EXAMPLE,
          actions: [{ type: "click", selector: "#does-not-exist" }],
          timeout: scrapeTimeout,
        },
        identity,
      );
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});

describe("self-hosted SearXNG search sources", () => {
  concurrentIf(HAS_SEARXNG)(
    "news source returns news results",
    async () => {
      const data = await search(
        { query: "technology", limit: 3, sources: ["news"] },
        identity,
      );
      expect(Array.isArray(data.news)).toBe(true);
      expect(data.news!.length).toBeGreaterThan(0);
      expect(typeof data.news![0].url).toBe("string");
    },
    60000,
  );

  concurrentIf(HAS_SEARXNG)(
    "images source returns image results",
    async () => {
      const data = await search(
        { query: "mountain landscape", limit: 3, sources: ["images"] },
        identity,
      );
      expect(Array.isArray(data.images)).toBe(true);
      expect(data.images!.length).toBeGreaterThan(0);
      expect(data.images![0].imageUrl).toMatch(/^https?:\/\//);
    },
    60000,
  );
});

describe("self-hosted map discovery", () => {
  concurrentIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)(
    "maps a site that has no sitemap",
    async () => {
      const response = await map(
        { url: NO_SITEMAP_SITE, limit: 20, ignoreCache: true },
        identity,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body.links.length).toBeGreaterThan(1);
      for (const link of response.body.links) {
        expect(new URL(link.url).hostname).toMatch(/iana\.org$/);
      }
    },
    90000,
  );
});

describe("self-hosted agent", () => {
  concurrentIf(HAS_LOCAL_AGENT)(
    "runs an agent job to completion with a schema",
    async () => {
      const start = await request(TEST_API_URL)
        .post("/v2/agent")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({
          prompt: "What is this domain intended to be used for?",
          urls: [EXAMPLE],
          strictConstrainToURLs: true,
          schema: {
            type: "object",
            properties: { purpose: { type: "string" } },
            required: ["purpose"],
          },
        });
      expect(start.statusCode).toBe(200);
      expect(typeof start.body.id).toBe("string");

      let status: any;
      const deadline = Date.now() + 240000;
      do {
        await new Promise(r => setTimeout(r, 3000));
        status = (
          await request(TEST_API_URL)
            .get(`/v2/agent/${start.body.id}`)
            .set("Authorization", `Bearer ${identity.apiKey}`)
        ).body;
      } while (status.status === "processing" && Date.now() < deadline);

      expect(status.status).toBe("completed");
      expect(String(status.data.purpose).toLowerCase()).toContain("document");
    },
    300000,
  );

  concurrentIf(HAS_LOCAL_AGENT)(
    "unknown agent job returns 404",
    async () => {
      const res = await request(TEST_API_URL)
        .get("/v2/agent/019a5f0e-0000-7000-8000-00000000dead")
        .set("Authorization", `Bearer ${identity.apiKey}`);
      expect(res.statusCode).toBe(404);
    },
    30000,
  );
});
