/**
 * Streams an agent's prose into the room as it arrives (#63).
 *
 * Until this existed the room printed only what was appended to `messages.jsonl`, which happens
 * when a turn settles — so a ten-minute turn was ten minutes of silence and then a wall of text.
 * Here, each delta is printed as it arrives and each complete line is flushed, so a reader watches
 * the conversation instead of reading its minutes.
 *
 * The prefix is printed once per burst, matching the settled message format (`[handle] text`, the
 * rest of the text following unprefixed): a new assistant message inside the turn starts a burst of
 * its own, so a report that follows a run of tool lines names its speaker and its time (#66), and a
 * partial line is only ever held, never printed with an invented newline.
 */
import { paintStamp, paintTag } from "./colors";

export interface ChatSink {
  write(s: string): void;
}

import { stampNow } from "./stamp";

/** How long a turn may go quiet before its next line is tagged again: a burst, not a turn (#66). */
const RESUME_TAG_MS = 60_000;

/** How far a continuation line is indented: fixed, so a long handle does not push the text right (#T18). */
const CONTINUATION_INDENT = 4;

/**
 * One room line: the clock, then the tag, then the text, with every continuation line indented four
 * spaces. The clock comes first so a column of times reads top-down, and the handle is not padded —
 * padding it made the text column jump with the roster's longest handle (#T18).
 */
export function roomLine(
  handle: string,
  stamp: string,
  text: string,
  colour: (handle: string) => string | null = () => null,
): string {
  const trailing = text.endsWith("\n");
  const [first = "", ...rest] = (trailing ? text.slice(0, -1) : text).split("\n");
  const body = [first, ...rest.map((line) => (line === "" ? "" : " ".repeat(CONTINUATION_INDENT) + line))].join("\n");
  // The clock takes its own colour, and follows the same switch as the tag: no colour means no escapes
  // anywhere on the line, so `room.log` stays plain.
  const clock = colour(handle) === null ? stamp : paintStamp(stamp);
  return `${clock} ${paintTag(handle, colour)} ${body}${trailing ? "\n" : ""}`;
}

/** A continuation inside one burst: every line starts four spaces in, none carries a tag. */
function indentLines(text: string): string {
  const trailing = text.endsWith("\n");
  const lines = (trailing ? text.slice(0, -1) : text).split("\n");
  const body = lines.map((line) => (line === "" ? "" : " ".repeat(CONTINUATION_INDENT) + line)).join("\n");
  return body + (trailing ? "\n" : "");
}

export class ChatStream {
  /** Agents that have printed in the current turn, so the next text owes no prefix. Turn-scoped: a
   * burst that resumes inside the turn is retagged by the `lastSpeaker`/`lastAt` rule below (#66). */
  private readonly printed = new Set<string>();
  /** Who printed last, and when, per agent: a burst ends on a speaker change or on silence (#66). */
  private lastSpeaker: string | undefined;
  private readonly lastAt = new Map<string, number>();
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
    /** The clock printed beside a speaker: a room with three agents needs the times (T17). */
    private readonly stamp: () => string = stampNow,
    /** Monotonic-ish wall clock for the resume decision, injectable so a test can advance it. */
    private readonly nowMs: () => number = Date.now,
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
    // A new assistant message starts a new burst even inside one turn: the report that follows a run of
    // tool lines names its speaker and its time, instead of hanging under the turn's first tag (#66).
    this.lastSpeaker = undefined;
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
      this.sink.write(roomLine(this.handleOf(agentId), this.stamp(), `(${reason})\n`, this.colourOf));
    this.printed.delete(agentId);
    this.active.delete(agentId);
    return printedThisTurn;
  }

  /** Close every open line, for a failure that arrives outside any single agent's turn. */
  endAll(reason: string): void {
    for (const agentId of [...this.active]) this.end(agentId, reason);
  }

  private writeLines(agentId: string, text: string): void {
    const now = this.nowMs();
    // The tag marks who is speaking now, not who spoke earlier in the turn: another agent's line or a
    // minute of silence starts a new burst, and an untagged continuation would read as theirs (#66).
    const resumed = this.lastSpeaker !== agentId || now - (this.lastAt.get(agentId) ?? now) >= RESUME_TAG_MS;
    // A line is styled whole: a handle can be split across deltas, so per-delta styling would mark a
    // fragment or nothing at all.
    const styled = this.styleOf(text);
    this.sink.write(
      this.printed.has(agentId) && !resumed
        ? indentLines(styled)
        : roomLine(this.handleOf(agentId), this.stamp(), styled, this.colourOf),
    );
    this.printed.add(agentId);
    this.lastSpeaker = agentId;
    this.lastAt.set(agentId, now);
  }
}
