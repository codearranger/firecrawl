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
          // example.com times out for mobile user agents over some proxies.
          url: "https://www.iana.org",
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

describe("self-hosted browser sessions (Hangar)", () => {
  const HAS_HANGAR = TEST_SELF_HOST && !!config.HANGAR_URL;
  const auth = () => `Bearer ${identity.apiKey}`;
  const exec = (id: string, body: Record<string, unknown>) =>
    request(TEST_API_URL)
      .post(`/v2/browser/${id}/execute`)
      .set("Authorization", auth())
      .send(body);

  concurrentIf(HAS_HANGAR)(
    "creates a session and runs node, python and bash in it",
    async () => {
      const created = await request(TEST_API_URL)
        .post("/v2/browser")
        .set("Authorization", auth())
        .send({ ttl: 120, activityTtl: 60 });
      expect(created.statusCode).toBe(200);
      expect(created.body.cdpUrl).toMatch(/^wss?:\/\//);
      expect(created.body.liveViewUrl).toMatch(/^https?:\/\//);
      const id = created.body.id;
      try {
        const node = await exec(id, {
          language: "node",
          code: "return 6 * 7;",
        });
        expect(node.body.exitCode).toBe(0);
        expect(node.body.result).toBe("42");

        const python = await exec(id, {
          language: "python",
          code: "print('py', 1 + 1)",
        });
        expect(python.body.stdout).toContain("py 2");

        const bash = await exec(id, {
          language: "bash",
          code: "agent-browser get url",
        });
        expect(bash.body.exitCode).toBe(0);
        expect(bash.body.stdout).toContain("about:blank");

        // Sandboxes reach the internet only through the egress proxy, which
        // refuses private addresses.
        const lan = await exec(id, {
          language: "node",
          code: "const r = await page.goto('http://10.0.0.1/', { timeout: 20000 }); return r.status();",
          timeout: 40,
        });
        expect(lan.body.result).toBe("403");
      } finally {
        await request(TEST_API_URL)
          .delete(`/v2/browser/${id}`)
          .set("Authorization", auth());
      }
    },
    180000,
  );

  concurrentIf(HAS_HANGAR)(
    "a stopped session refuses execution",
    async () => {
      const created = await request(TEST_API_URL)
        .post("/v2/browser")
        .set("Authorization", auth())
        .send({ ttl: 60, activityTtl: 30 });
      const id = created.body.id;
      await request(TEST_API_URL)
        .delete(`/v2/browser/${id}`)
        .set("Authorization", auth());
      const res = await exec(id, { language: "node", code: "return 1" });
      expect(res.statusCode).toBe(410);
    },
    120000,
  );

  concurrentIf(HAS_HANGAR)(
    "interact replays a scrape in a new session",
    async () => {
      const doc = await scrape(
        {
          url: "https://www.iana.org/domains/reserved",
          timeout: scrapeTimeout,
        },
        identity,
      );
      const scrapeId = doc.metadata.scrapeId;
      const res = await request(TEST_API_URL)
        .post(`/v2/scrape/${scrapeId}/interact`)
        .set("Authorization", auth())
        .send({ code: "console.log(page.url())", timeout: 60 });
      expect(res.statusCode).toBe(200);
      expect(res.body.stdout).toContain("iana.org/domains/reserved");
      await request(TEST_API_URL)
        .delete(`/v2/scrape/${scrapeId}/interact`)
        .set("Authorization", auth());
    },
    240000,
  );

  concurrentIf(HAS_HANGAR)(
    "interact on an unknown scrape is 404",
    async () => {
      const res = await request(TEST_API_URL)
        .post("/v2/scrape/019a5f0e-0000-7000-8000-00000000beef/interact")
        .set("Authorization", auth())
        .send({ code: "console.log(1)" });
      expect(res.statusCode).toBe(404);
    },
    30000,
  );
});
