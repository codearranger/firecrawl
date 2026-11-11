/**
 * Self-contained live view page. The URL carries the session id and token
 * (/view/:id/:token or /control/:id/:token); the page opens the matching
 * /screencast/:id/:token WebSocket on the same origin.
 */
export function liveViewPage(interactive: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Live View</title>
<style>
  :root { --bg: #f4f4f5; --fg: #18181b; --muted: #71717a; --panel: #ffffff; --border: #e4e4e7; --accent: #ea580c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --panel: #18181b; --border: #27272a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  header .dot.live { background: #16a34a; }
  header .status { color: var(--muted); white-space: nowrap; }
  header form { flex: 1; display: ${interactive ? "flex" : "none"}; gap: 6px; min-width: 0; }
  header input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); }
  header button { padding: 6px 12px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
  main { display: flex; justify-content: center; padding: 16px; }
  canvas { max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 6px; background: #000; outline: none; ${interactive ? "cursor: default;" : ""} }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="status" id="status">Connecting…</span>
  <form id="nav"><input id="url" placeholder="https://" autocomplete="off"><button>Go</button></form>
</header>
<main><canvas id="screen" width="1280" height="800" tabindex="0"></canvas></main>
<script>
(() => {
  const interactive = ${interactive ? "true" : "false"};
  const parts = location.pathname.split("/").filter(Boolean);
  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host +
    "/screencast/" + parts[1] + "/" + parts[2];
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const dot = document.getElementById("dot");
  let ws;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "blob";
    ws.onopen = () => { statusEl.textContent = interactive ? "Live (control)" : "Live (view only)"; dot.classList.add("live"); };
    ws.onclose = () => { statusEl.textContent = "Disconnected — session may have ended"; dot.classList.remove("live"); };
    ws.onmessage = async ev => {
      const bitmap = await createImageBitmap(ev.data);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width; canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
    };
  }
  connect();
  if (!interactive) return;
  const send = msg => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * canvas.width / r.width), y: Math.round((e.clientY - r.top) * canvas.height / r.height) };
  };
  const button = b => (b === 2 ? "right" : b === 1 ? "middle" : "left");
  canvas.addEventListener("mousedown", e => { canvas.focus(); send({ type: "mouse", action: "mousePressed", button: button(e.button), clickCount: 1, ...pos(e) }); });
  canvas.addEventListener("mouseup", e => send({ type: "mouse", action: "mouseReleased", button: button(e.button), clickCount: 1, ...pos(e) }));
  let lastMove = 0;
  canvas.addEventListener("mousemove", e => { const t = Date.now(); if (t - lastMove > 50) { lastMove = t; send({ type: "mouse", action: "mouseMoved", button: "none", ...pos(e) }); } });
  canvas.addEventListener("wheel", e => { e.preventDefault(); send({ type: "mouse", action: "mouseWheel", deltaX: e.deltaX, deltaY: e.deltaY, ...pos(e) }); }, { passive: false });
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("keydown", e => {
    e.preventDefault();
    send({ type: "key", action: "keyDown", key: e.key, code: e.code });
    if (e.key.length === 1) send({ type: "key", action: "char", key: e.key, text: e.key });
  });
  canvas.addEventListener("keyup", e => { e.preventDefault(); send({ type: "key", action: "keyUp", key: e.key, code: e.code }); });
  document.getElementById("nav").addEventListener("submit", e => {
    e.preventDefault();
    let u = document.getElementById("url").value.trim();
    if (!u) return;
    if (!/^https?:\\/\\//.test(u)) u = "https://" + u;
    send({ type: "navigate", url: u });
  });
})();
</script>
</body>
</html>`;
}
