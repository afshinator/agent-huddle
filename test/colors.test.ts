import { test, expect, describe } from "bun:test";
import { AGENT_RGB, FALLBACK_RGB, colorOf, paintHandles, paintTag, stripAnsi, colorEnabled } from "../src/colors";

const RED = "\u001b[38;2;255;0;0m";
const BLUE = "\u001b[38;2;0;0;255m";
const RESET = "\u001b[0m";

describe("colorOf", () => {
  test("a named agent gets its table entry; anyone else falls back by slot, stably", () => {
    const table = { lead: [255, 0, 0] as [number, number, number], dev1: [0, 0, 255] as [number, number, number] };
    expect(colorOf("lead", 0, table)).toBe("38;2;255;0;0");
    expect(colorOf("dev1", 1, table)).toBe("38;2;0;0;255");
    // an agent the file does not name still gets a colour, and always the same one
    expect(colorOf("extra", 0, table)).toBe(`38;2;${FALLBACK_RGB[0]!.join(";")}`);
    expect(colorOf("extra", 0, table)).toBe(colorOf("extra", 0, table));
  });

  test("the shipped table names the three docs-audit agents", () => {
    expect(Object.keys(AGENT_RGB)).toContain("lead");
    expect(Object.keys(AGENT_RGB)).toContain("dev1");
    expect(Object.keys(AGENT_RGB)).toContain("reviewer");
  });
});

describe("paintHandles", () => {
  const colors = (handle: string): string | null =>
    handle === "@lead" ? "38;2;255;0;0" : handle === "@dev1" ? "38;2;0;0;255" : null;

  test("a known handle is wrapped, everything else is untouched", () => {
    expect(paintHandles("@lead please look", colors)).toBe(`${RED}@lead${RESET} please look`);
  });

  test("every mention of the same agent gets the same colour", () => {
    const out = paintHandles("@dev1 and again @dev1", colors);
    expect(out).toBe(`${BLUE}@dev1${RESET} and again ${BLUE}@dev1${RESET}`);
  });

  test("an unknown handle is left alone rather than given a colour", () => {
    expect(paintHandles("@nobody here", colors)).toBe("@nobody here");
  });

  test("boundaries: a longer handle, an email and punctuation are not mangled", () => {
    expect(paintHandles("@dev12 x", colors)).toBe("@dev12 x");
    expect(paintHandles("mail a@dev1.com", colors)).toBe("mail a@dev1.com");
    expect(paintHandles("ask @dev1, then stop", colors)).toBe(`ask ${BLUE}@dev1${RESET}, then stop`);
  });

  test("disabled or empty input is returned untouched", () => {
    expect(paintHandles("@lead hi", () => null)).toBe("@lead hi");
    expect(paintHandles("", colors)).toBe("");
  });
});

describe("paintTag", () => {
  test("the message prefix takes the agent's colour", () => {
    expect(paintTag("@lead", () => "38;2;255;0;0")).toBe(`${RED}[@lead]${RESET}`);
    expect(paintTag("@lead", () => null)).toBe("[@lead]");
  });
});

describe("stripAnsi", () => {
  test("colour is removed for the transcript file", () => {
    expect(stripAnsi(`[${RED}@lead${RESET}] ${RED}@dev1${RESET} go`)).toBe("[@lead] @dev1 go");
  });
});

describe("colorEnabled", () => {
  test("AH_COLOR wins, NO_COLOR disables, otherwise the terminal decides", () => {
    expect(colorEnabled({ AH_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ AH_COLOR: "0" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });
});
