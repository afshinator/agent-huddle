import { test, expect, describe } from "bun:test";
import { paneScript } from "../src/pane-command";

describe("paneCommand", () => {
  test("a writable pane runs the tail and a reader for typed lines", () => {
    const script = paneScript({ stream: "/r/agents/dev1/output.log", inbox: "/r/agents/dev1/inbox" });

    // The tail is backgrounded and the reader runs in the foreground: a background
    // job's stdin is /dev/null, so a backgrounded reader never gets a keystroke.
    expect(script).toContain("tail -f '/r/agents/dev1/output.log' &");
    expect(script.indexOf("tail -f")).toBeLessThan(script.indexOf("read -r line"));
    expect(script).toContain(">> '/r/agents/dev1/inbox'");
    expect(script).toContain("tail -f '/r/agents/dev1/output.log'");
  });

  test("a read-only pane runs the tail alone behind a banner", () => {
    const script = paneScript({ stream: "/r/agents/dev1/output.log", inbox: null });

    expect(script).toContain("read-only - type in the chat pane");
    expect(script).not.toContain("read -r line");
  });

  test("both scripts clear the pane first, so herdr's restored scrollback is gone", () => {
    // herdr restores a pane's terminal session: without this the previous boot's lines
    // sit above the live tail and a fresh pane looks busy (#61)
    for (const inbox of ["/r/agents/dev1/inbox", null]) {
      const script = paneScript({ stream: "/r/agents/dev1/output.log", inbox });
      expect(script.startsWith("printf '\\033[2J\\033[H'\n")).toBe(true);
    }
  });

  test("a path with a space or a quote cannot break out of the quotes", () => {
    const script = paneScript({ stream: "/r/a b/it's.log", inbox: "/r/a b/it's.inbox" });

    // Single-quote escaping: 'it'\''s' — each path stays one shell word.
    expect(script).toContain("/r/a b/it'\\''s.log");
    expect(script).toContain("/r/a b/it'\\''s.inbox");
  });
});
