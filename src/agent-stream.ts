import { appendFile } from "node:fs/promises";

/** Tool arguments on one line, short enough to read in a pane. */
function oneLine(args: unknown): string {
  const text = JSON.stringify(args) ?? String(args);
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

/**
 * Human-readable per-agent stream (D7): the pane tails this file instead of `log.jsonl`.
 *
 * Rules, in one place so the pane's appearance is testable without a coordinator:
 * - prose is written verbatim, so streamed deltas read as paragraphs, not fragments;
 * - a turn ends with a blank line, so turns stay visually separate;
 * - a turn that streamed nothing writes its settled text instead (a provider may send
 *   `text_end` without `text_delta`), so the pane never loses a turn;
 * - lifecycle events get their own prefixed line, and close an open paragraph first.
 *
 * `log.jsonl` is unaffected: it stays the machine record.
 */
export class AgentStream {
  private readonly paths = new Map<string, string>();
  /** Agents whose current line has text on it, so a lifecycle line starts clean. */
  private readonly midLine = new Set<string>();
  /** Agents that streamed deltas since their last settle. */
  private readonly streamed = new Set<string>();
  /**
   * One write chain per agent. Concurrent `appendFile` calls complete out of order:
   * three deltas arrived as "Answered prose.\nin ", so the pane would show scrambled text.
   */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly write: typeof appendFile = appendFile) {}

  /** Register an agent's stream file. Creates it on first write. */
  open(agentId: string, path: string): void {
    this.paths.set(agentId, path);
  }

  async delta(agentId: string, text: string): Promise<void> {
    if (text === "") return;
    this.streamed.add(agentId);
    if (text.endsWith("\n")) this.midLine.delete(agentId);
    else this.midLine.add(agentId);
    await this.append(agentId, text);
  }

  /** End of turn: fall back to the settled text when nothing streamed, then break the line. */
  async settle(agentId: string, lastText: string | null): Promise<void> {
    const streamed = this.streamed.delete(agentId) === true;
    if (!streamed && lastText) {
      await this.delta(agentId, lastText);
    }
    if (this.midLine.delete(agentId)) await this.append(agentId, "\n");
    await this.append(agentId, "\n");
  }

  /** One line per tool call: `[tool] bash {"command":"ls"}`. */
  async tool(agentId: string, tool: { name: string; args: unknown }): Promise<void> {
    await this.line(agentId, `[tool] ${tool.name} ${oneLine(tool.args)}`);
  }

  /** One lifecycle line, e.g. `[error] pi process exited` or `[exited]`. */
  async line(agentId: string, text: string): Promise<void> {
    // Does not touch `streamed`: a tool line lands mid-turn, and the turn's own
    // settle must still know whether prose was streamed.
    if (this.midLine.delete(agentId)) await this.append(agentId, "\n");
    await this.append(agentId, `${text}\n`);
  }

  private append(agentId: string, text: string): Promise<void> {
    const path = this.paths.get(agentId);
    if (!path) return Promise.resolve();
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    // Chain from a settled promise so one failed write cannot wedge the queue.
    const next = prev.then(() => this.write(path, text, "utf8"));
    this.queues.set(agentId, next.catch(() => undefined));
    return next;
  }
}
