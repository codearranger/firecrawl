"""Unit tests: python -m pytest test_app.py (LLM and Firecrawl are faked)."""

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import app as agent_app

SECRET = "test-secret"
AUTH = {"Authorization": f"Bearer {SECRET}"}
RUN_ID = "019a5f0e-0000-7000-8000-000000000001"


def tool_call(name, args, call_id="c1"):
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
        ],
    }


class Fake:
    """Scripted LLM replies plus a fake Firecrawl API."""

    def __init__(self, llm_replies):
        self.llm_replies = list(llm_replies)
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append((request.url.path, body))
        if request.url.path.endswith("/chat/completions"):
            reply = self.llm_replies.pop(0)
            return httpx.Response(200, json={"choices": [{"message": reply}]})
        if request.url.path == "/v2/search":
            return httpx.Response(
                200,
                json={"success": True, "data": {"web": [{"title": "Example", "url": "https://example.com", "description": "An example"}]}},
            )
        if request.url.path == "/v2/scrape":
            return httpx.Response(200, json={"success": True, "data": {"markdown": "# Example Domain\nFounded 1999."}})
        return httpx.Response(404)


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setattr(agent_app, "AGENT_INTEROP_SECRET", SECRET)
    agent_app.RUNS.clear()

    def install(fake: Fake):
        real = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(fake.handler)
            return real(*args, **kwargs)

        monkeypatch.setattr(agent_app.httpx, "AsyncClient", factory)
        return TestClient(agent_app.app)

    return install


def wait_done(client, run_id=RUN_ID, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        body = client.get(f"/internal/extracts/{run_id}", headers=AUTH).json()
        if body["status"] != "processing":
            return body
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_requires_auth(setup):
    client = setup(Fake([]))
    r = client.post("/internal/extracts", json={"id": RUN_ID, "prompt": "x"})
    assert r.status_code == 401


def test_schema_run_end_to_end(setup):
    fake = Fake(
        [
            tool_call("web_search", {"query": "example domain"}),
            tool_call("scrape_url", {"url": "https://example.com"}, "c2"),
            tool_call("finish", {"notes": "Example Domain was founded in 1999."}, "c3"),
            {"role": "assistant", "content": json.dumps({"name": "Example Domain", "year": 1999})},
        ]
    )
    with setup(fake) as client:
        schema = {"type": "object", "properties": {"name": {"type": "string"}, "year": {"type": "integer"}}}
        r = client.post(
            "/internal/extracts",
            json={"id": RUN_ID, "prompt": "When was it founded?", "schema": schema, "apiKey": "fc-x"},
            headers=AUTH,
        )
        assert r.status_code == 200
        body = wait_done(client)
    assert body["status"] == "success"
    assert body["data"] == {"name": "Example Domain", "year": 1999}
    assert body["creditsUsed"] == agent_app.CREDITS_PER_SEARCH + agent_app.CREDITS_PER_SCRAPE
    assert "completedAt" in body
    # Sub-requests carry __agentInterop and the caller's key.
    search = next(b for p, b in fake.requests if p == "/v2/search")
    assert search["__agentInterop"] == {"auth": SECRET, "requestId": RUN_ID, "shouldBill": False}
    # The final call used structured output with the caller's schema.
    final = [b for p, b in fake.requests if p.endswith("/chat/completions")][-1]
    assert final["response_format"]["json_schema"]["schema"] == schema


def test_strict_urls_blocks_search_and_other_hosts(setup):
    fake = Fake(
        [
            tool_call("scrape_url", {"url": "https://evil.test/page"}),
            tool_call("finish", {"notes": "nothing"}, "c2"),
            {"role": "assistant", "content": "No answer."},
        ]
    )
    with setup(fake) as client:
        client.post(
            "/internal/extracts",
            json={"id": RUN_ID, "prompt": "q", "urls": ["https://example.com"], "strictConstrainToURLs": True},
            headers=AUTH,
        )
        body = wait_done(client)
    assert body["status"] == "success"
    first_llm = next(b for p, b in fake.requests if p.endswith("/chat/completions"))
    assert all(t["function"]["name"] != "web_search" for t in first_llm["tools"])
    assert not any(p == "/v2/scrape" for p, _ in fake.requests)


def test_llm_error_marks_failed(setup):
    with setup(Fake([])) as client:  # no scripted replies -> IndexError in fake
        client.post("/internal/extracts", json={"id": RUN_ID, "prompt": "q"}, headers=AUTH)
        body = wait_done(client)
    assert body["status"] == "failed"
    assert body["error"].startswith("Agent run failed")


def test_unknown_run_is_404(setup):
    client = setup(Fake([]))
    assert client.get("/internal/extracts/nope", headers=AUTH).status_code == 404
    assert client.delete("/internal/extracts/nope", headers=AUTH).status_code == 404


def test_cancel_finished_run_is_409(setup):
    fake = Fake([tool_call("finish", {"notes": "n"}), {"role": "assistant", "content": "done"}])
    with setup(fake) as client:
        client.post("/internal/extracts", json={"id": RUN_ID, "prompt": "q"}, headers=AUTH)
        wait_done(client)
        r = client.delete(f"/internal/extracts/{RUN_ID}", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error"] == "Agent already finished"


def test_threads_unsupported(setup):
    client = setup(Fake([]))
    r = client.post(
        "/internal/extracts", json={"id": RUN_ID, "prompt": "q", "threadId": "t"}, headers=AUTH
    )
    assert r.status_code == 503
