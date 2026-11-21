/**
 * Agent colours: the one file to edit.
 *
 * Each agent gets an RGB triple, and the `[@handle]` prefix of its messages is printed in that
 * colour, so a reader can tell who is speaking without parsing the prefix. A handle named inside
 * somebody's text stays plain: colour marks the speaker, never the subject (#70). Nothing else in
 * the repo restates these values.
 *
 * RGB rather than the 16-colour names on purpose: a named colour resolves against the reader's
 * terminal theme, so `red` is one thing in a light theme and another in a dark one. A 24-bit
 * triple looks the same everywhere herdr is running with truecolor.
 */
export type Rgb = [number, number, number];

/** agent id → colour. Edit freely; an agent you remove falls back to the list below. */
export const AGENT_RGB: Record<string, Rgb> = {
  lead: [230, 170, 80], // amber
  dev1: [90, 170, 255], // blue
  reviewer: [180, 140, 240], // violet
};

/** Agents the table does not name take these in slot order, wrapping around. */
export const FALLBACK_RGB: Rgb[] = [
  [120, 200, 160],
  [240, 120, 160],
  [200, 200, 120],
];

/** `"rgb"` is 24-bit truecolor; `"256"` uses the 256-colour cube when a terminal lacks it. */
export const PALETTE_MODE: "rgb" | "256" = "rgb";

const RESET = "\u001b[0m";

/** `r;g;b` in the form the escape needs, or `38;5;n` in 256-colour mode. */
export function colorOf(id: string, slot: number, table: Record<string, Rgb> = AGENT_RGB): string {
  const rgb = table[id] ?? FALLBACK_RGB[slot % FALLBACK_RGB.length]!;
  if (PALETTE_MODE === "256") return `38;5;${toAnsi256(rgb)}`;
  return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/** Rough 6x6x6 cube mapping, only used when `PALETTE_MODE` is `"256"`. */
function toAnsi256([r, g, b]: Rgb): number {
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** A bare `@handle`, coloured: what a pane opens with, and the only place a mention is painted. */
export function paintHandle(handle: string, colour: (handle: string) => string | null): string {
  const code = colour(handle);
  return code === null ? handle : `\u001b[${code}m${handle}${RESET}`;
}

/** The `[@handle]` prefix a room message carries, coloured. */
export function paintTag(handle: string, colour: (handle: string) => string | null): string {
  const code = colour(handle);
  return code === null ? `[${handle}]` : `\u001b[${code}m[${handle}]${RESET}`;
}

/** Drop every escape sequence: `room.log` is meant to be greppable. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** `AH_COLOR=1` forces colour, `AH_COLOR=0` or `NO_COLOR` kills it, else the terminal decides. */
export function colorEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.AH_COLOR === "1") return true;
  if (env.AH_COLOR === "0") return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTty;
}
