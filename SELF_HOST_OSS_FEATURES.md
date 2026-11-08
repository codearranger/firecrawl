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

`docker-compose.yaml` turns all of these on by default; each variable can be
overridden in `.env`.

## Not covered

- **Browser sessions and `/v2/scrape/:id/interact`.** The upstream backend
  ("Hangar") also needs DB authentication (`USE_DB_AUTHENTICATION=true` with
  the `browser_sessions` tables), a CDP endpoint reachable by clients, and a
  code-execution runtime. Not implemented here.
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
