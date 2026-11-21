/**
 * Where the time in a run went, per agent.
 *
 * A room is mostly waiting: for a model's first token, for a tool to finish, for the model to think
 * about what a tool returned. Those look identical in a pane, so this reads the agent logs and says
 * which one it was. `delta` / `tool_start` / `tool_end` / `settled` all carry a timestamp; a gap with
 * no event in it is a stall, a gap after `tool_start` is the tool, anything else is the model.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface LogLine {
  ts: string;
  event: string;
  text?: string;
}

export interface Interval {
  /** ms since the previous event in the same turn. */
  ms: number;
  /** What happened just before the wait started. */
  after: string;
  /** What ended it, or "turn end". */
  until: string;
}

export interface TurnTiming {
  agentId: string;
  start: string;
  end: string;
  totalMs: number;
  /** Dispatch to the first event: the provider's first-token latency. */
  firstEventMs: number;
  firstEvent: string;
  /** The longest wait inside the turn, and what caused it. */
  longest: Interval | null;
  /** Time inside tools, from `tool_end`'s own measurement. */
  toolMs: number;
  events: number;
}

/**
 * A turn is one `turn_start` (the dispatch) to its `settled`, for a given agent.
 *
 * Everything before a dispatch belongs to the room waiting, not to the agent working: a reviewer
 * spawned at boot and dispatched three minutes later spent none of that time on its turn, and counting
 * it made the first-token latency look like three minutes.
 */
export function turnTimings(agentId: string, lines: LogLine[]): TurnTiming[] {
  const turns: TurnTiming[] = [];
  let current: LogLine[] = [];
  for (const line of lines) {
    if (line.event === "turn_start") current = [line];
    else if (current.length > 0) current.push(line);
    if (line.event !== "settled" || current.length === 0) continue;
    const t = summarise(agentId, current);
    if (t !== null) turns.push(t);
    current = [];
  }
  // A turn still open at the end of the log is worth reporting: it may be the one that stalled.
  const open = summarise(agentId, current);
  if (open !== null) turns.push(open);
  return turns;
}

function summarise(agentId: string, lines: LogLine[]): TurnTiming | null {
  const timed = lines.filter((l) => !Number.isNaN(Date.parse(l.ts)));
  if (timed.length < 2) return null;
  const first = timed[0]!;
  const last = timed[timed.length - 1]!;
  let longest: Interval | null = null;
  let toolMs = 0;
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1]!;
    const now = timed[i]!;
    const ms = Date.parse(now.ts) - Date.parse(prev.ts);
    if (longest === null || ms > longest.ms) longest = { ms, after: prev.event, until: now.event };
    if (now.event === "tool_end") {
      const measured = / (\d+)ms$/.exec(now.text ?? "");
      if (measured) toolMs += Number(measured[1]);
    }
  }
  return {
    agentId,
    start: first.ts,
    end: last.ts,
    totalMs: Date.parse(last.ts) - Date.parse(first.ts),
    firstEventMs: Date.parse(timed[1]!.ts) - Date.parse(first.ts),
    firstEvent: timed[1]!.event,
    longest,
    toolMs,
    events: timed.length,
  };
}

/** Every agent that has a log in a run directory, in a stable order. */
export function readRun(runDir: string): Map<string, LogLine[]> {
  const dir = join(runDir, "agents");
  if (!existsSync(dir)) return new Map();
  const out = new Map<string, LogLine[]>();
  for (const agentId of readdirSync(dir).sort()) {
    const path = join(dir, agentId, "log.jsonl");
    if (!existsSync(path)) continue;
    const lines: LogLine[] = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const parsed = JSON.parse(raw) as LogLine;
        if (typeof parsed.ts === "string" && typeof parsed.event === "string") lines.push(parsed);
      } catch {
        // a half-written line is not a reason to fail a readout
      }
    }
    out.set(agentId, lines);
  }
  return out;
}

/** One line per turn, longest wait named with what preceded it. */
export function formatRun(timings: Map<string, TurnTiming[]>): string {
  const rows: string[] = [];
  for (const [agentId, turns] of timings) {
    for (const t of turns) {
      const longest = t.longest === null ? "—" : `${(t.longest.ms / 1000).toFixed(1)}s after ${t.longest.after} → ${t.longest.until}`;
      rows.push(
        `${agentId.padEnd(9)} ${t.start}  total ${(t.totalMs / 1000).toFixed(1)}s` +
          `  first ${(t.firstEventMs / 1000).toFixed(2)}s (${t.firstEvent})` +
          `  tools ${(t.toolMs / 1000).toFixed(1)}s  longest ${longest}`,
      );
    }
  }
  return rows.join("\n");
}

if (import.meta.path === Bun.main) {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    console.error("usage: bun src/timings.ts <run-dir>");
    process.exit(2);
  }
  const logs = readRun(runDir);
  if (logs.size === 0) {
    console.error(`no agent logs under ${join(runDir, "agents")}`);
    process.exit(2);
  }
  const timings = new Map<string, TurnTiming[]>();
  for (const [agentId, lines] of logs) timings.set(agentId, turnTimings(agentId, lines));
  console.log(formatRun(timings));
}
