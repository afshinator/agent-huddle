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
   * The turn is over. Returns false when nothing was ever printed for it, so the caller can fall
   * back to the settled text (a provider may send only `text_end`, with no deltas at all).
   */
  end(agentId: string, reason?: string): boolean {
    const rest = this.partial.get(agentId) ?? "";
    this.partial.delete(agentId);
    if (rest !== "") this.writeLines(agentId, rest + "\n");
    const printedThisTurn = this.printed.has(agentId);
    if (reason !== undefined && printedThisTurn) this.sink.write(`[${this.handleOf(agentId)}] (${reason})\n`);
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
    this.sink.write(prefix + text);
  }
}
