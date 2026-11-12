# Open-source replacements for cloud-only features

Several Firecrawl features depend on hosted services (fire-engine, fire-pdf,
the agent backend, Gemini/Fireworks models). This fork adds open-source
replacements so a self-hosted deployment can use them with local models.

| Feature | Cloud backend | Self-hosted replacement | Enable with |
|---|---|---|---|
| `screenshot` format (viewport, full page, JPEG quality) | fire-engine | `playwright-service` (`helpers/browserFeatures.ts`) | `PLAYWRIGHT_EXTENDED_FEATURES=true` |
| `actions` (wait, click, write, press, scroll, scrape, screenshot, executeJavascript, pdf) | fire-engine | `playwright-service` | `PLAYWRIGHT_EXTENDED_FEATURES=true` |
| `mobile` emulation | fire-engine | `playwright-service` (Pixel 7 profile) | `PLAYWRIGHT_EXTENDED_FEATURES=true` |
| `location` (locale, timezone, geolocation, Accept-Language) | fire-engine + geo proxies | `playwright-service` | `PLAYWRIGHT_EXTENDED_FEATURES=true` |
| Scanned-PDF and image OCR | fire-pdf / MinerU on RunPod | `apps/ocr-service`: vision model on Ollama (default `qwen2.5vl:7b`), or a MinerU server | `FIRE_PDF_ENABLE=true`, `FIRE_PDF_BASE_URL=http://ocr-service:3010`, `FIRE_PDF_PERCENT=100`, `IMAGE_OCR_ENABLED=true` |
| Text PDF extraction | — | built-in Rust extractor (already bundled) | `PDF_RUST_EXTRACT_ENABLE=true` |
| `/v2/agent` | Firecrawl agent service | `apps/agent-service`: tool-calling loop on a local model, using this API's search and scrape | `EXTRACT_V3_BETA_URL=http://agent-service:3020`, `AGENT_INTEROP_SECRET=<random>` |
| `query` format, `/extract` reranking, deterministic JSON, other Gemini/Fireworks/Groq/Anthropic call sites | Gemini, Fireworks, Groq, Anthropic | The deployment's default model (`OPENAI_BASE_URL` + `MODEL_NAME`, or `OLLAMA_BASE_URL`) | automatic when that provider has no credentials |
| Search `sources: ["news"]` / `["images"]` | fire-engine | SearXNG `news` / `images` categories | `SEARXNG_ENDPOINT` |
| Search `includeDomains` / `excludeDomains` | fire-engine | filtered on SearXNG results | `SEARXNG_ENDPOINT` |
| `/map` on sites without a sitemap | fire-engine search + index | SearXNG `site:` search and the links on the start page | automatic without fire-engine |
| Browser sessions (`/v2/browser`: create, execute node/python/bash, CDP, live view, recording, profiles) | Hangar | `apps/hangar`: one sandbox container per session | `HANGAR_URL=http://hangar:3040`, `DATABASE_URL` (session tables), `HANGAR_PUBLIC_URL` |
| `/v2/scrape/:id/interact` (code and prompt) | Hangar + Gemini | Hangar, plus the browser agent on `LOCAL_FALLBACK_MODEL_NAME` | same as above |

`docker-compose.yaml` turns all of these on by default; each variable can be
overridden in `.env`.

**Screenshots and action PDFs are returned as links**, like the hosted API's
media URLs, instead of inline base64 (which is 100 KB+ per image and
overflows LLM/MCP tool output). They are stored under `SELF_HOSTED_MEDIA_DIR`
(compose: the `media` volume), served by `GET /v2/media/<random>.png` and
deleted after `SELF_HOSTED_MEDIA_TTL_HOURS` (24). Set
`SELF_HOSTED_MEDIA_PUBLIC_URL` to the API address clients use. Names are
unguessable and need no API key; zero-data-retention scrapes stay inline. Set
`SELF_HOSTED_MEDIA_DIR=` (empty) to keep inline data everywhere.

## Not covered

- **Browser session suspend/resume and proxy country selection.** Hangar
  sessions run until stopped, idle or expired; `location.country` on a
  session is accepted but egress uses the deployment's `PROXY_SERVER`.
- **Stealth proxies, CAPTCHA solving, TLS fingerprinting** (fire-engine's
  anti-bot stack). Use `PROXY_SERVER` for a proxy; a geo-specific exit for
  `location` needs a proxy in that country.
- **`branding` format**, Wikipedia/X engines (need paid APIs).
- **Agent threads, exchange, skills and snapshots.** The agent service runs
  one-shot jobs; `threadId` returns `threads_disabled`. Runs are kept in memory
  for 24 hours and are lost when the service restarts.

## Services

### ocr-service (`apps/ocr-service`)

Speaks the synchronous fire-pdf API (`POST /ocr`). For each page it uses the
PDF text layer when present (unless `mode: "ocr"`), and otherwise renders the
page and asks a vision model for Markdown.

| Variable | Default | |
|---|---|---|
| `OCR_BACKEND` | `ollama` | `ollama` or `mineru` |
| `OCR_OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama base URL |
| `OCR_MODEL` | `qwen2.5vl:7b` | any Ollama vision model |
| `OCR_CONCURRENCY` | `2` | pages OCRed in parallel |
| `MINERU_URL` | — | a `mineru-api` server, for `OCR_BACKEND=mineru` |
| `OCR_API_KEY` | — | shared secret; sent by the API as `FIRE_PDF_API_KEY` |

Tests: `docker run --rm --user root --entrypoint sh <image> -c "pip install pytest && python -m pytest test_app.py"`.

### agent-service (`apps/agent-service`)

Implements `POST/GET/DELETE /internal/extracts[/:id]` (plus `/trace`). The
model gets `web_search`, `scrape_url` and `finish` tools; the final answer is
produced with structured output against the request's `schema`. With
`strictConstrainToURLs`, search is disabled and only the given hosts can be
scraped. Webhooks (`started`, `completed`, `failed`) are delivered directly,
signed with `SELF_HOSTED_WEBHOOK_HMAC_SECRET` when it is set.

| Variable | Default | |
|---|---|---|
| `AGENT_INTEROP_SECRET` | — (required) | shared with the API |
| `AGENT_LLM_BASE_URL` | `OPENAI_BASE_URL` | OpenAI-compatible chat endpoint |
| `AGENT_MODEL` | `ministral-3:14b` | needs tool calling; non-thinking models are much faster |
| `AGENT_MAX_STEPS` | `12` | tool calls per run |
| `AGENT_REASONING_EFFORT` | `none` (compose) | sent as `reasoning_effort`; `none` turns thinking off on thinking models |

The API skips its Bigtable job-access check for agent jobs when
`USE_DB_AUTHENTICATION` is off and `BIGTABLE_JOB_ACCESS_TABLE` is unset.

### playwright-service extensions

`POST /scrape` accepts `screenshot` (`{fullPage, quality, viewport}`),
`actions`, `mobile` and `location` and returns `screenshot` and `actions`
(`screenshots`, `scrapes`, `javascriptReturns`, `pdfs`). Screenshots and PDFs
are returned as `data:` URLs since there is no media bucket. The API only sends
these fields when `PLAYWRIGHT_EXTENDED_FEATURES=true`, so an older service
keeps working.

## Tests

`apps/api/src/__tests__/snips/v2/selfhost-oss-features.test.ts` covers the
features above against a running stack (`TEST_SUITE_SELF_HOSTED=true`).

## Hangar: browser sessions and interact (`apps/hangar`)

A self-hosted implementation of the browser service the API calls through
`HANGAR_URL` (contract: `apps/api/src/lib/hangar.ts`).

```
Firecrawl API ──HTTP──▶ hangar (controller) ──Docker API──▶ hangar-docker-proxy ──▶ docker.sock
     │                     │  public gateway :3030 (CDP, live view, recordings)
     │                     ▼
     │            sandbox container per session (internal network only)
     │              Chromium · node/python Playwright · agent-browser · ffmpeg
     │                     │
     └── session tables    └──▶ hangar-egress (SSRF guard) ──▶ PROXY_SERVER ──▶ internet
         in nuq-postgres
```

**Sandbox isolation.** Each session is its own container from
`firecrawl-hangar-sandbox`, started with: a non-root user, every capability
dropped, `no-new-privileges`, a read-only root filesystem (`/tmp` is a tmpfs),
memory/CPU/PID limits, and only the internal `hangar-sandbox` network. The
egress proxy is the only way out, and it refuses private, loopback and
link-local targets, so session code cannot reach the LAN, the Firecrawl
services or cloud metadata. Chromium's debugging port listens on
127.0.0.1 inside the container; the sandbox agent requires a per-session
token, and the controller refuses requests from the sandbox subnet. For a
stronger boundary, install gVisor and set `HANGAR_SANDBOX_RUNTIME=runsc`.

The controller reaches Docker only through `docker-socket-proxy` (container
endpoints only). That proxy can still create containers, so treat the
controller as privileged: its API (port 3040) is not published to the host.

**What a session provides**

- `execute`: `node` (Playwright with mutable `page`/`context`/`browser` and
  top-level await; a `return` value becomes `result`), `python` (async
  Playwright, set `result`), `bash` (with `agent-browser` attached). The page
  the code ends on is the next run's `page`.
- `cdpUrl`: `ws://…/cdp/<id>/<token>` for `playwright.chromium.connectOverCDP`
  or Puppeteer.
- `liveViewUrl` / `interactiveLiveViewUrl`: a browser page streaming the
  screen; the interactive one forwards mouse, keyboard and navigation.
- `recordSession`: HLS recording, served by `GET /v2/browser/:id/replay`.
- `profile: {name, saveChanges}`: Chromium profile (cookies, storage)
  persisted per team on the `hangar-data` volume; `saveChanges: false` starts
  from a copy.
- `blockAds`: uBlock Origin Lite.
- Lifetime (`ttl`) and idle (`activityTtl`) limits, enforced by the
  controller every 5 seconds.

**Setup**

```bash
docker compose --profile build build hangar-sandbox   # sandbox image
docker compose up -d hangar-db-init hangar hangar-egress hangar-docker-proxy api
```

| Variable | Default | |
|---|---|---|
| `HANGAR_PUBLIC_URL` | `http://localhost:3030` | how clients reach the gateway (CDP and live view URLs) |
| `HANGAR_PUBLIC_PORT` | `3030` | host port for the gateway |
| `HANGAR_MAX_SESSIONS` | `4` | concurrent sandboxes |
| `HANGAR_SANDBOX_MEMORY_MB` / `HANGAR_SANDBOX_CPUS` | `2048` / `1.5` | per sandbox |
| `HANGAR_SANDBOX_RUNTIME` | — | e.g. `runsc` |
| `SELF_HOSTED_BROWSER_CONCURRENCY` | `10` | API-side cap when DB auth is off |
| `LOCAL_FALLBACK_MODEL_NAME` | `ministral-3:14b` (compose) | model for the interact agent and other rerouted features |
| `LOCAL_FALLBACK_REASONING_EFFORT` | `none` (compose) | sent as `reasoning_effort` on rerouted calls; `none` turns thinking off on gemma4/qwen3.x |

Without DB authentication the API keeps browser sessions in the
`browser_sessions`, `browser_profiles` and `browser_session_activities` tables
(`apps/hangar/sessions-db.sql`, created by `hangar-db-init`) via
`DATABASE_URL`, reconciles them with Hangar from the API process, and keeps
each scrape's replay context in Redis for 24 hours so interact can replay it.

