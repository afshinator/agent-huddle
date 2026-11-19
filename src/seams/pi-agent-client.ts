import { join } from "node:path";
import type { AgentSpec } from "../config";

export interface SpawnOptions {
  cwd: string;
}

export interface PromptRequest {
  message: string;                 // composed room message for this turn
  streamingBehavior?: "followUp" | "steer";
}

export interface SettledResult {
  aborted: boolean;
  lastText: string | null;
}

export interface AgentProcessInfo {
  sessionDir: string;
  sessionFile?: string;
  pid: number;
}

export interface PiAgentClient {
  spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo>;
  prompt(agentId: string, req: PromptRequest): Promise<void>;      // accepted, not settled
  pushContext(agentId: string, text: string): Promise<void>;       // D8/Q3 (§6.6)
  waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult>;
  getLastAssistantText(agentId: string): Promise<string | null>;
  shutdown(agentId: string): Promise<void>;
  on(event: "settled", agentId: string, fn: (r: SettledResult) => void): void;
  on(event: "stream", agentId: string, fn: (delta: string) => void): void;
  on(event: "error", agentId: string, fn: (err: Error) => void): void;
}

/** One scripted turn: stream deltas then a settled result (or an error). */
export interface ScriptedTurn {
  deltas?: string[];
  lastText?: string | null;
  aborted?: boolean;
  error?: Error;
}

export interface RecordedCall {
  op: "spawn" | "prompt" | "pushContext" | "shutdown";
  agentId: string;
  payload: unknown;
}

type ListenerEvent = "settled" | "stream" | "error";

interface FakeAgent {
  spec: AgentSpec;
  spawned: boolean;
  shutdown: boolean;
  script: ScriptedTurn[];
  lastText: string | null;
  settle: { promise: Promise<SettledResult>; resolve: (r: SettledResult) => void } | null;
}

export class FakePiAgentClient implements PiAgentClient {
  readonly calls: RecordedCall[] = [];
  private readonly agents = new Map<string, FakeAgent>();
  private readonly listeners = new Map<string, Map<ListenerEvent, Array<(arg: any) => void>>>();
  private nextPid = 1000;

  constructor(private readonly baseDir = "/fake/sessions") {}

  /** Queue scripted turns for an agent (consumed FIFO on each prompt). */
  script(agentId: string, turns: ScriptedTurn[]): void {
    this.requireAgent(agentId).script.push(...turns);
  }

  async spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo> {
    if (!this.agents.has(agent.id)) {
      this.agents.set(agent.id, {
        spec: agent,
        spawned: false,
        shutdown: false,
        script: [],
        lastText: null,
        settle: null,
      });
      this.listeners.set(agent.id, new Map<ListenerEvent, Array<(arg: any) => void>>([
        ["settled", []],
        ["stream", []],
        ["error", []],
      ]));
    }
    const a = this.agents.get(agent.id)!;
    a.spawned = true;
    a.shutdown = false;
    this.record("spawn", agent.id, opts);
    return { sessionDir: join(this.baseDir, agent.id, "sessions"), pid: this.nextPid++ };
  }

  async prompt(agentId: string, req: PromptRequest): Promise<void> {
    const a = this.requireAgent(agentId);
    this.record("prompt", agentId, req);
    const turn = a.script.shift() ?? { lastText: null };

    let resolveSettle!: (r: SettledResult) => void;
    let rejectSettle!: (e: Error) => void;
    const promise = new Promise<SettledResult>((res, rej) => {
      resolveSettle = res;
      rejectSettle = rej;
    });
    promise.catch(() => {}); // a rejected turn is observed via waitForSettled
    a.settle = { promise, resolve: resolveSettle };

    queueMicrotask(() => {
      if (turn.error) {
        for (const fn of this.ls(agentId, "error")) fn(turn.error);
        a.lastText = null;
        rejectSettle(turn.error);
        return;
      }
      for (const delta of turn.deltas ?? []) {
        for (const fn of this.ls(agentId, "stream")) fn(delta);
      }
      const result: SettledResult = {
        aborted: turn.aborted ?? false,
        lastText: turn.lastText ?? null,
      };
      a.lastText = result.lastText;
      resolveSettle(result);
      for (const fn of this.ls(agentId, "settled")) fn(result);
    });
  }

  async pushContext(agentId: string, text: string): Promise<void> {
    this.requireAgent(agentId);
    this.record("pushContext", agentId, text);
  }

  async waitForSettled(agentId: string, _timeoutMs: number): Promise<SettledResult> {
    const a = this.requireAgent(agentId);
    return a.settle ? a.settle.promise : { aborted: false, lastText: a.lastText };
  }

  async getLastAssistantText(agentId: string): Promise<string | null> {
    return this.requireAgent(agentId).lastText;
  }

  async shutdown(agentId: string): Promise<void> {
    const a = this.requireAgent(agentId);
    a.shutdown = true;
    this.record("shutdown", agentId, undefined);
  }

  on(event: ListenerEvent, agentId: string, fn: (arg: any) => void): void {
    this.listeners.get(agentId)!.get(event)!.push(fn);
  }

  private requireAgent(agentId: string): FakeAgent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`FakePiAgentClient: unknown agent "${agentId}"`);
    return a;
  }

  private ls(agentId: string, event: ListenerEvent): Array<(arg: any) => void> {
    return this.listeners.get(agentId)!.get(event)!;
  }

  private record(op: RecordedCall["op"], agentId: string, payload: unknown): void {
    this.calls.push({ op, agentId, payload });
  }
}
