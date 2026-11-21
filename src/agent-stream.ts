import { appendFile, writeFile } from "node:fs/promises";

/** Tool arguments on one line, short enough to read in a pane. */
function oneLine(args: unknown): string {
  const text = JSON.stringify(args) ?? String(args);
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

/**
 * The per-agent pane stream: tool calls and lifecycle lines, never the agent's prose (#65).
 *
 * The conversation lives in the room pane, in one place, which is the point of a chat room;
 * a pane that repeated it showed every reply twice and made the room harder to follow. What
 * a pane is for is the machine-adjacent detail the room deliberately does not carry: which
 * tool ran with what arguments, when the process started, when it exited, what went wrong.
 *
 * `log.jsonl` is unaffected: it stays the machine record, deltas included.
 */
export class AgentStream {
  private readonly paths = new Map<string, string>();

  /**
   * One write chain per agent. Concurrent `appendFile` calls complete out of order:
   * three deltas arrived as "Answered prose.\nin ", so the pane would show scrambled text.
   */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly write: typeof appendFile = appendFile,
    private readonly truncate: typeof writeFile = writeFile,
  ) {}

  /**
   * Register an agent's stream file and start it from empty (#61).
   *
   * The pane tails this file, and herdr restores a pane's old scrollback, so an appended
   * stream showed every earlier boot's lifecycle lines under the new ones. The truncation is
   * queued on the same per-agent chain as the writes, so it always lands first; `log.jsonl`
   * is untouched and stays the machine record.
   */
  open(agentId: string, path: string): void {
    this.paths.set(agentId, path);
    const next = this.truncate(path, "", "utf8");
    this.queues.set(agentId, next.catch(() => undefined));
  }

  /** One line per tool call: `[tool] bash {"command":"ls"}`. */
  async tool(agentId: string, tool: { name: string; args: unknown }): Promise<void> {
    await this.line(agentId, `[tool] ${tool.name} ${oneLine(tool.args)}`);
  }

  /** One lifecycle line, e.g. `[error] pi process exited` or `[exited]`. */
  async line(agentId: string, text: string): Promise<void> {
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
