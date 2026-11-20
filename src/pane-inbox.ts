import { readFile } from "node:fs/promises";

/**
 * Watches the per-agent inbox files a writable pane writes typed lines into (D7).
 *
 * `track` records the file's current length, so lines that were already in it —
 * a restart, a crashed run — are never replayed as new messages.
 *
 * Only complete lines (terminated by `\n`) are reported: a line is submitted when
 * the human presses Enter, not on every keystroke the pty passes through.
 */
export class PaneInbox {
  private readonly tracked = new Map<string, { path: string; offset: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      onLine: (agentId: string, line: string) => void;
      pollMs?: number;
      read?: (path: string) => Promise<string>;
    },
  ) {}

  private read(path: string): Promise<string> {
    return (this.opts.read ?? ((p: string) => readFile(p, "utf8")))(path);
  }

  /** Start watching `path`, with everything already in it treated as consumed. */
  async track(agentId: string, path: string): Promise<void> {
    const existing = await this.read(path).catch(() => "");
    this.tracked.set(agentId, { path, offset: existing.length });
  }

  /** Read every tracked file once and report lines that arrived since the last poll. */
  async pollOnce(): Promise<void> {
    for (const [agentId, state] of this.tracked) {
      const text = await this.read(state.path).catch(() => "");
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
