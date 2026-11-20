import { test, expect } from "bun:test";
import { createDebug, debugEnabled } from "../src/debug";

/**
 * A room's own lifecycle trace (#55). Diagnosing #51 needed hand-patched
 * `process.stderr.write` probe lines in `src/index.ts` and the real client, twice, only to
 * learn whether the SIGINT handler ran before the children's exit callbacks. These are the
 * lines that answer it, off unless `AH_DEBUG=1`.
 */
test("a debug line carries the elapsed milliseconds", () => {
  const lines: string[] = [];
  let clock = 1_000;
  const debug = createDebug({ enabled: true, write: (s) => lines.push(s), now: () => clock });

  debug("signal SIGINT");
  clock = 1_002.5;
  debug("child exit dev1 code=0 signal=null");

  expect(lines).toEqual([
    "[debug +0.0ms] signal SIGINT\n",
    "[debug +2.5ms] child exit dev1 code=0 signal=null\n",
  ]);
});

test("nothing is written when debug is off", () => {
  const lines: string[] = [];
  const debug = createDebug({ enabled: false, write: (s) => lines.push(s), now: () => 0 });

  debug("signal SIGINT");

  expect(lines).toEqual([]);
});

test("the switch is AH_DEBUG=1, not any truthy string", () => {
  expect(debugEnabled({ AH_DEBUG: "1" } as NodeJS.ProcessEnv)).toBe(true);
  expect(debugEnabled({ AH_DEBUG: "0" } as NodeJS.ProcessEnv)).toBe(false);
  expect(debugEnabled({ AH_DEBUG: "true" } as NodeJS.ProcessEnv)).toBe(false);
  expect(debugEnabled({} as NodeJS.ProcessEnv)).toBe(false);
});
