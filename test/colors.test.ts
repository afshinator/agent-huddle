import { test, expect, describe } from "bun:test";
import { AGENT_MARK, AGENT_RGB, FALLBACK_MARKS, FALLBACK_RGB, colorOf, markOf, paintTag, stripAnsi, colorEnabled } from "../src/colors";

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

describe("the palette is the emoji palette", () => {
  test("each named agent's colour is its mark's colour, sampled from the system font", () => {
    // Measured, not chosen: the squares are drawn by the font, so the text has to match them
    // (tools/emoji-palette.swift). 🟨 🟦 🟪
    expect(AGENT_RGB.lead).toEqual([238, 180, 0]);
    expect(AGENT_RGB.dev1).toEqual([5, 93, 242]);
    expect(AGENT_RGB.reviewer).toEqual([185, 49, 255]);
    // and the fallbacks match theirs: 🟩 🟥 🟧
    expect(FALLBACK_RGB).toEqual([
      [0, 177, 0],
      [212, 33, 17],
      [255, 138, 4],
    ]);
  });

  test("every named agent has a mark, and every fallback colour a fallback mark", () => {
    for (const id of Object.keys(AGENT_RGB)) expect(AGENT_MARK[id]).toBeDefined();
    expect(FALLBACK_MARKS.length).toBe(FALLBACK_RGB.length);
  });
});

describe("markOf", () => {
  test("a named agent gets its mark; anyone else falls back by slot", () => {
    expect(markOf("lead", 0)).toBe("🟨");
    expect(markOf("reviewer", 2)).toBe("🟪");
    expect(markOf("extra", 0)).toBe("🟩");
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
