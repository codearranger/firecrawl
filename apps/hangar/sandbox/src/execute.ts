/**
 * Runs user code against the session's browser. Every execution is a fresh
 * child process (so a crash or `process.exit` cannot take the agent down)
 * that attaches to Chromium over CDP on 127.0.0.1:
 *
 *   node    Playwright, with mutable globals `browser`, `context`, `page`
 *           and top-level await. The value of a final `return` becomes
 *           `result`.
 *   python  async Playwright with the same globals and top-level await.
 *   bash    a shell where `agent-browser` is already attached to this browser.
 *
 * The page the code ends on is remembered and becomes `page` next time.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExecuteRequest = {
  code: string;
  language?: "node" | "python" | "bash";
  timeout?: number; // seconds
};

export type ExecuteResult = {
  stdout: string;
  result: string;
  stderr: string;
  exit_code: number;
  killed: boolean;
  truncated?: boolean;
  currentTargetId?: string | null;
};

const MAX_OUTPUT = 1024 * 1024;
const RUNTIME_DIR = process.env.HANGAR_RUNTIME_DIR ?? "/opt/sandbox";
const DEBUG_URL = "http://127.0.0.1:9222";

const NODE_PRELUDE = (resultFile: string, targetId: string | null) => `
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(${JSON.stringify(RUNTIME_DIR + "/")});
const { chromium } = require("playwright");
let browser = await chromium.connectOverCDP(${JSON.stringify(DEBUG_URL)});
let context = browser.contexts()[0] ?? (await browser.newContext());
const __targetIdOf = async p => {
  try {
    const s = await p.context().newCDPSession(p);
    const { targetInfo } = await s.send("Target.getTargetInfo");
    await s.detach().catch(() => {});
    return targetInfo.targetId;
  } catch { return null; }
};
const __pages = () => browser.contexts().flatMap(c => c.pages())
  .filter(p => !p.isClosed() && !p.url().startsWith("chrome-extension://"));
let page = null;
const __wanted = ${JSON.stringify(targetId)};
if (__wanted) for (const p of __pages()) if ((await __targetIdOf(p)) === __wanted) { page = p; break; }
if (!page) page = __pages().at(-1) ?? (await context.newPage());
const __finish = async (value, code) => {
  let targetId = null;
  try { if (page && !page.isClosed()) targetId = await __targetIdOf(page); } catch {}
  let result = "";
  if (value !== undefined) {
    try { result = typeof value === "string" ? value : JSON.stringify(value); }
    catch { result = String(value); }
  }
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ result, targetId }));
  process.exit(code);
};
let __value;
try {
  __value = await (async () => {
`;

const NODE_EPILOGUE = `
  })();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  await __finish(undefined, 1);
}
await __finish(__value, 0);
`;

const PYTHON_RUNNER = `
import ast, asyncio, json, sys, traceback
from playwright.async_api import async_playwright

async def _target_id(page):
    try:
        s = await page.context.new_cdp_session(page)
        info = await s.send("Target.getTargetInfo")
        await s.detach()
        return info["targetInfo"]["targetId"]
    except Exception:
        return None

async def _main(code_path, result_path, wanted):
    code = open(code_path).read()
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp("${DEBUG_URL}")
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        pages = [p for c in browser.contexts for p in c.pages if not p.url.startswith("chrome-extension://")]
        page = None
        if wanted:
            for p in pages:
                if await _target_id(p) == wanted:
                    page = p
                    break
        if page is None:
            page = pages[-1] if pages else await context.new_page()
        g = {"__name__": "__main__", "browser": browser, "context": context, "page": page, "asyncio": asyncio}
        exit_code = 0
        try:
            compiled = compile(code, "<code>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            maybe = eval(compiled, g)
            if asyncio.iscoroutine(maybe):
                await maybe
        except SystemExit as e:
            exit_code = e.code if isinstance(e.code, int) else 1
        except Exception:
            traceback.print_exc()
            exit_code = 1
        sys.stdout.flush()
        final = g.get("page")
        target = None
        try:
            if final is not None and not final.is_closed():
                target = await _target_id(final)
        except Exception:
            pass
        result = g.get("result", "")
        if not isinstance(result, str):
            try:
                result = json.dumps(result)
            except Exception:
                result = str(result)
        with open(result_path, "w") as f:
            json.dump({"result": result, "targetId": target}, f)
        return exit_code

sys.exit(asyncio.run(_main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")))
`;

function collect(stream: NodeJS.ReadableStream | null, sink: { data: string; truncated: boolean }) {
  stream?.on("data", (chunk: Buffer) => {
    if (sink.data.length >= MAX_OUTPUT) {
      sink.truncated = true;
      return;
    }
    sink.data += chunk.toString("utf8");
    if (sink.data.length > MAX_OUTPUT) {
      sink.data = sink.data.slice(0, MAX_OUTPUT);
      sink.truncated = true;
    }
  });
}

export async function runCode(
  req: ExecuteRequest,
  currentTargetId: string | null,
): Promise<ExecuteResult> {
  const language = req.language ?? "node";
  const timeoutMs = Math.min(Math.max(req.timeout ?? 30, 1), 300) * 1000;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-"));
  const resultFile = path.join(workDir, "result.json");

  let command: string;
  let args: string[];
  if (language === "node") {
    const file = path.join(workDir, "run.mjs");
    fs.writeFileSync(
      file,
      NODE_PRELUDE(resultFile, currentTargetId) + req.code + NODE_EPILOGUE,
    );
    command = "node";
    args = [file];
  } else if (language === "python") {
    const runner = path.join(workDir, "runner.py");
    const codeFile = path.join(workDir, "code.py");
    fs.writeFileSync(runner, PYTHON_RUNNER);
    fs.writeFileSync(codeFile, req.code);
    command = "python3";
    args = [runner, codeFile, resultFile, currentTargetId ?? ""];
  } else if (language === "bash") {
    command = "bash";
    args = ["-c", req.code];
  } else {
    return {
      stdout: "",
      result: "",
      stderr: `Unsupported language: ${language}`,
      exit_code: 2,
      killed: false,
    };
  }

  // User code gets a clean environment: no session token, no proxy secrets.
  const env: NodeJS.ProcessEnv = {
    PATH: `${RUNTIME_DIR}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
    NODE_PATH: `${RUNTIME_DIR}/node_modules`,
    AGENT_BROWSER_HOME: "/tmp/home/.agent-browser",
    HTTP_PROXY: process.env.EGRESS_PROXY ?? "",
    HTTPS_PROXY: process.env.EGRESS_PROXY ?? "",
    NO_PROXY: "127.0.0.1,localhost",
  };
  fs.mkdirSync(env.HOME!, { recursive: true });

  const stdout = { data: "", truncated: false };
  const stderr = { data: "", truncated: false };
  let killed = false;

  const exitCode = await new Promise<number>(resolve => {
    const child = spawn(command, args, {
      cwd: workDir,
      env,
      detached: true, // own process group, so a timeout kills everything
      stdio: ["ignore", "pipe", "pipe"],
    });
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", error => {
      stderr.data += String(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(code ?? (killed ? 137 : 1));
    });
  });

  let result = "";
  let targetId: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    result = parsed.result ?? "";
    targetId = parsed.targetId ?? null;
  } catch {}
  fs.rmSync(workDir, { recursive: true, force: true });

  return {
    stdout: stdout.data,
    result,
    stderr: stderr.data,
    exit_code: exitCode,
    killed,
    ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
    currentTargetId: targetId,
  };
}
