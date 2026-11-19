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

export class FakeHerdrPaneManager implements HerdrPaneManager {
  readonly calls: PaneCall[] = [];
  readonly panes = new Map<PaneId, FakePane>();

  async openAgentPane(spec: PaneSpec): Promise<PaneId> {
    this.panes.set(spec.id, { spec, output: "", closed: false });
    this.calls.push({ op: "open", paneId: spec.id, payload: spec });
    return spec.id;
  }

  async tailLog(paneId: PaneId, logFile: string): Promise<void> {
    this.requirePane(paneId);
    this.calls.push({ op: "tail", paneId, payload: logFile });
  }

  async readOutput(paneId: PaneId): Promise<string> {
    return this.requirePane(paneId).output;
  }

  async close(paneId: PaneId): Promise<void> {
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
