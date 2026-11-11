/**
 * Smaller (self-hosted) models often drop the `agent-browser` prefix and
 * emit e.g. `find text "Docs" click`, which the sandbox shell then runs as
 * the Unix `find`. Prefix each && / ; segment whose first word is an
 * agent-browser command and that is not already prefixed.
 */
const AGENT_BROWSER_COMMANDS = new Set([
  "snapshot",
  "click",
  "dblclick",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "keyboard",
  "hover",
  "focus",
  "scroll",
  "scrollintoview",
  "get",
  "is",
  "wait",
  "find",
  "frame",
  "eval",
  "back",
  "forward",
  "reload",
  "tab",
  "mouse",
  "screenshot",
  "drag",
  "upload",
  "open",
  "read",
]);

export function normalizeAgentBrowserCommand(code: string): string {
  return code
    .split(/(\s*(?:&&|;)\s*)/)
    .map(part => {
      const trimmed = part.trimStart();
      if (!trimmed || /^(?:&&|;)$/.test(trimmed.trim())) return part;
      const first = trimmed.split(/\s+/, 1)[0];
      if (first === "agent-browser" || !AGENT_BROWSER_COMMANDS.has(first))
        return part;
      return (
        part.slice(0, part.length - trimmed.length) + "agent-browser " + trimmed
      );
    })
    .join("");
}
