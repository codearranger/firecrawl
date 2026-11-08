"""
Self-hosted OCR for Firecrawl.

Implements the synchronous fire-pdf contract (POST /ocr) that the API uses
when FIRE_PDF_ENABLE=true and FIRE_PDF_BASE_URL points here, so scanned PDFs
and images get OCR from an open-source vision model instead of a cloud
service.

Per page:
  * mode "fast"/"auto": if the page has a usable text layer, use it
    (PyMuPDF), otherwise OCR it.
  * mode "ocr": always OCR.
OCR backends:
  * "ollama" (default): render the page to PNG and ask a vision model served
    by Ollama (OCR_MODEL, default qwen2.5vl:7b) for Markdown.
  * "mineru": forward the whole file to a MinerU `mineru-api` server
    (MINERU_URL) and return its Markdown.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import time
from typing import Any, Optional

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

log = logging.getLogger("ocr-service")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

OCR_BACKEND = os.environ.get("OCR_BACKEND", "ollama").lower()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
OCR_MODEL = os.environ.get("OCR_MODEL", "qwen2.5vl:7b")
MINERU_URL = os.environ.get("MINERU_URL", "").rstrip("/")
OCR_DPI = int(os.environ.get("OCR_DPI", "110"))
OCR_CONCURRENCY = int(os.environ.get("OCR_CONCURRENCY", "2"))
OCR_PAGE_TIMEOUT_S = float(os.environ.get("OCR_PAGE_TIMEOUT_S", "180"))
MAX_PAGES_DEFAULT = int(os.environ.get("OCR_MAX_PAGES", "200"))
# A page whose text layer has fewer characters than this is treated as scanned.
MIN_TEXT_CHARS = int(os.environ.get("OCR_MIN_TEXT_CHARS", "40"))
API_KEY = os.environ.get("OCR_API_KEY", "")

OCR_PROMPT = os.environ.get(
    "OCR_PROMPT",
    "Convert this document page to Markdown. Transcribe all text exactly, "
    "in reading order. Use Markdown headings, lists and tables where the page "
    "has them. Output only the Markdown, with no commentary and no code fences.",
)

app = FastAPI(title="firecrawl-ocr-service")
_semaphore = asyncio.Semaphore(OCR_CONCURRENCY)


class OcrRequest(BaseModel):
    pdf: str
    scrape_id: Optional[str] = None
    max_pages: Optional[int] = None
    mode: Optional[str] = "auto"
    include_page_markdown: Optional[bool] = False
    page_markers: Optional[bool] = False
    source_kind: Optional[str] = "pdf"
    timeout: Optional[int] = None

    model_config = {"extra": "ignore"}


_FENCE = re.compile(r"^\s*```(?:markdown|md)?\s*\n(.*?)\n?```\s*$", re.S)


def strip_fences(text: str) -> str:
    match = _FENCE.match(text)
    return (match.group(1) if match else text).strip()


def sniff_kind(data: bytes, declared: Optional[str]) -> str:
    if data[:5] == b"%PDF-":
        return "pdf"
    if declared == "image" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff":
        return "image"
    if data[:4] in (b"GIF8", b"RIFF") or data[:2] in (b"BM",):
        return "image"
    return declared or "pdf"


def image_to_png(data: bytes) -> bytes:
    """Normalize any image PyMuPDF can open (png/jpg/gif/bmp/webp/tiff) to PNG."""
    with fitz.open(stream=data) as doc:
        pix = doc[0].get_pixmap()
        return pix.tobytes("png")


async def ocr_png_ollama(client: httpx.AsyncClient, png: bytes) -> str:
    body = {
        "model": OCR_MODEL,
        "messages": [
            {
                "role": "user",
                "content": OCR_PROMPT,
                "images": [base64.b64encode(png).decode()],
            }
        ],
        "stream": False,
        "options": {"temperature": 0},
    }
    async with _semaphore:
        resp = await client.post(
            f"{OLLAMA_URL}/api/chat", json=body, timeout=OCR_PAGE_TIMEOUT_S
        )
    resp.raise_for_status()
    return strip_fences(resp.json()["message"]["content"])


async def ocr_file_mineru(
    client: httpx.AsyncClient, data: bytes, kind: str, mode: str, max_pages: int
) -> str:
    if not MINERU_URL:
        raise HTTPException(500, "OCR_BACKEND=mineru but MINERU_URL is not set")
    filename = "document.pdf" if kind == "pdf" else "image.png"
    form = {
        "backend": os.environ.get("MINERU_BACKEND", "pipeline"),
        "parse_method": "ocr" if mode == "ocr" else "auto",
        "return_md": "true",
        "end_page_id": str(max(max_pages - 1, 0)),
    }
    resp = await client.post(
        f"{MINERU_URL}/file_parse",
        data=form,
        files={"files": (filename, data)},
        timeout=OCR_PAGE_TIMEOUT_S * 4,
    )
    resp.raise_for_status()
    results: dict[str, Any] = resp.json().get("results", {})
    return "\n\n".join(
        (r.get("md_content") or "").strip() for r in results.values()
    ).strip()


def with_markers(pages: list[dict[str, Any]], markers: bool) -> str:
    if not markers:
        return "\n\n".join(p["markdown"] for p in pages).strip()
    return "\n\n".join(
        f"<!-- Page {p['page']} -->\n\n{p['markdown']}" for p in pages
    ).strip()


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "backend": OCR_BACKEND, "model": OCR_MODEL}


@app.post("/ocr")
async def ocr(
    req: OcrRequest, authorization: Optional[str] = Header(default=None)
) -> dict[str, Any]:
    # Firecrawl sends FIRE_PDF_API_KEY as a bearer token when it is set.
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(401, "unauthorized")
    started = time.monotonic()
    try:
        data = base64.b64decode(req.pdf, validate=False)
    except Exception:
        raise HTTPException(400, "invalid or corrupt file: bad base64")
    kind = sniff_kind(data, req.source_kind)
    mode = (req.mode or "auto").lower()
    max_pages = req.max_pages or MAX_PAGES_DEFAULT

    async with httpx.AsyncClient() as client:
        if OCR_BACKEND == "mineru":
            markdown = await ocr_file_mineru(client, data, kind, mode, max_pages)
            return {
                "markdown": markdown,
                "failed_pages": None,
                "pages_processed": 1 if kind == "image" else None,
            }

        if kind == "image":
            try:
                png = image_to_png(data)
            except Exception:
                raise HTTPException(400, "invalid or corrupt image")
            text = await ocr_png_ollama(client, png)
            pages = [{"page": 1, "markdown": text}]
            return {
                "markdown": with_markers(pages, bool(req.page_markers)),
                "failed_pages": None,
                "pages_processed": 1,
                **({"pages": pages} if req.include_page_markdown else {}),
                **({"page_markers": True} if req.page_markers else {}),
            }

        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception:
            raise HTTPException(400, "invalid or corrupt PDF")

        with doc:
            count = min(doc.page_count, max_pages)
            pages: list[Optional[dict[str, Any]]] = [None] * count
            to_ocr: list[tuple[int, bytes]] = []
            for i in range(count):
                page = doc[i]
                text = page.get_text("text").strip()
                if mode != "ocr" and len(text) >= MIN_TEXT_CHARS:
                    pages[i] = {"page": i + 1, "markdown": text}
                else:
                    pix = page.get_pixmap(dpi=OCR_DPI)
                    to_ocr.append((i, pix.tobytes("png")))

        failed: list[int] = []

        async def run(i: int, png: bytes) -> None:
            try:
                pages[i] = {"page": i + 1, "markdown": await ocr_png_ollama(client, png)}
            except Exception as exc:  # keep going; report the page as failed
                log.warning("OCR failed for page %d: %s", i + 1, exc)
                failed.append(i + 1)
                pages[i] = {"page": i + 1, "markdown": ""}

        await asyncio.gather(*(run(i, png) for i, png in to_ocr))

    done = [p for p in pages if p is not None]
    log.info(
        "scrape_id=%s kind=%s mode=%s pages=%d ocr_pages=%d failed=%d %.1fs",
        req.scrape_id, kind, mode, count, len(to_ocr), len(failed),
        time.monotonic() - started,
    )
    if to_ocr and len(failed) == len(to_ocr) and len(to_ocr) == count:
        raise HTTPException(502, "OCR backend failed for every page")
    return {
        "markdown": with_markers(done, bool(req.page_markers)),
        "failed_pages": sorted(failed) or None,
        "pages_processed": count,
        **({"pages": done} if req.include_page_markdown else {}),
        **({"page_markers": True} if req.page_markers else {}),
    }
