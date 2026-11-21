import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrPaneManager, PaneId, PaneLayoutReport, PaneSpec } from "../seams/herdr-pane-manager";
import { errorMessage } from "../errors";
import { chooseLayout, sliceRatios } from "../layout";

const execFileP = promisify(execFile);

/**
 * Drives agent panes through the `herdr pane` CLI (D1/§8).
 *
 * Each pane is an ordinary `tail -f` log follower. The room pane (coordinator
 * terminal) is NOT managed here — the human launches the coordinator in it; the
 * manager finds it as the focused pane and carves the agent region from it once.
 * `close` hides the pane; the coordinator's own child processes (e.g. `pi`)
 * are unaffected because they are not pane processes.
 *
 * Geometry comes from `herdr pane layout` (cells) and `src/layout.ts` decides the
 * shape, so the room pane keeps its floor and the agent panes are equal bands rather
 * than the staircase that repeated 0.5 splits produce (#56).
 */
export class HerdrPaneManagerReal implements HerdrPaneManager {
  constructor(
    private readonly opts: {
      herdrBin?: string;
      cwd?: string;
      direction?: "right" | "down";
    } = {},
  ) {}

  /** Agent panes assigned to slots 1..n, in geometric order, once the region is laid out. */
  private assignment: PaneId[] | null = null;
  /** What the tab gave, for the room's banner (#59). */
  private report: PaneLayoutReport | null = null;

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
    const paneId = await this.paneFor(spec.slot ?? 1, spec.slots ?? 1);
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

  /** The pane this slot occupies, laying the agent region out on first use. */
  private async paneFor(slot: number, slots: number): Promise<PaneId> {
    if (this.assignment === null) await this.layoutAgentPanes(slots);
    const paneId = this.assignment?.[slot - 1];
    if (paneId === undefined) {
      throw new Error(`herdr pane layout: slot ${slot} of ${slots} was never created`);
    }
    return paneId;
  }

  /**
   * Carve the agent region from the room pane once, split it into the plan's bands, then
   * assign slots by measured position. Sorting by (y, x) means the design does not depend
   * on which end a split lands on, which the `herdr` probes never established.
   */
  private async layoutAgentPanes(count: number): Promise<void> {
    const before = await this.readLayout();
    const plan = chooseLayout({
      width: before.area.width,
      height: before.area.height,
      count,
    });
    if (plan === null) {
      throw new Error(
        `herdr pane layout: ${before.area.width}x${before.area.height} cannot hold ${count} agent ` +
          `panes beside a chat pane; open the room in a bigger tab`,
      );
    }

    const stacked = plan.orientation === "above";
    const bandDirection = stacked ? "down" : "right";
    const chatShare = stacked
      ? plan.chat.height / before.area.height
      : plan.chat.width / before.area.width;

    const host = await this.splitPane(before.chatPaneId, bandDirection, chatShare);

    // Bands (rows when the chat is on top, columns when it is beside), then the panes in
    // each band. Every split targets the band it subdivides, and the ratios come from the
    // measured rule: the pane being split keeps (n-k)/(n-k+1) of itself.
    const perBand: number[] = [];
    for (let placed = 0; placed < count; placed += plan.columns) {
      perBand.push(Math.min(plan.columns, count - placed));
    }
    const bands = [host];
    const bandRatios = sliceRatios(perBand.length);
    for (let index = 1; index < perBand.length; index++) {
      bands.push(await this.splitPane(host, bandDirection, bandRatios[index - 1]!));
    }
    for (let index = 0; index < perBand.length; index++) {
      const band = bands[index]!;
      const across = stacked ? "right" : "down";
      const ratios = sliceRatios(perBand[index]!);
      for (let k = 1; k < perBand[index]!; k++) {
        await this.splitPane(band, across, ratios[k - 1]!);
      }
    }

    const after = await this.readLayout();
    const agentPanes = after.panes
      .filter((pane) => pane.paneId !== after.chatPaneId)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    if (agentPanes.length !== count) {
      throw new Error(`herdr pane layout: expected ${count} agent panes, herdr reports ${agentPanes.length}`);
    }
    this.assignment = agentPanes.map((pane) => pane.paneId);
    this.report = {
      tab: before.area,
      orientation: plan.orientation,
      chat: plan.chat,
      panes: agentPanes.map((pane, index) => ({ slot: index + 1, paneId: pane.paneId, box: pane.rect })),
    };
  }

  layoutReport(): PaneLayoutReport | null {
    return this.report;
  }

  private async readLayout(): Promise<{
    area: { width: number; height: number };
    chatPaneId: PaneId;
    panes: Array<{ paneId: PaneId; rect: { x: number; y: number; width: number; height: number } }>;
  }> {
    const stdout = await this.exec(["pane", "layout", "--current"]);
    let rec: unknown;
    try {
      rec = JSON.parse(stdout);
    } catch (error: unknown) {
      throw new Error(`herdr pane layout returned invalid JSON: ${errorMessage(error)}`);
    }
    const layout = (rec as { result?: { layout?: Record<string, unknown> } })?.result?.layout;
    const area = layout?.area as { width?: unknown; height?: unknown } | undefined;
    const chatPaneId = layout?.focused_pane_id;
    const panes = layout?.panes;
    if (
      typeof area?.width !== "number" ||
      typeof area?.height !== "number" ||
      typeof chatPaneId !== "string" ||
      !Array.isArray(panes)
    ) {
      throw new Error("herdr pane layout: response has no area, focused pane or pane list");
    }
    return {
      area: { width: area.width, height: area.height },
      chatPaneId,
      panes: (panes as Array<{ pane_id?: unknown; rect?: Record<string, unknown> }>).map((pane) => {
        const rect = pane.rect ?? {};
        return {
          paneId: String(pane.pane_id),
          rect: {
            x: Number(rect.x ?? 0),
            y: Number(rect.y ?? 0),
            width: Number(rect.width ?? 0),
            height: Number(rect.height ?? 0),
          },
        };
      }),
    };
  }

  /** Split `target`; the ratio is what that pane keeps. */
  private async splitPane(target: PaneId, direction: "down" | "right", ratio: number): Promise<PaneId> {
    const stdout = await this.exec([
      "pane", "split", target,
      "--direction", direction,
      "--ratio", ratio.toFixed(4),
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
