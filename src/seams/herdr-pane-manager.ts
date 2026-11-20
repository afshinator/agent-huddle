export type PaneId = string;

export interface PaneSpec {
  id: PaneId;
  title: string;
  command?: string[];      // e.g. ["tail","-f", logPath]
}

export interface HerdrPaneManager {
  openAgentPane(spec: PaneSpec): Promise<PaneId>;       // one per agent
  tailLog(paneId: PaneId, logFile: string): Promise<void>;
  readOutput(paneId: PaneId): Promise<string>;          // herdr pane read; tests assert
  close(paneId: PaneId): Promise<void>;                 // herdr pane close; hides pane, pi keeps running
}

export interface PaneCall {
  op: "open" | "tail" | "close";
  paneId: PaneId;
  payload?: unknown;
}

interface FakePane {
  spec: PaneSpec;
  output: string;
  closed: boolean;
}

export type FakePaneOp = "open" | "tail" | "close";

export class FakeHerdrPaneManager implements HerdrPaneManager {
  readonly calls: PaneCall[] = [];
  readonly panes = new Map<PaneId, FakePane>();
  private readonly failures = new Map<FakePaneOp, unknown[]>();

  /** Reject the next `times` calls to `op` after `skip` successful ones. */
  failOn(op: FakePaneOp, error: unknown, times = 1, skip = 0): void {
    for (let i = 0; i < skip; i += 1) this.failures.set(op, [...(this.failures.get(op) ?? []), undefined]);
    for (let i = 0; i < times; i += 1) this.failures.set(op, [...(this.failures.get(op) ?? []), error]);
  }

  private takeFailure(op: FakePaneOp): { error: unknown } | null {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return null;
    const error = queue.shift();
    return error === undefined ? null : { error };
  }

  async openAgentPane(spec: PaneSpec): Promise<PaneId> {
    const failure = this.takeFailure("open");
    if (failure) throw failure.error;
    this.panes.set(spec.id, { spec, output: "", closed: false });
    this.calls.push({ op: "open", paneId: spec.id, payload: spec });
    return spec.id;
  }

  async tailLog(paneId: PaneId, logFile: string): Promise<void> {
    const failure = this.takeFailure("tail");
    if (failure) throw failure.error;
    this.requirePane(paneId);
    this.calls.push({ op: "tail", paneId, payload: logFile });
  }

  async readOutput(paneId: PaneId): Promise<string> {
    return this.requirePane(paneId).output;
  }

  async close(paneId: PaneId): Promise<void> {
    const failure = this.takeFailure("close");
    if (failure) throw failure.error;
    this.requirePane(paneId).closed = true;
    this.calls.push({ op: "close", paneId });
  }

  // test helpers (not part of the seam interface)
  setOutput(paneId: PaneId, text: string): void {
    this.requirePane(paneId).output = text;
  }

  isClosed(paneId: PaneId): boolean {
    return this.requirePane(paneId).closed;
  }

  private requirePane(paneId: PaneId): FakePane {
    const p = this.panes.get(paneId);
    if (!p) throw new Error(`FakeHerdrPaneManager: unknown pane "${paneId}"`);
    return p;
  }
}
