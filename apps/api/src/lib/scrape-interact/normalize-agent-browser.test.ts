import { normalizeAgentBrowserCommand } from "./normalize-agent-browser";

describe("normalizeAgentBrowserCommand", () => {
  it("prefixes bare agent-browser commands in a chain", () => {
    expect(
      normalizeAgentBrowserCommand(
        'find text "Example domains" && get text @e3',
      ),
    ).toBe(
      'agent-browser find text "Example domains" && agent-browser get text @e3',
    );
  });

  it("leaves prefixed commands and other shell commands alone", () => {
    expect(normalizeAgentBrowserCommand("agent-browser snapshot -i")).toBe(
      "agent-browser snapshot -i",
    );
    expect(normalizeAgentBrowserCommand("echo hi; agent-browser get url")).toBe(
      "echo hi; agent-browser get url",
    );
  });

  it("prefixes open so the new-tab/URL block still applies", () => {
    expect(normalizeAgentBrowserCommand("open https://x.test")).toBe(
      "agent-browser open https://x.test",
    );
  });
});
