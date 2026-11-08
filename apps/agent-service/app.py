"""
Self-hosted agent backend for Firecrawl's /v2/agent.

Implements the internal contract the API calls through EXTRACT_V3_BETA_URL:

  POST   /internal/extracts        start a run   (body built by controllers/v2/agent.ts)
  GET    /internal/extracts/{id}   run status    (lib/extract-v3-status.ts)
  DELETE /internal/extracts/{id}   cancel        (controllers/v2/agent-cancel.ts)

All requests must carry `Authorization: Bearer ${AGENT_INTEROP_SECRET}`.

A run is a tool-calling loop on an OpenAI-compatible chat endpoint (Ollama,
vLLM, llama.cpp server, ...). The model researches with two tools backed by
the Firecrawl API itself (/v2/search and /v2/scrape, called with
__agentInterop so sub-requests are attributed to the run), then the answer is
produced with a structured-output call against the caller's JSON schema.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("agent-service")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

AGENT_INTEROP_SECRET = os.environ.get("AGENT_INTEROP_SECRET", "")
FIRECRAWL_API_URL = os.environ.get("FIRECRAWL_API_URL", "http://api:3002").rstrip("/")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://ollama:11434/v1").rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "ollama")
AGENT_MODEL = os.environ.get("AGENT_MODEL", "ministral-3:14b")
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "12"))
MAX_PAGE_CHARS = int(os.environ.get("AGENT_MAX_PAGE_CHARS", "12000"))
LLM_TIMEOUT_S = float(os.environ.get("AGENT_LLM_TIMEOUT_S", "300"))
RUN_TIMEOUT_S = float(os.environ.get("AGENT_RUN_TIMEOUT_S", "900"))
RESULT_TTL_S = int(os.environ.get("AGENT_RESULT_TTL_S", str(24 * 3600)))
MAX_CONCURRENT_RUNS = int(os.environ.get("AGENT_MAX_CONCURRENT_RUNS", "2"))
# Credits reported back per tool call (informational in self-hosted mode).
CREDITS_PER_SEARCH = 2
CREDITS_PER_SCRAPE = 1

app = FastAPI(title="firecrawl-agent-service")
_run_slots = asyncio.Semaphore(MAX_CONCURRENT_RUNS)


@dataclass
class Run:
    id: str
    request: dict[str, Any]
    status: str = "processing"  # processing | success | failed | cancelled
    data: Any = None
    error: Optional[str] = None
    credits_used: int = 0
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    events: list[dict[str, Any]] = field(default_factory=list)
    task: Optional[asyncio.Task] = None

    def public(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "success": True,
            "id": self.id,
            "status": "failed" if self.status == "cancelled" else self.status,
            "model": self.request.get("model") or "spark-2",
            "creditsUsed": self.credits_used,
        }
        if self.request.get("effort"):
            body["effort"] = self.request["effort"]
        if self.status == "success":
            body["data"] = self.data
        if self.error:
            body["error"] = self.error
        if self.completed_at:
            body["completedAt"] = datetime.fromtimestamp(
                self.completed_at, tz=timezone.utc
            ).isoformat()
        return body


RUNS: dict[str, Run] = {}


def _check_auth(authorization: Optional[str]) -> None:
    if not AGENT_INTEROP_SECRET:
        raise HTTPException(503, "AGENT_INTEROP_SECRET is not configured")
    expected = f"Bearer {AGENT_INTEROP_SECRET}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(401, "unauthorized")


def _gc() -> None:
    now = time.time()
    for run_id in [
        r.id
        for r in RUNS.values()
        if r.completed_at and now - r.completed_at > RESULT_TTL_S
    ]:
        RUNS.pop(run_id, None)


# --------------------------------------------------------------------------
# Tools (backed by the Firecrawl API)
# --------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web. Returns titles, URLs and snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {
                        "type": "integer",
                        "description": "Number of results (1-10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scrape_url",
            "description": "Fetch a web page and return its content as Markdown.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finish",
            "description": (
                "Call when you have gathered enough information to answer the "
                "task. Summarize every relevant fact you found in `notes`."
            ),
            "parameters": {
                "type": "object",
                "properties": {"notes": {"type": "string"}},
                "required": ["notes"],
            },
        },
    },
]


class Firecrawl:
    def __init__(self, client: httpx.AsyncClient, run: Run):
        self.client = client
        self.run = run
        api_key = run.request.get("apiKey") or "self-hosted"
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def _interop(self) -> dict[str, Any]:
        return {
            "__agentInterop": {
                "auth": AGENT_INTEROP_SECRET,
                "requestId": self.run.id,
                "shouldBill": False,
            }
        }

    async def search(self, query: str, limit: int = 5) -> str:
        limit = max(1, min(int(limit or 5), 10))
        body: dict[str, Any] = {"query": query, "limit": limit, **self._interop()}
        if self.run.request.get("location"):
            body["location"] = self.run.request["location"].get("country")
        resp = await self.client.post(
            f"{FIRECRAWL_API_URL}/v2/search", json=body, headers=self.headers, timeout=60
        )
        resp.raise_for_status()
        self.run.credits_used += CREDITS_PER_SEARCH
        results = (resp.json().get("data") or {}).get("web") or []
        if not results:
            return "No results."
        return "\n".join(
            f"{i + 1}. {r.get('title', '')}\n   {r.get('url', '')}\n   {r.get('description', '')}"
            for i, r in enumerate(results)
        )

    async def scrape(self, url: str) -> str:
        body = {
            "url": url,
            "formats": ["markdown"],
            "onlyMainContent": True,
            **self._interop(),
        }
        resp = await self.client.post(
            f"{FIRECRAWL_API_URL}/v2/scrape", json=body, headers=self.headers, timeout=120
        )
        self.run.credits_used += CREDITS_PER_SCRAPE
        payload = resp.json()
        if resp.status_code >= 400 or not payload.get("success"):
            return f"Failed to scrape {url}: {payload.get('error', resp.status_code)}"
        markdown = (payload.get("data") or {}).get("markdown") or ""
        if len(markdown) > MAX_PAGE_CHARS:
            markdown = markdown[:MAX_PAGE_CHARS] + "\n\n[...truncated]"
        return markdown or "(empty page)"


# --------------------------------------------------------------------------
# LLM
# --------------------------------------------------------------------------


async def chat(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    resp = await client.post(
        f"{LLM_BASE_URL}/chat/completions",
        json={"model": AGENT_MODEL, "temperature": 0, **body},
        headers={"Authorization": f"Bearer {LLM_API_KEY}"},
        timeout=LLM_TIMEOUT_S,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]


def system_prompt(req: dict[str, Any]) -> str:
    urls = req.get("urls") or []
    lines = [
        "You are a web research agent. Use the tools to find accurate, "
        "current information that answers the user's task. Prefer primary "
        "sources. Do not invent facts: everything in your notes must come "
        "from pages you searched or scraped.",
        f"You have at most {MAX_STEPS} tool calls. Call `finish` with detailed "
        "notes (including source URLs) as soon as you can answer.",
    ]
    if urls:
        lines.append("Start with these URLs: " + ", ".join(urls))
    if req.get("strictConstrainToURLs") and urls:
        lines.append(
            "Only use the URLs listed above (and pages on the same sites). "
            "Do not use web_search."
        )
    if req.get("schema"):
        lines.append(
            "The final answer must fit this JSON schema, so collect every "
            "field it asks for:\n" + json.dumps(req["schema"])
        )
    return "\n\n".join(lines)


def _allowed_url(req: dict[str, Any], url: str) -> bool:
    if not (req.get("strictConstrainToURLs") and req.get("urls")):
        return True
    host = httpx.URL(url).host
    return any(httpx.URL(u).host == host for u in req["urls"])


async def research(client: httpx.AsyncClient, run: Run) -> str:
    req = run.request
    fc = Firecrawl(client, run)
    strict = bool(req.get("strictConstrainToURLs") and req.get("urls"))
    tools = [t for t in TOOLS if not (strict and t["function"]["name"] == "web_search")]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(req)},
        {"role": "user", "content": req["prompt"]},
    ]
    gathered: list[str] = []

    for step in range(MAX_STEPS):
        msg = await chat(client, messages=messages, tools=tools)
        calls = msg.get("tool_calls") or []
        messages.append(
            {"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls}
            if calls
            else {"role": "assistant", "content": msg.get("content") or ""}
        )
        if not calls:
            # The model answered in prose instead of calling finish.
            return (msg.get("content") or "") + "\n\n" + "\n\n".join(gathered)

        for call in calls:
            name = call["function"]["name"]
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            run.events.append({"step": step, "tool": name, "args": args, "at": time.time()})
            log.info("run=%s step=%d tool=%s args=%s", run.id, step, name, args)

            if name == "finish":
                return (args.get("notes") or "") + "\n\n" + "\n\n".join(gathered)
            if name == "web_search" and not strict:
                result = await fc.search(args.get("query", req["prompt"]), args.get("limit", 5))
            elif name == "scrape_url":
                url = args.get("url", "")
                if not _allowed_url(req, url):
                    result = f"Not allowed: {url} is outside the permitted URLs."
                else:
                    result = await fc.scrape(url)
                    gathered.append(f"Source: {url}\n{result[:4000]}")
            else:
                result = f"Unknown tool {name}"
            messages.append(
                {"role": "tool", "tool_call_id": call.get("id", name), "content": result}
            )

    return "\n\n".join(gathered)


async def answer(client: httpx.AsyncClient, req: dict[str, Any], notes: str) -> Any:
    schema = req.get("schema")
    instructions = (
        "Answer the task using only the research notes. If a value is not in "
        "the notes, use null (or an empty list) rather than guessing."
    )
    content = f"Task:\n{req['prompt']}\n\nResearch notes:\n{notes[:60000]}"
    if schema:
        msg = await chat(
            client,
            messages=[
                {"role": "system", "content": instructions},
                {"role": "user", "content": content},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "agent_result", "schema": schema},
            },
        )
        return json.loads(msg.get("content") or "null")
    msg = await chat(
        client,
        messages=[
            {"role": "system", "content": instructions + " Write the answer in Markdown and cite source URLs."},
            {"role": "user", "content": content},
        ],
    )
    return {"answer": msg.get("content") or ""}


async def send_webhook(client: httpx.AsyncClient, run: Run, event: str) -> None:
    hook = run.request.get("webhook")
    if not hook or not hook.get("url"):
        return
    events = hook.get("events") or ["completed", "failed"]
    if event not in events:
        return
    payload = {
        "success": run.status == "success",
        "type": f"agent.{event}",
        "id": run.id,
        "data": run.data if run.status == "success" else None,
        "error": run.error,
        "metadata": hook.get("metadata") or {},
    }
    raw = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", **(hook.get("headers") or {})}
    secret = os.environ.get("SELF_HOSTED_WEBHOOK_HMAC_SECRET")
    if secret:
        digest = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        headers["X-Firecrawl-Signature"] = f"sha256={digest}"
    try:
        await client.post(hook["url"], content=raw, headers=headers, timeout=10)
    except Exception as exc:
        log.warning("run=%s webhook %s failed: %s", run.id, event, exc)


async def execute(run: Run) -> None:
    async with _run_slots, httpx.AsyncClient() as client:
        await send_webhook(client, run, "started")
        try:
            async with asyncio.timeout(RUN_TIMEOUT_S):
                notes = await research(client, run)
                run.data = await answer(client, run.request, notes)
            run.status = "success"
        except asyncio.CancelledError:
            run.status = "cancelled"
            run.error = "Agent run was cancelled"
            raise
        except TimeoutError:
            run.status = "failed"
            run.error = f"Agent run exceeded {int(RUN_TIMEOUT_S)}s"
        except Exception as exc:
            log.exception("run=%s failed", run.id)
            run.status = "failed"
            run.error = f"Agent run failed: {exc}"
        finally:
            run.completed_at = time.time()
            if run.status != "cancelled":
                await send_webhook(
                    client, run, "completed" if run.status == "success" else "failed"
                )


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "model": AGENT_MODEL, "runs": len(RUNS)}


@app.post("/internal/extracts")
async def start(request: Request, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    _gc()
    body = await request.json()
    run_id = body.get("id")
    if not run_id or not body.get("prompt"):
        raise HTTPException(400, "id and prompt are required")
    if body.get("threadId"):
        raise HTTPException(503, "threads_disabled")
    if run_id in RUNS:  # idempotent retry
        return {}
    run = Run(id=run_id, request=body)
    RUNS[run_id] = run
    run.task = asyncio.create_task(execute(run))
    return {}


@app.get("/internal/extracts/{run_id}")
async def status(run_id: str, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    run = RUNS.get(run_id)
    if not run:
        return JSONResponse({"success": False, "error": "Agent job not found"}, 404)
    return run.public()


@app.get("/internal/extracts/{run_id}/trace")
async def trace(run_id: str, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    run = RUNS.get(run_id)
    if not run:
        return JSONResponse({"success": False, "error": "Agent job not found"}, 404)
    return {"success": True, "id": run.id, "events": run.events, "creditsUsed": run.credits_used}


@app.delete("/internal/extracts/{run_id}")
async def cancel(run_id: str, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    run = RUNS.get(run_id)
    if not run:
        return JSONResponse({"success": False, "error": "Agent job not found"}, 404)
    if run.status == "cancelled":
        return JSONResponse({"error": "Agent is already cancelled"}, 409)
    if run.status != "processing":
        return JSONResponse({"error": "Agent already finished"}, 409)
    if run.task:
        run.task.cancel()
    run.status = "cancelled"
    run.error = "Agent run was cancelled"
    run.completed_at = time.time()
    return {"success": True}
