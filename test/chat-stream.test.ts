import { test, expect, describe } from "bun:test";
import { ChatStream } from "../src/chat-stream";

function make(): { chat: ChatStream; out: string[] } {
  const out: string[] = [];
  const chat = new ChatStream({ write: (s) => out.push(s) }, (id) => `@${id}`);
  return { chat, out };
}

describe("ChatStream", () => {
  test("a delta is printed as it arrives, with the prefix once per turn", () => {
    const { chat, out } = make();
    chat.delta("dev1", "Got it: check the");
    // no newline yet: the line is held, not split with an invented one
    expect(out).toEqual([]);
    chat.delta("dev1", " footer\n");
    expect(out).toEqual(["[@dev1] Got it: check the footer\n"]);
  });

  test("further lines of one turn are not prefixed again", () => {
    const { chat, out } = make();
    chat.delta("dev1", "Got it: x\nsecond line\nthird\n");
    expect(out).toEqual(["[@dev1] Got it: x\nsecond line\nthird\n"]);
  });

  test("each new turn gets its own prefix", () => {
    const { chat, out } = make();
    chat.delta("dev1", "one\n");
    chat.end("dev1");
    chat.delta("dev1", "two\n");
    expect(out).toEqual(["[@dev1] one\n", "[@dev1] two\n"]);
  });

  test("end flushes a partial line and reports whether anything was printed", () => {
    const { chat, out } = make();
    expect(chat.end("dev1")).toBe(false);
    chat.delta("dev1", "half a sentence");
    expect(chat.end("dev1")).toBe(true);
    expect(out).toEqual(["[@dev1] half a sentence\n"]);
  });

  test("a turn that dies says so, and only when it had text on screen", () => {
    const quiet = make();
    quiet.chat.end("dev1", "interrupted");
    expect(quiet.out).toEqual([]);

    const talking = make();
    talking.chat.delta("dev1", "starting the audit");
    talking.chat.end("dev1", "interrupted");
    expect(talking.out).toEqual(["[@dev1] starting the audit\n", "[@dev1] (interrupted)\n"]);
  });

  test("two agents streaming at once keep their own prefixes and lines", () => {
    const { chat, out } = make();
    chat.delta("dev1", "checking the\n");
    chat.delta("reviewer", "reading\n");
    chat.delta("dev1", "footer\n");
    expect(out).toEqual(["[@dev1] checking the\n", "[@reviewer] reading\n", "footer\n"]);
  });

  test("endAll closes whatever is open, once, with the reason", () => {
    const { chat, out } = make();
    chat.delta("dev1", "mid sentence");
    chat.endAll("turn failed");
    chat.endAll("turn failed");
    expect(out).toEqual(["[@dev1] mid sentence\n", "[@dev1] (turn failed)\n"]);
  });
});
