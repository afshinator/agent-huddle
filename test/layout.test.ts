import { test, expect, describe } from "bun:test";
import {
  chooseLayout,
  sliceRatios,
  MIN_CHAT_COLS,
  MIN_CHAT_ROWS,
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  TARGET_ASPECT,
} from "../src/layout";

/**
 * The numbers are the decision. This test pins them so changing one is a visible choice rather
 * than a silent edit, and it is the only place outside src/layout.ts that repeats their values.
 */
describe("layout constants", () => {
  test("the floors this repo ships", () => {
    expect({ MIN_PANE_COLS, MIN_PANE_ROWS, MIN_CHAT_COLS, MIN_CHAT_ROWS, TARGET_ASPECT }).toEqual({
      MIN_PANE_COLS: 64,
      MIN_PANE_ROWS: 8,
      MIN_CHAT_COLS: 100,
      MIN_CHAT_ROWS: 24,
      TARGET_ASPECT: 3.0,
    });
  });
});

describe("sliceRatios (herdr F6)", () => {
  test("three equal slices are 2/3 then 1/2, because the existing pane keeps the ratio", () => {
    expect(sliceRatios(3)).toEqual([2 / 3, 1 / 2]);
  });

  test("six equal slices count down to 1/2", () => {
    expect(sliceRatios(6).map((r) => Number(r.toFixed(3)))).toEqual([0.833, 0.8, 0.75, 0.667, 0.5]);
  });

  test("one pane needs no split", () => {
    expect(sliceRatios(1)).toEqual([]);
  });
});

describe("chooseLayout", () => {
  test("at 176x49 with three agents the chat stays wide on top and panes go two across", () => {
    const plan = chooseLayout({ width: 176, height: 49, count: 3 })!;
    expect(plan.orientation).toBe("above");
    expect(plan.chat).toEqual({ x: 0, y: 0, width: 176, height: 25 });
    expect(plan.columns).toBe(2);
    expect(plan.rows).toBe(2);
    // two panes in the first row, the third stretched across the full width below
    expect(plan.panes.map((p) => [p.width, p.height])).toEqual([
      [88, 12],
      [88, 12],
      [176, 12],
    ]);
    // three across would give 58 columns, under the 64 floor
    expect(plan.panes.every((p, i) => i === 2 || p.width >= MIN_PANE_COLS)).toBe(true);
  });

  test("a wide tab goes three across", () => {
    const plan = chooseLayout({ width: 260, height: 60, count: 3 })!;
    expect(plan.orientation).toBe("above");
    expect(plan.columns).toBe(3);
    expect(plan.panes.map((p) => p.height)).toEqual([30, 30, 30]);
    expect(plan.panes[0]!.width).toBeGreaterThanOrEqual(MIN_PANE_COLS);
  });

  test("a short wide tab puts the agents beside the chat, because a top chat would be a letterbox", () => {
    // 30 rows cannot give the chat 24 rows and leave usable panes below it, so the chat
    // moves to the left and keeps its full height
    const plan = chooseLayout({ width: 220, height: 30, count: 2 })!;
    expect(plan.orientation).toBe("beside");
    expect(plan.chat).toEqual({ x: 0, y: 0, width: 110, height: 30 });
    expect(plan.panes.map((p) => [p.width, p.height])).toEqual([
      [110, 15],
      [110, 15],
    ]);
    expect(plan.chat.width).toBeGreaterThanOrEqual(MIN_CHAT_COLS);
  });

  test("a tab that cannot give both a chat and unusable panes returns null instead of guessing", () => {
    expect(chooseLayout({ width: 120, height: 30, count: 4 })).toBeNull();
    expect(chooseLayout({ width: 60, height: 20, count: 2 })).toBeNull();
  });

  test("every pane a plan produces clears both floors", () => {
    for (const [width, height, count] of [
      [176, 49, 3],
      [260, 60, 6],
      [200, 45, 4],
      [320, 70, 8],
    ] as const) {
      const plan = chooseLayout({ width, height, count });
      if (plan === null) continue;
      for (const pane of plan.panes) {
        expect(pane.width).toBeGreaterThanOrEqual(MIN_PANE_COLS);
        expect(pane.height).toBeGreaterThanOrEqual(MIN_PANE_ROWS);
      }
      expect(plan.chat.width).toBeGreaterThanOrEqual(MIN_CHAT_COLS);
      expect(plan.chat.height).toBeGreaterThanOrEqual(MIN_CHAT_ROWS);
      expect(plan.panes).toHaveLength(count);
    }
  });
});
