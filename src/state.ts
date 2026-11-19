export type RoomStatus = "idle" | "active" | "halted";
export type AgentStatus = "starting" | "idle" | "busy" | "exited" | "error";

export interface ChainState {
  chainId: string;
  startedBy: "supervisor" | "startup";
  hopCount: number;          // dispatched agent turns so far
  nudgeIssued: boolean;      // D6 finish-up nudge sent to lead?
  status: "active" | "wrap_up" | "halted";
  dispatchedAgentIds: string[]; // agents dispatched ≥ once this chain ("active agents" for the nudge)
}

export interface AgentRuntime {
  id: string;
  handle: string;
  sessionDir: string;        // --session-dir (per-agent, D7)
  sessionFile?: string;      // from pi get_state
  pid?: number;
  paneId?: string;           // herdr pane id, if any
  status: AgentStatus;
  lastActivityAt?: string;
}

export interface RoomState {
  name: string;
  configPath: string;
  startedAt: string;
  status: RoomStatus;
  leadAgentId: string;
  chain: ChainState | null;
  agents: Record<string, AgentRuntime>;
  lastMessageId: string | null;
}
