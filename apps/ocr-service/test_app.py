"""Unit tests: python -m pytest test_app.py (OCR backend is stubbed)."""

import base64

import fitz
import pytest
from fastapi.testclient import TestClient

import app as ocr_app


def make_pdf(text_pages: list[str], blank_pages: int = 0) -> bytes:
    doc = fitz.open()
    for text in text_pages:
        page = doc.new_page()
        page.insert_text((72, 72), text)
    for _ in range(blank_pages):
        page = doc.new_page()
        # A drawn rectangle but no text layer, like a scanned page.
        page.draw_rect(fitz.Rect(50, 50, 300, 300), fill=(0.2, 0.2, 0.2))
    return doc.tobytes()


def make_png() -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
    pix.clear_with(200)
    return pix.tobytes("png")


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def fake_ocr(_client, png: bytes) -> str:
        calls.append(png)
        return f"# OCR page {len(calls)}"

    monkeypatch.setattr(ocr_app, "ocr_png_ollama", fake_ocr)
    monkeypatch.setattr(ocr_app, "API_KEY", "")
    c = TestClient(ocr_app.app)
    c.calls = calls
    return c


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


LONG_TEXT = "This page has a real text layer with plenty of characters."


def test_text_pages_skip_ocr(client):
    pdf = make_pdf([LONG_TEXT, LONG_TEXT + " two"])
    r = client.post("/ocr", json={"pdf": b64(pdf)})
    assert r.status_code == 200
    body = r.json()
    assert body["pages_processed"] == 2
    assert body["failed_pages"] is None
    assert "real text layer" in body["markdown"]
    assert client.calls == []


def test_scanned_pages_are_ocred(client):
    pdf = make_pdf([LONG_TEXT], blank_pages=1)
    r = client.post("/ocr", json={"pdf": b64(pdf), "include_page_markdown": True})
    body = r.json()
    assert len(client.calls) == 1
    assert [p["page"] for p in body["pages"]] == [1, 2]
    assert body["pages"][1]["markdown"] == "# OCR page 1"


def test_mode_ocr_forces_ocr(client):
    pdf = make_pdf([LONG_TEXT])
    r = client.post("/ocr", json={"pdf": b64(pdf), "mode": "ocr"})
    assert r.status_code == 200
    assert len(client.calls) == 1


def test_max_pages_and_markers(client):
    pdf = make_pdf([LONG_TEXT] * 3)
    r = client.post("/ocr", json={"pdf": b64(pdf), "max_pages": 2, "page_markers": True})
    body = r.json()
    assert body["pages_processed"] == 2
    assert body["page_markers"] is True
    assert "<!-- Page 2 -->" in body["markdown"]
    assert "<!-- Page 3 -->" not in body["markdown"]


def test_image_input(client):
    r = client.post("/ocr", json={"pdf": b64(make_png()), "source_kind": "image"})
    assert r.status_code == 200
    assert r.json()["markdown"] == "# OCR page 1"


def test_corrupt_input_is_400(client):
    r = client.post("/ocr", json={"pdf": b64(b"not a pdf at all")})
    assert r.status_code == 400
    assert "invalid or corrupt" in r.json()["detail"]


def test_strip_fences():
    assert ocr_app.strip_fences("```markdown\n# Hi\n```") == "# Hi"
    assert ocr_app.strip_fences("# Plain") == "# Plain"


def test_api_key_enforced(client, monkeypatch):
    monkeypatch.setattr(ocr_app, "API_KEY", "secret")
    pdf = make_pdf([LONG_TEXT])
    assert client.post("/ocr", json={"pdf": b64(pdf)}).status_code == 401
    ok = client.post(
        "/ocr", json={"pdf": b64(pdf)}, headers={"Authorization": "Bearer secret"}
    )
    assert ok.status_code == 200
