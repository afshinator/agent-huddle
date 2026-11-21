/**
 * Pane layout for a room: where the chat pane and each agent pane go.
 *
 * The numbers below are the only place they are defined. Change a floor here and every
 * consumer follows; nothing else in the code or the docs restates them.
 *
 * Measured inputs (pi-herdr-panes/SPEC.md, live probes): `herdr pane split --ratio r` means the
 * *existing* pane keeps `r`; equal slices of one base pane use `(n-k)/(n-k+1)`; splitting with a
 * flat 0.5 once per pane produces a staircase, not slices.
 */

/** A pane narrower than this is not a usable log tail: 64 columns fits 80-char lines wrapped once. */
export const MIN_PANE_COLS = 64;

/** Fewer rows than this and a turn cannot be read without scrolling. */
export const MIN_PANE_ROWS = 8;

/** The chat pane must stay wide enough for room messages; below this the room is unreadable. */
export const MIN_CHAT_COLS = 100;

/** Eight agent panes can stack above this many rows; below it the chat is a letterbox. */
export const MIN_CHAT_ROWS = 24;

/** Width over height, in cells, that reads well: 80x26 is about 3.0. */
export const TARGET_ASPECT = 3.0;

/** Share of the tab the chat pane keeps when the agent region is carved from it. */
export const CHAT_SHARE = 0.5;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPlan {
  orientation: "above" | "beside";
  chat: Rect;
  panes: Rect[];
  columns: number;
  rows: number;
}

/** Equal slices of one base pane, as herdr spells them: ratio `(n-k)/(n-k+1)` for k = 1..n-1. */
export function sliceRatios(n: number): number[] {
  if (n < 1) return [];
  return Array.from({ length: n - 1 }, (_, i) => {
    const k = i + 1;
    return (n - k) / (n - k + 1);
  });
}

function aspect(rect: Rect): number {
  return rect.height === 0 ? Number.POSITIVE_INFINITY : rect.width / rect.height;
}

/** Lower is better: distance from the target aspect, plus a nudge for panes left empty. */
function score(rects: Rect[], slots: number): number {
  const worst = Math.max(...rects.map((r) => Math.abs(Math.log(aspect(r) / TARGET_ASPECT))));
  return worst + 0.02 * Math.max(0, slots - rects.length);
}

/**
 * Candidate grids for a region: `columns` panes across, last row stretched to the full width
 * when the count does not divide evenly, so no cell is left as a hole.
 */
function grid(region: Rect, columns: number, rows: number, count: number): Rect[] | null {
  if (columns < 1 || rows < 1) return null;
  const cellWidth = Math.floor(region.width / columns);
  const cellHeight = Math.floor(region.height / rows);
  if (columns > 1 && cellWidth < MIN_PANE_COLS) return null;
  if (rows > 1 && cellHeight < MIN_PANE_ROWS) return null;
  if (columns === 1 && region.width < MIN_PANE_COLS) return null;
  if (rows === 1 && region.height < MIN_PANE_ROWS) return null;

  const rects: Rect[] = [];
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    const column = index % columns;
    const width = Math.floor(region.width / inRow);
    rects.push({
      x: region.x + column * width,
      y: region.y + row * cellHeight,
      width,
      height: cellHeight,
    });
  }
  return rects;
}

/**
 * Choose a layout for `count` agent panes in a `width` x `height` cell tab, or null when the tab
 * cannot give the chat and every pane their floors (the caller then degrades and says so).
 */
export function chooseLayout(input: {
  width: number;
  height: number;
  count: number;
  minPaneCols?: number;
  minPaneRows?: number;
  minChatCols?: number;
  minChatRows?: number;
  targetAspect?: number;
  chatShare?: number;
}): LayoutPlan | null {
  const width = input.width;
  const height = input.height;
  const count = input.count;
  const minChatCols = input.minChatCols ?? MIN_CHAT_COLS;
  const minChatRows = input.minChatRows ?? MIN_CHAT_ROWS;
  const chatShare = input.chatShare ?? CHAT_SHARE;

  let best: { plan: LayoutPlan; score: number } | null = null;

  for (const orientation of ["above", "beside"] as const) {
    const chatHeight = orientation === "above" ? Math.round(height * chatShare) : height;
    const chatWidth = orientation === "beside" ? Math.round(width * chatShare) : width;
    if (chatWidth < minChatCols || chatHeight < minChatRows) continue;

    const region: Rect =
      orientation === "above"
        ? { x: 0, y: chatHeight, width, height: height - chatHeight }
        : { x: chatWidth, y: 0, width: width - chatWidth, height };

    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      const rects = grid(region, columns, rows, count);
      if (rects === null) continue;
      const plan: LayoutPlan = {
        orientation,
        chat:
          orientation === "above"
            ? { x: 0, y: 0, width, height: chatHeight }
            : { x: 0, y: 0, width: chatWidth, height },
        panes: rects,
        columns,
        rows,
      };
      const value = score(rects, count);
      if (best === null || value < best.score) best = { plan, score: value };
    }
  }

  return best?.plan ?? null;
}
