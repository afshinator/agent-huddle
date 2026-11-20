import { readFile } from "node:fs/promises";

/**
 * Watches the per-agent inbox files a writable pane writes typed lines into (D7).
 *
 * `track` records the file's current length, so lines that were already in it —
 * a restart, a crashed run — are never replayed as new messages.
 *
 * Only complete lines (terminated by `\n`) are reported: a line is submitted when
 * the human presses Enter, not on every keystroke the pty passes through.
 *
 * A read that fails is reported to `onError`, never swallowed: a silent failure here
 * means typed lines vanish with no record anywhere (#46). A missing file is not a
 * failure — it is the normal state before the first line — so `ENOENT` stays quiet.
 */
export class PaneInbox {
  private readonly tracked = new Map<string, { path: string; offset: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      onLine: (agentId: string, line: string) => void;
      /** Called on every failed read; the caller decides how often to record it. */
      onError?: (agentId: string, error: unknown) => void;
      pollMs?: number;
      read?: (path: string) => Promise<string>;
    },
  ) {}

  private read(path: string): Promise<string> {
    return (this.opts.read ?? ((p: string) => readFile(p, "utf8")))(path);
  }

  /** Read a tracked file, or `null` when it cannot be read (missing counts as empty). */
  private async readOrNull(agentId: string, path: string): Promise<string | null> {
    try {
      return await this.read(path);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") this.opts.onError?.(agentId, e);
      return null;
    }
  }

  /** Start watching `path`, with everything already in it treated as consumed. */
  async track(agentId: string, path: string): Promise<void> {
    const existing = await this.readOrNull(agentId, path);
    this.tracked.set(agentId, { path, offset: existing?.length ?? 0 });
  }

  /** Read every tracked file once and report lines that arrived since the last poll. */
  async pollOnce(): Promise<void> {
    for (const [agentId, state] of this.tracked) {
      const text = await this.readOrNull(agentId, state.path);
      if (text === null) continue;
      // A truncated or rewritten file starts over rather than being skipped.
      if (text.length < state.offset) state.offset = 0;
      const fresh = text.slice(state.offset);
      if (fresh === "") continue;

      const parts = fresh.split("\n");
      const partial = parts.pop() ?? "";
      state.offset += fresh.length - partial.length;
      for (const line of parts) {
        if (line.trim() !== "") this.opts.onLine(agentId, line);
      }
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.opts.pollMs ?? 250);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
