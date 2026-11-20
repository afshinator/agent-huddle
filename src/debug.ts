/**
 * A room's own lifecycle trace, off unless `AH_DEBUG=1` (#55).
 *
 * Diagnosing #51 needed `process.stderr.write` probe lines hand-patched into `src/index.ts`
 * and the real client, twice, to answer one question: did the coordinator's SIGINT handler
 * run before the children's exit callbacks? Nothing in the room could say. These lines can,
 * and they answer it from outside: the signal, the stop, then each child's exit code.
 *
 * One line per event with elapsed milliseconds, to stderr — never the room's stdout, which
 * is the conversation. Not telemetry: a crash before boot writes no telemetry, and this is
 * the trace that outlives it.
 */
export type Debug = (message: string) => void;

/** A trace that writes nothing: the default, and what `AH_DEBUG` off gives you. */
const silent: Debug = () => {};

export function createDebug(opts: {
  enabled: boolean;
  write: (s: string) => void;
  now?: () => number;
}): Debug {
  if (!opts.enabled) return silent;
  const now = opts.now ?? (() => performance.now());
  const start = now();
  return (message: string) => {
    opts.write(`[debug +${(now() - start).toFixed(1)}ms] ${message}\n`);
  };
}

/** `AH_DEBUG=1` exactly: `true`, `yes` and `0` are not the switch. */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AH_DEBUG === "1";
}
