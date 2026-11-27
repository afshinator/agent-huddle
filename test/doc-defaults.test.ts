// Every default `docs/SPEC.md` states, compared with the constant that decides it.
//
// A stated default is a value copied out of the code: right until the code moves and then silently wrong.
// The expected value here comes from the import, never from a remembered figure. A doc that stops stating
// one is a failure too — `null` is not the constant, so a reworded line cannot read as green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ACK_SCOPE,
  DEFAULT_DISPATCH_SCOPE,
  DEFAULT_LAUNCH_GUARD,
  DEFAULT_MAX_HOPS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "../src/config";

const repo = new URL("..", import.meta.url).pathname;
const SPEC = readFileSync(repo + "docs/SPEC.md", "utf8").split("\n");

/** The `// default x` a SPEC interface line states, or null when no line states one. */
function statedDefault(field: string): string | null {
  // The interface form, so a YAML example (`max_hops: 20  # …`) is not the line read.
  const line = SPEC.find((l) => new RegExp(`^\\s*${field}\\??:`).test(l) && l.includes("// default"));
  const stated = line?.match(/\/\/\s*default\s+([\w_]+)/);
  return stated === undefined || stated === null ? null : stated[1]!.replaceAll("_", "");
}

const cases: Array<[string, string]> = [
  ["max_hops", String(DEFAULT_MAX_HOPS)],
  ["turn_timeout_ms", String(DEFAULT_TURN_TIMEOUT_MS)],
  ["launch_guard", DEFAULT_LAUNCH_GUARD],
  ["ack_scope", DEFAULT_ACK_SCOPE],
  ["dispatch_scope", DEFAULT_DISPATCH_SCOPE],
];

describe("the defaults SPEC states are the ones the code decides", () => {
  for (const [field, decided] of cases) {
    test(field, () => {
      expect(statedDefault(field)).toBe(decided);
    });
  }
});
