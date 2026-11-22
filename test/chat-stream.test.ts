import { test, expect, describe } from "bun:test";
import { ChatStream } from "../src/chat-stream";

const AT = "12:00:00";

function make(): { chat: ChatStream; out: string[] } {
  const out: string[] = [];
  const chat = new ChatStream(
    { write: (s) => out.push(s) },
    (id) => `@${id}`,
    () => null,
    (text) => text,
    () => AT,
  );
  return { chat, out };
}

describe("ChatStream", () => {
  test("a delta is printed as it arrives, with the prefix once per turn", () => {
    const { chat, out } = make();
    chat.delta("dev1", "Got it: check the");
    // no newline yet: the line is held, not split with an invented one
    expect(out).toEqual([]);
    chat.delta("dev1", " footer\n");
    expect(out).toEqual([`[dev1] ${AT} Got it: check the footer\n`]);
  });

  test("flush prints the line the provider left unterminated", () => {
    const { chat, out } = make();
    // dev1 wrote "Got it: …" with no trailing newline, then ran tools for 40 seconds; the line
    // was held all that time and only appeared with the final report (#75).
    chat.delta("dev1", "Got it: tally every tracked .md file");
    expect(out).toEqual([]);
    chat.flush("dev1");

    expect(out).toEqual([`[dev1] ${AT} Got it: tally every tracked .md file\n`]);
    // the turn continues on a fresh line, with no second prefix
    chat.delta("dev1", "Row count: 28\n");
    expect(out.join("")).toBe(`[dev1] ${AT} Got it: tally every tracked .md file\nRow count: 28\n`);
  });

  test("flush with nothing held prints nothing", () => {
    const { chat, out } = make();
    chat.delta("dev1", "one line\n");
    chat.flush("dev1");
    expect(out).toEqual([`[dev1] ${AT} one line\n`]);
  });

  test("a message boundary splits the line the turn has not flushed yet", () => {
    const { chat, out } = make();
    // The provider streams two assistant messages glued, then says where the second one starts.
    chat.delta("dev1", "Got it: tally the docs.");
    chat.delta("dev1", "Got it: tally written.");
    chat.messageBoundary("dev1", "Got it: tally written.");
    chat.delta("dev1", "\n");

    expect(out).toEqual([`[dev1] ${AT} Got it: tally the docs.\nGot it: tally written.\n`]);
  });

  test("a boundary that does not match what is held changes nothing", () => {
    const { chat, out } = make();
    chat.delta("dev1", "Got it: one thing");
    chat.messageBoundary("dev1", "something else");
    chat.delta("dev1", "\n");
    expect(out).toEqual([`[dev1] ${AT} Got it: one thing\n`]);
  });

  test("a mention is inverted in a line however the deltas split it", () => {
    const out: string[] = [];
    const chat = new ChatStream(
      { write: (s) => out.push(s) },
      (id) => `@${id}`,
      () => null,
      (text) => text.replace(/(@[a-z0-9]+)/g, "\u001b[7m$1\u001b[0m"),
      () => AT,
    );
    // the handle arrives in two pieces, so styling has to happen on the finished line
    chat.delta("dev1", "verify with @rev");
    chat.delta("dev1", "iewer please\n");

    expect(out).toEqual([`[dev1] ${AT} verify with \u001b[7m@reviewer\u001b[0m please\n`]);
  });

  test("the prefix is painted with the agent's colour, and the prose is not", () => {
    const out: string[] = [];
    const chat = new ChatStream(
      { write: (s) => out.push(s) },
      (id) => `@${id}`,
      (handle) => (handle === "@dev1" ? "38;2;90;170;255" : null),
      (text) => text,
      () => AT,
    );
    chat.delta("dev1", "Got it: plain prose naming @dev1\n");

    // colour marks the speaker; the mention inside the sentence stays plain (#70)
    expect(out).toEqual([`\u001b[38;2;90;170;255m[dev1]\u001b[0m ${AT} Got it: plain prose naming @dev1\n`]);
  });

  test("a line carries the time it was said, so a reader can order two speakers (T17)", () => {
    const { chat, out } = make();
    chat.delta("dev1", "one\n");
    chat.end("dev1");
    chat.delta("reviewer", "two\n");
    // Both stamps come from the same clock in a test; what matters is that the line carries one at all.
    expect(out).toEqual([`[dev1] ${AT} one\n`, `[reviewer] ${AT} two\n`]);
  });

  test("further lines of one turn are not prefixed again", () => {
    const { chat, out } = make();
    chat.delta("dev1", "Got it: x\nsecond line\nthird\n");
    expect(out).toEqual([`[dev1] ${AT} Got it: x\nsecond line\nthird\n`]);
  });

  test("each new turn gets its own prefix", () => {
    const { chat, out } = make();
    chat.delta("dev1", "one\n");
    chat.end("dev1");
    chat.delta("dev1", "two\n");
    expect(out).toEqual([`[dev1] ${AT} one\n`, `[dev1] ${AT} two\n`]);
  });

  test("end flushes a partial line and reports whether anything was printed", () => {
    const { chat, out } = make();
    expect(chat.end("dev1")).toBe(false);
    chat.delta("dev1", "half a sentence");
    expect(chat.end("dev1")).toBe(true);
    expect(out).toEqual([`[dev1] ${AT} half a sentence\n`]);
  });

  test("a turn that dies says so, and only when it had text on screen", () => {
    const quiet = make();
    quiet.chat.end("dev1", "interrupted");
    expect(quiet.out).toEqual([]);

    const talking = make();
    talking.chat.delta("dev1", "starting the audit");
    talking.chat.end("dev1", "interrupted");
    expect(talking.out).toEqual([`[dev1] ${AT} starting the audit\n`, `[dev1] ${AT} (interrupted)\n`]);
  });

  test("two agents streaming at once keep their own prefixes and lines", () => {
    const { chat, out } = make();
    chat.delta("dev1", "checking the\n");
    chat.delta("reviewer", "reading\n");
    chat.delta("dev1", "footer\n");
    expect(out).toEqual([`[dev1] ${AT} checking the\n`, `[reviewer] ${AT} reading\n`, "footer\n"]);
  });

  test("endAll closes whatever is open, once, with the reason", () => {
    const { chat, out } = make();
    chat.delta("dev1", "mid sentence");
    chat.endAll("turn failed");
    chat.endAll("turn failed");
    expect(out).toEqual([`[dev1] ${AT} mid sentence\n`, `[dev1] ${AT} (turn failed)\n`]);
  });
});
