/**
 * Agent colours: the one file to edit.
 *
 * Each agent gets an RGB triple, and the `[handle]` prefix of its messages is printed in that
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
  lead: [238, 180, 0], // 🟨, sampled from the system emoji font
  dev1: [5, 93, 242], // 🟦
  reviewer: [185, 49, 255], // 🟪
};

/**
 * Pane-title marks: a title cannot carry an escape (herdr prints it as text), but it can carry a
 * coloured square. Same file as the colour so the two stay edited together.
 */
export const AGENT_MARK: Record<string, string> = {
  lead: "🟨",
  dev1: "🟦",
  reviewer: "🟪",
};

/** Marks for agents the table does not name, in slot order. */
export const FALLBACK_MARKS = ["🟩", "🟥", "🟧"];

/** The mark a pane title starts with, so a tab bar tells agents apart at a glance (#72). */
export function markOf(id: string, slot: number): string {
  return AGENT_MARK[id] ?? FALLBACK_MARKS[slot % FALLBACK_MARKS.length]!;
}

/**
 * Agents the table does not name take these in slot order, wrapping around. Sampled the same way,
 * so a fallback agent's text matches the mark in its pane title.
 */
export const FALLBACK_RGB: Rgb[] = [
  [0, 177, 0], // 🟩
  [212, 33, 17], // 🟥
  [255, 138, 4], // 🟧
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

/**
 * Invert every mention of an agent inside a line of text.
 *
 * Colour marks who is speaking, so a name inside a sentence stays uncoloured (#70); inverse video marks
 * the name as an address rather than a word — `@reviewer verify this` reads as a hand-off (#77). Italic
 * was too quiet to find in a wall of prose, so the mark is a solid block (1715407).
 * Only handles the room knows, and only where the `@` starts a word, so `a@dev1.com` and `@dev12`
 * are left alone.
 */
export function markMentions(text: string, known: (handle: string) => boolean): string {
  return text.replace(/(^|[^\w@])(@[A-Za-z0-9_-]+)/g, (match, lead: string, handle: string) => {
    return known(handle) ? `${lead}\u001b[7m${handle}${RESET}` : match;
  });
}

/** The `[handle]` prefix a room message carries, coloured. The `@` is mention syntax, not the name. */
export function paintTag(handle: string, colour: (handle: string) => string | null): string {
  const code = colour(handle);
  const name = handle.replace(/^@/, "");
  return code === null ? `[${name}]` : `\u001b[${code}m[${name}]${RESET}`;
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
