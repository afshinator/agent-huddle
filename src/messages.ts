export type MessageKind =
  | "user"              // human supervisor input
  | "startup_task"      // task posted at boot (D2)
  | "agent"             // final assistant text from an agent turn
  | "notice"            // room lifecycle notice (boot, halt)
  | "hop_limit_reached";// D6 halt notice

export interface RoomMessage {
  id: string;            // uuid
  ts: string;            // ISO-8601, coordinator wall clock
  kind: MessageKind;
  from: string;          // "supervisor" | agentId | "room"
  handle: string;        // "supervisor" | "@lead" | "@dev1" | "room"
  text: string;          // message body (final text for agents)
  mentions: string[];    // agent ids targeted by @mention, in order of appearance
  chainId: string;       // user-turn chain this belongs to
  hop: number;           // hop index within chain (0 for user/startup/notice)
  doneSignal?: boolean;  // true when an agent message carries the DONE signal (§6.5)
}
