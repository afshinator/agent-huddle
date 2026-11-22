/**
 * Streams an agent's prose into the room as it arrives (#63).
 *
 * Until this existed the room printed only what was appended to `messages.jsonl`, which happens
 * when a turn settles — so a ten-minute turn was ten minutes of silence and then a wall of text.
 * Here, each delta is printed as it arrives and each complete line is flushed, so a reader watches
 * the conversation instead of reading its minutes.
 *
 * The prefix is printed once per turn, matching the settled message format (`[handle] text`, the
 * rest of the text following unprefixed), and a partial line is only ever held, never printed with
 * an invented newline.
 */
import { paintTag } from "./colors";

export interface ChatSink {
  write(s: string): void;
}

export class ChatStream {
  /** Agents that have printed in the current turn, so the next text owes no prefix. */
  private readonly printed = new Set<string>();
  /** Text received but not yet terminated by a newline, per agent. */
  private readonly partial = new Map<string, string>();
  /** Agents with anything in flight this turn, printed or held. */
  private readonly active = new Set<string>();

  constructor(
    private readonly sink: ChatSink,
    private readonly handleOf: (agentId: string) => string,
    /** SGR payload for a handle, or null when colour is off: only the prefix is painted (#70). */
    private readonly colourOf: (handle: string) => string | null = () => null,
    /** Styling for a finished line: mentions are marked there, not in the prefix (#77). */
    private readonly styleOf: (text: string) => string = (text) => text,
  ) {}

  delta(agentId: string, text: string): void {
    if (text === "") return;
    this.active.add(agentId);
    const buffer = (this.partial.get(agentId) ?? "") + text;
    const lines = buffer.split("\n");
    const rest = lines.pop() ?? "";
    this.partial.set(agentId, rest);
    if (lines.length === 0) return;
    this.writeLines(agentId, lines.join("\n") + "\n");
  }

  /**
   * Print the line the provider left unterminated, keeping the turn open.
   *
   * A model often writes "Got it: …" with no trailing newline and then runs tools for a minute. The
   * line used to stay hidden until the next newline arrived, so the acknowledgement only appeared
   * with the final report — the room looked as if the agent skipped it (#75).
   */
  flush(agentId: string): void {
    const held = this.partial.get(agentId) ?? "";
    if (held === "") return;
    this.partial.set(agentId, "");
    this.writeLines(agentId, `${held}\n`);
  }

  /**
   * A new assistant message starts inside the text not yet flushed (#73).
   *
   * A provider may stream a turn's messages glued and only say where the boundary is afterwards. The
   * last `text` characters are that new message, so the line is split there instead of printing a
   * run-on. Nothing is printed twice and the text is kept verbatim.
   */
  messageBoundary(agentId: string, text: string): void {
    if (text === "") return;
    const held = this.partial.get(agentId) ?? "";
    if (!held.endsWith(text) || held.length === text.length) return;
    this.partial.set(agentId, `${held.slice(0, held.length - text.length).replace(/\n?$/, "\n")}${text}`);
  }

  /**
   * The turn is over. Returns false when nothing was ever printed for it, so the caller can fall
   * back to the settled text (a provider may send only `text_end`, with no deltas at all).
   */
  end(agentId: string, reason?: string): boolean {
    const rest = this.partial.get(agentId) ?? "";
    this.partial.delete(agentId);
    if (rest !== "") this.writeLines(agentId, rest + "\n");
    const printedThisTurn = this.printed.has(agentId);
    if (reason !== undefined && printedThisTurn)
      this.sink.write(`[${this.handleOf(agentId).replace(/^@/, "")}] (${reason})\n`);
    this.printed.delete(agentId);
    this.active.delete(agentId);
    return printedThisTurn;
  }

  /** Close every open line, for a failure that arrives outside any single agent's turn. */
  endAll(reason: string): void {
    for (const agentId of [...this.active]) this.end(agentId, reason);
  }

  private writeLines(agentId: string, text: string): void {
    const prefix = this.printed.has(agentId) ? "" : `${paintTag(this.handleOf(agentId), this.colourOf)} `;
    this.printed.add(agentId);
    // A line is styled whole: a handle can be split across deltas, so per-delta styling would
    // mark a fragment or nothing at all.
    this.sink.write(prefix + this.styleOf(text));
  }
}
