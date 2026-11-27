// Every default `docs/SPEC.md` states, compared with the constant that decides it.
//
// A stated default is a value copied out of the code: right until the code moves and then silently wrong.
// The expected value here comes from the import, never from a remembered figure. A doc that stops stating
// one is a failure too — `null` is not a number, so a reworded line cannot read as green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_MAX_HOPS, DEFAULT_TURN_TIMEOUT_MS } from "../src/config";

const repo = new URL("..", import.meta.url).pathname;
const SPEC = readFileSync(repo + "docs/SPEC.md", "utf8").split("\n");

/** The `// default N` a SPEC interface line states, or null when it states none. */
function statedDefault(field: string): number | null {
  // The interface form, `max_hops: number;`, so a YAML example (`max_hops: 20`) is not the line read.
  const line = SPEC.find((l) => new RegExp(`^\\s*${field}: \\w+;`).test(l));
  const stated = line?.match(/\/\/\s*default\s+([\d_]+)/);
  return stated === undefined || stated === null ? null : Number(stated[1]!.replaceAll("_", ""));
}

describe("the defaults SPEC states are the ones the code decides", () => {
  test("max_hops", () => {
    expect(statedDefault("max_hops")).toBe(DEFAULT_MAX_HOPS);
  });

  test("turn_timeout_ms", () => {
    expect(statedDefault("turn_timeout_ms")).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });
});
