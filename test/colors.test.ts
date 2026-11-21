import { test, expect, describe } from "bun:test";
import { AGENT_RGB, FALLBACK_RGB, colorOf, paintHandle, paintTag, stripAnsi, colorEnabled } from "../src/colors";

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

describe("paintTag", () => {
  test("the message prefix takes the agent's colour", () => {
    expect(paintTag("@lead", () => "38;2;255;0;0")).toBe(`${RED}[@lead]${RESET}`);
    expect(paintTag("@lead", () => null)).toBe("[@lead]");
  });
});

describe("paintHandle", () => {
  test("a bare handle takes its colour, and stays plain with colour off", () => {
    expect(paintHandle("@dev1", () => "38;2;90;170;255")).toBe("\u001b[38;2;90;170;255m@dev1\u001b[0m");
    expect(paintHandle("@dev1", () => null)).toBe("@dev1");
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
