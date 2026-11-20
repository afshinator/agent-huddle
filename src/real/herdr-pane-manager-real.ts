import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrPaneManager, PaneId, PaneSpec } from "../seams/herdr-pane-manager";
import { errorMessage } from "../errors";

const execFileP = promisify(execFile);

/**
 * Drives agent panes through the `herdr pane` CLI (D1/§8).
 *
 * Each pane is an ordinary `tail -f` log follower. The room pane (coordinator
 * terminal) is NOT managed here — the human launches the coordinator in it.
 * `close` hides the pane; the coordinator's own child processes (e.g. `pi`)
 * are unaffected because they are not pane processes.
 */
export class HerdrPaneManagerReal implements HerdrPaneManager {
  constructor(
    private readonly opts: {
      herdrBin?: string;
      cwd?: string;
      direction?: "right" | "down";
    } = {},
  ) {}

  private get bin(): string {
    return this.opts.herdrBin ?? "herdr";
  }
  private get direction(): "right" | "down" {
    return this.opts.direction ?? "down";
  }
  private get cwd(): string {
    return this.opts.cwd ?? process.cwd();
  }

  async openAgentPane(spec: PaneSpec): Promise<PaneId> {
    const paneId = await this.split();
    try {
      if (spec.command && spec.command.length > 0) {
        await this.run(paneId, spec.command);
      }
      await this.rename(paneId, spec.title);
      return paneId;
    } catch (e) {
      await this.tryClose(paneId);
      throw e;
    }
  }

  async tailLog(paneId: PaneId, logFile: string): Promise<void> {
    await this.run(paneId, ["tail", "-f", logFile]);
  }

  async readOutput(paneId: PaneId): Promise<string> {
    const stdout = await this.exec(["pane", "read", paneId, "--source", "recent-unwrapped"]);
    return stdout;
  }

  async close(paneId: PaneId): Promise<void> {
    await this.exec(["pane", "close", paneId]);
  }

  private async split(): Promise<PaneId> {
    const stdout = await this.exec([
      "pane", "split",
      "--current",
      "--direction", this.direction,
      "--cwd", this.cwd,
      "--no-focus",
    ]);
    let rec: unknown;
    try {
      rec = JSON.parse(stdout);
    } catch (error: unknown) {
      throw new Error(`herdr pane split returned invalid JSON: ${errorMessage(error)}`);
    }
    const paneId = (rec as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
    if (typeof paneId !== "string" || paneId.length === 0) throw new Error(`herdr pane split: no pane_id in response`);
    return paneId;
  }

  // shortcut: command args are passed verbatim; a log path with spaces would
  // be split by the pane shell. Upgrade when room_dir may contain spaces.
  private async run(paneId: PaneId, command: string[]): Promise<void> {
    await this.exec(["pane", "run", paneId, ...command]);
  }

  private async rename(paneId: PaneId, title: string): Promise<void> {
    await this.exec(["pane", "rename", paneId, title]);
  }

  private async tryClose(paneId: PaneId): Promise<void> {
    try {
      await this.close(paneId);
    } catch {
      // best-effort cleanup on partial open
    }
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileP(this.bin, args, { maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(`herdr ${args.join(" ")}: ${err.stderr ?? err.message}`);
    }
  }
}
