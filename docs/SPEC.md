# v1 Spec — Config-Driven Multi-Agent Chat Room (`pi` + `herdr`)

Status: pre-implementation. Single source of truth for `/to-tickets` and `/implement`.

---

## 1. Scope & non-goals

**In scope (v1)**

- YAML team templates: room config, one lead coordinator, N specialist agents (each with identity, lane, system prompt, provider, model, thinking, tools).
- One shared chat room. Every agent sees every room message (shared awareness).
- Mention-gated routing: `@handle` targets that agent; a message with no mention activates **nobody** and is ingested by everyone (v1.1; was: route to the lead).
- Hard `max_hops` cap per user-turn chain, one lead "finish-up" nudge, then `hop_limit_reached` halt.
- Persistent room log (`messages.jsonl`) + room state (`state.json`) as the single source of truth.
- One persistent `pi --mode rpc` session per agent under its own `--session-dir`.
- `herdr` terminal panes: one shared chat-room pane (the coordinator terminal: stream + input) and per-agent log panes (hidden/closed without stopping `pi`).
- Two test seams: `PiAgentClient` and `HerdrPaneManager` (fake + real implementations).

**Out of scope (deferred from the source video)**

- Web/browser UI, generative HTML canvas, tracing dashboard, durable cron loop, sub-rooms.
- Autonomous agent self-reconfiguration (agents editing team config).
- Automated Definition-of-Done verification. v1: the **lead self-certifies** completion against the free-text `definition_of_done` and emits a completion signal (see §6.5).

---

## 2. Architecture

```
                     ┌────────────────────────────────────────────┐
 human (supervisor)  │            Coordinator (TypeScript)         │
 ── room pane        │                                            │
     (stdin) ──────► │  config.yaml ─► Router ─► TurnLoop          │
                     │      │             │           │            │
                     │   messages.jsonl  │           │            │
                     │   state.json      │     PiAgentClient (seam)│
                     │                   │           │            │
                     │   HerdrPaneManager (seam)      ▼            │
                     │                   │    pi --mode rpc × N   │
                     └───────────────────┼─────────│──────────────┘
                        herdr panes      │         └─ per-agent --session-dir
                        (tail logs)      └──────────── room log
```

Ownership rules:

- **Coordinator** owns `messages.jsonl`, `state.json`, the router, the turn loop, and spawns/owns all `pi` child processes.
- **`pi` processes** are children of the coordinator, **not** of herdr panes. A pane only tails a log file; closing/hiding a pane never touches the `pi` process.
- **Room log** (`messages.jsonl`) is the single source of truth (D3). Every message — human, agent, notice, directed `@agent` — appends here. Agent `pi` sessions are per-agent and isolated from the room log.

Data flow per message:

1. Message enters via the room pane (human types on the coordinator's stdin) or a startup task (D2).
2. Coordinator appends it to `messages.jsonl`, updates `state.json`.
3. Router parses `@mentions`, selects target agent(s) (§6).
4. Coordinator pushes the message as room context to **unmentioned** agents (§6.6, Q3/D8) and dispatches a turn to the target(s) via `PiAgentClient.prompt`.
5. Agent's `pi` streams `message_update` events; the coordinator renders them to the agent's pane + appends the final assistant text to `messages.jsonl` on `agent_settled`.
6. Turn loop repeats until a stable state or `max_hops` halt.

---

## 3. YAML template schema (Q2)

Room-level fields plus one `lead` block and an `agents` list.

```yaml
name: tiny-factory          # required, slug. default room_dir = <cwd>/rooms/<name>
room_dir: ./rooms/tiny-factory   # optional override
task: |                    # optional initial mission (D2). omit -> idle start.
  Design and document a small service.
definition_of_done: |      # optional, advisory to lead (D2). omit -> none.
  A README plus one tested module.
max_hops: 12               # D6. default 12.
turn_timeout_ms: 300000    # how long one agent turn may take. default 300000.
launch_guard: warn         # refuse|warn|off. default warn. (#38, §10)

lead:                      # D5. required.
  id: lead
  handle: "@lead"
  role: "Lead coordinator: decompose, assign, integrate. Never do specialist work."
  system_prompt_file: prompts/lead.md   # XOR system_prompt
  provider: commandcode
  model: deepseek/deepseek-v4-pro    # shorthand "deepseek-pro"
  thinking: medium
  tools: [read, bash, edit, write, grep]   # omit -> pi defaults

agents:                    # D4/D5. specialists. v1 default roster: 2 devs + 1 reviewer.
  - id: dev1
    handle: "@dev1"
    role: "Implement features and tests."
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash   # shorthand "deepseek-flash"
    thinking: high
    tools: [read, bash, edit, write, grep]
    pane_writable: true      # v1.1, default true
  - id: dev2
    handle: "@dev2"
    role: "Implement features and tests."
    provider: commandcode
    model: z-ai/glm-5.3-flash           # shorthand "glm-flash"
    thinking: high
    tools: [read, bash, edit, write, grep]
  - id: reviewer
    handle: "@reviewer"
    role: "Review changes for correctness and safety."
    provider: commandcode
    model: gpt-5.6-luna                   # shorthand "gpt-luna"
    thinking: high
    tools: [read, grep]
```

Rules:

- `id` is unique across `lead` + `agents` and becomes the agent's stable `--session-id` (D7).
- `handle` must match `/^@[A-Za-z0-9_-]+$/` (the router's mention token, §6.2), so it must be quoted in YAML. It is unique across the roster, and `@all` / `@everyone` are rejected everywhere while `@lead` is allowed only on the lead — the router resolves those tokens before the handle map, so any other use would leave that agent unreachable.
- `system_prompt` and `system_prompt_file` are mutually exclusive; validation rejects a config with both.
- `tools` is an optional allowlist passed as `--tools`. Omit to inherit `pi` defaults.
- `pane_writable` (v1.1, bool, default `true`) — whether the agent's pane accepts typed input, which posts a public message addressed to that agent (§6.4). `false` opens a tail-only pane with a read-only banner.
- Unknown keys are rejected at load time (fail fast, do not silently drop).

### 3.1 TypeScript types

```ts
// config.ts
export interface AgentSpec {
  id: string;                    // unique, stable session id (D7)
  handle: string;                // "@name"
  role: string;                  // one-line lane description
  system_prompt?: string;        // XOR system_prompt_file
  system_prompt_file?: string;   // resolved relative to the YAML file
  provider?: string;             // pi --provider
  model?: string;                // pi --model
  thinking?: ThinkingLevel;      // pi --thinking
  tools?: string[];              // pi --tools allowlist
}

export interface RoomConfig {
  name: string;
  room_dir: string;              // absolute after load
  task?: string;                 // D2 optional startup task
  definition_of_done?: string;   // D2 optional
  max_hops: number;              // default 12
  turn_timeout_ms: number;       // default 300000
  launch_guard?: "refuse" | "warn" | "off";  // default warn
  lead: AgentSpec;
  agents: AgentSpec[];
}

export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LoadedConfig {
  config: RoomConfig;
  sourcePath: string;
  allAgents: AgentSpec[];        // [lead, ...agents] in stable order
  agentById: Map<string, AgentSpec>;
}
```

---

## 4. Room persistence schemas (D3)

### 4.1 `messages.jsonl` — append-only room log

One JSON object per line. Every record has `id`, `ts`, `kind`, `from`, `handle`, `text`.

```ts
// messages.ts
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
  hop: number;           // hop index within chain (0 for user/startup/notice); non-counted nudge/conclude turns reuse the current hopCount
  doneSignal?: boolean;  // true when an agent message carries the DONE signal (§6.5)
}
```

Sample line:

```json
{"id":"m-001","ts":"2026-01-01T00:00:00.000Z","kind":"user","from":"supervisor","handle":"supervisor","text":"@dev1 find the docs","mentions":["dev1"],"chainId":"c-001","hop":0}
```

### 4.2 `state.json` — live room state (rewritten atomically on change)

```ts
// state.ts
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
```

Atomic write: write to `state.json.tmp`, `fsync`, `rename` over `state.json`. The room log is the durable truth; `state.json` is a recoverable cache (on boot it can be rebuilt from `messages.jsonl` + config).

---

## 5. System prompts (D4/D8 social contract)

Each agent spawns with two prompt layers:

1. **Role prompt** (`--system-prompt`): the agent's own `role` + `system_prompt`/`system_prompt_file`.
2. **Social contract** (`--append-system-prompt`): identical for every agent, generated by the coordinator:

```
You are {handle} in the shared room "{roomName}".
Every room message is shown to you as context.
- If a message mentions you ({handle}), respond from your lane: {role}.
- If a message mentions only other agents, read it and stay quiet — do not reply.
- If the lead addresses you directly, respond from your lane.
- You may mention other agents with @handle to hand off work.
```

Lead additionally gets (in its role prompt):

```
You are the lead coordinator. Decompose the task, assign work via @handle,
and integrate results. Do the specialist work yourself only as a last resort.
The definition of done is: {definition_of_done}
When the definition of done is satisfied, end your reply with the line: DONE
```

---

## 6. Routing & turn loop (D4/D5/D6)

### 6.1 Message lifecycle

```
supervisor input / startup task
        │
        ▼
append messages.jsonl (kind user|startup_task, hop 0)
        │
        ▼
Router.extractMentions(message)
        │
        ├─ has @mentions ──► targets = mentioned agent ids (dedup, order preserved)
        │                     (mention of "lead"/lead.handle maps to lead id)
        │
        └─ no @mentions ───► targets = []   // v1.1: nobody is activated (D6);
        │                     startup_task targets the lead explicitly
        │
        ▼
TurnLoop: dispatch each target in order, one at a time
        │
        ▼
on agent_settled: append agent text to messages.jsonl (kind agent, hop n)
        │
        ├─ agent text contains @mention(s) ──► those become next hop targets
        ├─ lead emitted DONE ────────────────► chain complete, status idle
        └─ no mentions and DoD not signalled ─► chain complete, status idle
```

A **hop** = one dispatched agent turn (one `prompt` → `agent_settled`). `chain.hopCount` increments on dispatch, not on receipt.

### 6.2 Mention routing (D4)

- **Deterministic layer (Router):** only mentioned agents are ever dispatched. An unmentioned agent never receives a `prompt` in this chain. This is enforced in code, independent of the prompt text.
- **Prompt layer (social contract):** the silence-unless-addressed text (§5) backs the deterministic gate and covers agents that still ingest the message as context (§6.6).
- Mentions are parsed with `@handle` against the handle map; `@lead` and the lead's `handle` both resolve to the lead.
- **No mention activates nobody** (v1.1, D6). Every agent still ingests the text (§6.6), so a message can inform the room without requesting work. The chain completes immediately with status `idle`. The one exception is the room's startup `task:`, which targets the lead by construction — a boot directive is not a chat message.
- A reply's mention of its **own author** is ignored by routing: "report to @lead" from the lead does not dispatch the lead again. The handle stays in `mentions[]` for the record; the queue drops it.
- Broadcast: `@all` or `@everyone` targets every agent (lead + all specialists). Each dispatched agent is one hop.

### 6.3 Hop cap & finish-up nudge (D6)

| Condition at dispatch time | Action |
|---|---|
| `hopCount < max_hops` | dispatch target normally |
| `hopCount == max_hops`, DoD not signalled, `nudgeIssued == false` | route to **lead** with a wrap-up prompt (below); set `nudgeIssued = true`, chain `status = "wrap_up"`. Nudge does **not** increment `hopCount`. |
| `nudgeIssued == true`, DoD still not signalled, target would be another hop | **halt**: append `hop_limit_reached` notice, `status = "halted"`, stop auto-routing, wait for human. |
| DoD signalled (`DONE`) at any point | chain complete; room status returns to `idle` (chain state is transient) |

Wrap-up prompt to lead:

```
You have hit max_hops ({max_hops}) without finishing the definition of done.
Instruct the active agents to conclude now: summarize what is done, what
remains, and the blockers. Do not start new work.
```

After the lead's wrap-up settles, the coordinator deterministically dispatches each agent in `chain.dispatchedAgentIds` (excluding the lead) exactly **one** concluding turn, with the prompt "Wrap up: summarize what is done, what remains, and the blockers. Do not start new work." This does **not** rely on the lead @mentioning them. If DoD is still not signalled after those concluding turns, the next dispatch attempt halts (table row 3).

Human input always resets the chain (`hopCount = 0`, `nudgeIssued = false`, new `chainId`).

### 6.4 Human steering (D5)

- Human message with `@agent` → targets that agent (supervisor directive). Multiple `@mentions` target all named agents.
- Human message `@all` / `@everyone` → every agent (lead + specialists).
- Human message without `@mention` → **nobody is activated**; every agent ingests it (§6.2, v1.1).
- Human message `@lead` → lead only.
- Human may type in the room pane at any time; input is queued and delivered at the next settle boundary (never interrupts an in-flight turn mid-stream).
- **Typing in an agent's pane** (v1.1, D7) posts a public room message with that agent's handle implied: text typed in `@dev1`'s pane becomes `@dev1 <text>` in `messages.jsonl`, with `from: supervisor`. It is visible to everyone and activates only that agent — there is no private channel in v1.
- **A pane line routes by its pane, not by its words** (#40). Dispatch targets are pinned to that agent, so a handle the supervisor types into the line stays a word in the message: typing `@lead look` in `@dev1`'s pane activates dev1 and the lead ingests the text as context. `mentions[]` still records every handle the text contains, because it records the text. The unknown-handle notice still fires for `@nobody`.

### 6.5 Definition of Done (v1 boundary)

Automated DoD verification is **out of scope**. v1 rule: the lead declares completion by ending a reply with a line matching `/^DONE$/m` (a line whose trimmed content is exactly `DONE`). The coordinator scans the lead's final assistant text for that sentinel; on match it marks the chain complete. `DONE` is the only machine-readable signal; the `definition_of_done` prose is judged by the lead. A human can also force completion by sending `@lead` with an explicit instruction (normal routing).

### 6.6 Unmentioned-agent context sync (D8 / Q3)

When a message targets only some agents, the coordinator pushes the message to every **unmentioned** agent as context **without dispatching a turn**, so they stay current while staying silent.

Mechanism (v1, behind the seam): `PiAgentClient.pushContext(agentId, text)` runs the RPC `bash` command `echo`-ing the room message with `excludeFromContext: false`. `pi` stores it as a `BashExecutionMessage`; it becomes a `UserMessage` in that agent's context on its **next** prompt. No run is started, so no reply is produced. Deterministic gating (§6.2) guarantees the agent is not dispatched until it is mentioned.

The seam hides this mechanism, so the Q3 pivot (lazy catch-up) is a one-implementation swap, not a contract change.

---

## 7. `pi` session lifecycle (Q1 / D7)

### 7.1 Spawn command per agent

```
pi --mode rpc \
   --session-dir <room_dir>/agents/<id>/sessions \
   --session-id <id> \
   --provider <p> --model <m> --thinking <t> \
   --tools <comma,list>            # omitted if not configured
   --system-prompt "<role prompt>" \
   --append-system-prompt "<social contract>"
```

- `--session-dir` is unique per agent → isolated sessions, no collisions (D7).
- `--session-id <id>` pins a stable, resumable session across restarts (D3/D7).
- `--system-prompt` + `--append-system-prompt` carry role + social contract (§5).
- Working directory = the project `cwd` (so agents share the workspace the human launched in).

### 7.2 RPC protocol usage

- **Framing:** strict JSONL. Write one JSON object + `\n` to stdin; read stdout as a UTF-8 byte stream, split only on `\n` (never Node `readline`, which also splits on U+2028/U+2029).
- **Dispatch:** `{"id":"<unique>","type":"prompt","message":"<composed>","streamingBehavior":"followUp"}` when the agent may still be streaming; `"followUp"` queues until settled. Use unique ids and correlate responses by `id`, not order. The composed `message` is the room message text **verbatim** (no wrapper); the agent's persistent session and social-contract prompt supply the rest.
- **Wait for completion:** `prompt` success only means accepted. Wait for the `agent_settled` event (with `aborted` flag) before counting the hop as done. `agent_end` is not sufficient (retry/compaction/steering can follow).
- **Read final text:** on `agent_settled`, call `get_last_assistant_text` (or accumulate `message_update`/`text_delta` deltas) to get the turn's text for `messages.jsonl`.
- **Context push:** `{"type":"bash","command":"echo '<escaped message>'","excludeFromContext":false}` (§6.6).
- **Shutdown:** close stdin, then SIGTERM, then allow a grace period before SIGKILL. A second signal forces exit.

### 7.3 Events consumed by the coordinator

| Event | Use |
|---|---|
| `message_update` (`text_delta`) | stream agent output to its herdr pane |
| `agent_end` | log run end; do **not** treat as turn complete |
| `agent_settled` | hop complete; read final text, append `messages.jsonl`, advance loop |
| `tool_execution_start` | one `[tool] <name> <args>` line in the agent's readable stream (D8); `tool_execution_update`/`_end` are ignored |
| `response` (command responses) | correlate by `id`; log `success:false` as agent error |

---

## 8. `herdr` pane layout & tailing (D1)

Layout (agent panes created at boot, via `herdr pane split` / `run` / `rename`; the room pane is the coordinator's own terminal):

```
┌─────────────────────────────────────────────────────┐
│ pane "room"   : coordinator terminal (stream + input)│
├──────────────────────────┬──────────────────────────┤
│ pane "@dev1"             │ pane "@dev2"              │
│  (tail agent log)        │  (tail agent log)         │
│                          ├──────────────────────────┤
│                          │ pane "@reviewer"          │
│                          │  (tail agent log)         │
└──────────────────────────┴──────────────────────────┘
```

Rules:

- **room pane** (the shared chat room): runs the coordinator process. Its stdout prints the room stream (each appended `messages.jsonl` entry, formatted); its **stdin** is where the human types. Input → appended to `messages.jsonl` as a user message → routed per §6 (`@agent` / `@all` / no mention → nobody, D6). Notices/errors print here too. The human can steer at any time (§6.4).
- **per-agent panes**: one per agent, `tail -f <room_dir>/agents/<id>/output.log` (D7). The coordinator writes that agent's streamed prose + one-line lifecycle events to it; `log.jsonl` holds the JSON records for machines and no pane reads it. Writable by default (`pane_writable: false` gives a tail-only pane with a banner, §9.2); closeable (hidden) in herdr — this only hides the pane; the `pi` process keeps running (child of coordinator, §2).

### 8.1 Seam (§9) is the only herdr touchpoint

All herdr interaction goes through `HerdrPaneManager`. No coordinator code shells out to `herdr` directly.

---

## 9. Seams (Q4)

Both interfaces get **fake (in-memory) test doubles** and **real** implementations. The coordinator depends only on these interfaces.

### 9.1 `PiAgentClient`

```ts
// pi-agent-client.ts
export interface SpawnOptions {
  cwd: string;
  systemPrompt?: string;        // --system-prompt (built by T5 buildRolePrompt)
  appendSystemPrompt?: string;  // --append-system-prompt (built by T5 buildSocialContract)
}

export interface PromptRequest {
  message: string;                 // composed room message for this turn
  streamingBehavior?: "followUp" | "steer";
}

export interface SettledResult { aborted: boolean; lastText: string | null; }

export interface AgentProcessInfo { sessionDir: string; sessionFile?: string; pid: number; }

export interface PiAgentClient {
  spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo>;
  prompt(agentId: string, req: PromptRequest): Promise<void>;      // accepted, not settled
  pushContext(agentId: string, text: string): Promise<void>;       // D8/Q3 (§6.6)
  waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult>;
  shutdown(agentId: string): Promise<void>;
  on(event: "settled", agentId: string, fn: (r: SettledResult) => void): void;
  on(event: "stream", agentId: string, fn: (delta: string) => void): void;
  on(event: "tool", agentId: string, fn: (t: { name: string; args: unknown }) => void): void;
  on(event: "error", agentId: string, fn: (err: Error) => void): void;
}
```

Real implementation: spawns `pi --mode rpc`, parses JSONL, correlates by `id`, emits `stream` on `text_delta`, `settled` on `agent_settled`. Fake: in-memory map of `agentId → {messages, replayScript}`, returns scripted responses, records all calls for assertions.

The completed text reaches the caller through `SettledResult.lastText` only. The real client asks `pi` for the authoritative text at settle time (`get_last_assistant_text`) and puts it there, so no seam method exposes the last text separately (removed in v1; #21).

**Failure semantics** (required section: a seam is signatures *plus* this grammar):

| Method | Rejects when | Notes |
|---|---|---|
| `spawn` | the binary is missing or the process cannot start | creates `sessionDir` first; spawning an id that is already live replaces the runtime entry **without** killing the previous child, so the coordinator spawns each agent once |
| `prompt` | the RPC answers `success:false`, or no response arrives within the 30s command timeout | resolves when the prompt is *accepted*, not when the turn settles |
| `pushContext` | the RPC fails or the child is gone | caller treats every rejection as best-effort and never halts a chain (§10). Each successful push emits one `context.push` telemetry record carrying `agentId` and `chars` — before that, success and failure were both silent |
| `waitForSettled` | `timeoutMs` elapses (it then sends `abort` and re-rejects), the child exits before settling, or the turn failed | a timeout **rejects**; it does not resolve `{aborted:true}`. `aborted:true` means the turn ended aborted on its own |
| `shutdown` | never after the child has exited | idempotent; stdin close → SIGTERM → SIGKILL after a grace period |
| `on` | never | listeners run synchronously while records are handled, so a throwing listener breaks that record's dispatch: callers wrap them (the coordinator routes every listener through `watchFailure`) |

### 9.2 `HerdrPaneManager`

```ts
// herdr-pane-manager.ts
export type PaneId = string;

export interface PaneSpec {
  id: PaneId;
  title: string;
  command?: string[];      // e.g. ["tail","-f", logPath]
}

export interface HerdrPaneManager {
  openAgentPane(spec: PaneSpec): Promise<PaneId>;       // one per agent
  tailLog(paneId: PaneId, logFile: string): Promise<void>;
  readOutput(paneId: PaneId): Promise<string>;          // consumer: herdr integration test (§9.2)
  close(paneId: PaneId): Promise<void>;                 // herdr pane close; hides pane, pi keeps running
}
```

`readOutput` has no coordinator caller and is kept deliberately: it is the only way to assert that a pane received the output it was opened for, so its named consumer is `test/herdr-real.integration.test.ts` plus manual troubleshooting. Nothing in the room flow reads pane contents back (kept in v1; #21).

**Failure semantics:**

| Method | Rejects when | Notes |
|---|---|---|
| `openAgentPane` | `herdr` fails, or its output is not the expected JSON | the pane id is returned by `herdr`, not invented by the caller; a pane already split is closed again if the run/rename step fails |
| `tailLog` | `herdr` fails | the real manager does not track panes; the fakes reject an unknown pane id |
| `readOutput` | `herdr` fails | the only read-back; the real manager does not track panes, so reading a closed pane is up to `herdr` and the fakes reject an unknown id |
| `close` | `herdr` fails | hides the pane; the agent's `pi` process keeps running because it is a coordinator child, not a pane process. The fakes reject an unknown id |

The room pane is the coordinator's own terminal (the human launches the coordinator in it); it is **not** managed by this seam. Only agent panes are.

**Pane content (v1.1, D7).** An agent pane shows that agent's **readable output stream** (`agents/<id>/output.log`), not `log.jsonl`: its deltas written as prose, one blank line between turns, lifecycle events as one prefixed line each (`[started]`, `[error] …`, `[exited]`). A turn that streamed no deltas writes its settled text, because a provider may send `text_end` without `text_delta`. `log.jsonl` remains on disk as the machine record and no pane tails raw JSON. Tool calls appear as one `[tool] <name> <args>` line, cut at 200 characters (D8).

**Pane input (v1.1, D7).** A writable pane (`pane_writable: true`, the default) runs `sh agents/<id>/pane.sh`: the tail in the background, a reader in the foreground that appends each complete typed line to `agents/<id>/inbox`. The coordinator polls each inbox and turns every line into a public room message from the supervisor, addressed to that agent (§6.4). Two measured constraints shape this: a POSIX background job takes its stdin from `/dev/null`, so a backgrounded reader never sees a keystroke, and `herdr pane run` types its arguments into the pane shell one word per argument, so an inline `sh -c '…'` loses its quoting. Hence a script file, and the reader in the foreground. A read-only pane runs the tail alone behind a `read-only - type in the chat pane` banner, because otherwise swallowed keystrokes give no feedback.

Real implementation: shells to `herdr pane split/run/rename/read/close`. Fake: in-memory pane registry, records commands and log tails for assertions.

Hiding a pane = `close` (D1's "hidden or collapsed" is met by `close`; `pi` survives because it is a coordinator child, not a pane process).

---

### 9.3 `Telemetry` (OTel-informed, no SDK)

Observability seam. OTel signals mapped to the room (traces = chain/hop spans; metrics = counters/histograms; logs = correlated records).

```ts
// telemetry.ts
export interface Span {
  addEvent(name: string, attrs?: Record<string, unknown>): void;
  setStatus(code: "ok" | "error", description?: string): void;
}

export interface Telemetry {
  span<T>(name: string, attrs: Record<string, unknown>, fn: (s: Span) => T): T;
  log(level: "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>): void;
  counter(name: string, attrs?: Record<string, unknown>, inc?: number): void;
}
```

- `NoopTelemetry` for tests; `JsonlTelemetry` appends OTel-shaped records to `<room_dir>/telemetry.jsonl` (same append-only pattern as `messages.jsonl`).
- Records carry `trace_id`/`span_id`/`parent_id`/start/end/`attributes`/`events`/`status`, so a later `@opentelemetry/api` + OTLP implementation swaps in behind the same interface.
- Span map: one root span per chain; `agent.turn` child span per hop (attrs `agentId`, `model`, `chainId`, `hop`); `router.resolve` and `store.append` leaf spans.
- Metrics: `room.hops_total` (counter), `agent.settle_latency_ms` (histogram), `room.active_chains` (updown). `agent.tokens_total` from `get_session_stats` is deferred until the PiAgentClient seam exposes session statistics; v1 emits no token metric.
- Logs: notices, errors, agent lifecycle — each carrying `trace_id`/`span_id`.

**Failure semantics:** `log`, `counter`, `histogram` and `upDownCounter` never throw on a failed write: the first failure is reported once on stderr and later records are still attempted (§10). They can still throw synchronously if a caller passes attributes `JSON.stringify` cannot serialise. `flush()` resolves and never rejects. `span(fn)` runs `fn` and ends the span with `status: error` plus the message if `fn` throws, then rethrows — a span never swallows a failure.

---

## 10. Error handling & process lifecycle

- **Agent exit mid-chain:** mark `AgentStatus.error`, append a `notice` to `messages.jsonl`, halt the chain, and wait for human input. Do not spin. (v1: no automatic reroute to the lead.)
- **RPC parse error** (`success:false` with no id): log to the agent pane, do not count as a hop.
- **Timeout:** `waitForSettled` enforces a per-turn timeout, `turn_timeout_ms` (default 300000). On timeout, send `abort`, then treat as a failed hop (counted, chain halts). The notice is `agent <id>: settle timeout after <ms>ms` — a slow turn is reported as a timeout, never as `failed`.
- **Context push failure (`pushContext`, §6.6 / Q3):** best-effort. A failed push is logged and appended as a `notice`, then routing continues; it never halts the chain and never aborts boot.
- **Boot guard (`launch_guard`, default `warn`):** before the first `spawn`, if the coordinator's cwd is the root of a git repository, log one `warn` naming the directory and branch, and — with `refuse` — stop boot with `LaunchGuardError` before any agent spawns or pane opens. `off` skips the check. Agents inherit that directory and write real files into it, including test files that the repo's own test command then picks up; a subdirectory of a repository is not flagged, and a missing `git` binary reads as "not a repository".
- **Boot:** on start, if `state.json` exists and `status != "halted"`, the coordinator may resume: re-open each agent session (`--session-id`) and continue. v1 minimum: resume is optional; a fresh boot starting `idle` is acceptable, and `state.json` rebuild is always possible from `messages.jsonl`.
- **Damaged files:** a line of `messages.jsonl` that is not readable JSON (a crash mid-append) is skipped on read and counted in one `warn` log; a damaged `state.json` is treated as absent and rebuilt. Neither aborts boot.
- **Telemetry write failure:** the `telemetry.jsonl` write chain is best-effort. The first failed write is reported once on stderr (`[telemetry] write failed, records are being dropped: …`), later records keep being attempted, and records produced while writes fail are lost (no buffering, no retry). `flush()` resolves and never rejects, so shutdown always completes.
- **Shutdown:** coordinator stops the inbox poll, closes each agent's stdin, SIGTERM, grace period, SIGKILL; then closes the panes it opened (best-effort: a failing `close` is a `warn`, never a reason to skip the telemetry flush or a zero exit); writes final `state.json` with a terminal status (`idle`, or `halted` when the chain halted).

---

## 11. Pivot triggers (recorded, not reopened)

| Question | Settled v1 choice | Pivot trigger |
|---|---|---|
| **Q1** pi invocation & herdr panes | `pi --mode rpc` + per-agent `--session-dir`; herdr panes tail logs | Switch to interactive `pi` panes driven via herdr CLI/IPC if RPC lacks needed session/extension visibility or live TUI inspection is required during debugging |
| **Q2** YAML schema | §3 fields only | Extend only if a concrete v1 requirement proves a new field is needed before `/to-spec` lock |
| **Q3** unmentioned context sync | Push via RPC `bash` echo (`pushContext`), silence-unless-addressed prompt | Switch to lazy catch-up on next dispatched turn if pushing causes noisy replies, high idle token burn, or RPC queue backpressure |
| **Q4** test seam | `PiAgentClient` + `HerdrPaneManager` interfaces, fake + real | Narrow or split the seam if integration tests with real `pi`/`herdr` expose timing or process-lifecycle edge cases |

---

## 12. `/to-tickets` tracer-bullet slices

Each ticket is one fresh context window, ships a working increment, and depends only on earlier tickets. Tests use the fakes; the final ticket swaps in real `pi`/`herdr`.

**How to write a DoD bullet** (post-RCA rule; a bullet that says "persists state" cannot fail):

- Name the **exit paths and state**, not the capability.
  - Not: "persist `RoomState`". Instead: "`startedAt` and each agent's `pid`/`sessionDir` are identical across boot, submit, halt, shutdown, and after re-reading the file".
  - Not: "atomic write". Instead: "a partial final line reads as N complete messages plus one skipped".
- Every seam method the ticket implements needs its failure case in the DoD (rejects / returns / hangs), because §9's failure table is the contract.
- Fakes must be able to fail: a DoD that needs a rejection names the fake's failure knob (`failOn`) or the ticket adds one.

| # | Ticket | Deliverable (DoD) | Depends on |
|---|---|---|---|
| T1 | **Config loader** | Parse + validate YAML → `LoadedConfig`; resolve `room_dir`/`system_prompt_file`; reject unknown keys, `system_prompt`+`system_prompt_file` together, duplicate ids; unit tests. | — |
| T2 | **Persistence** | `messages.jsonl` append + `state.json` atomic write; types from §4; append/read/rebuild unit tests. | T1 |
| T3 | **Seams (interfaces + fakes)** | `PiAgentClient` + `HerdrPaneManager` interfaces and in-memory fakes with scripted agents and a pane registry; tests. | T1 |
| T4 | **Router** | `extractMentions`: @mention parse, `@lead`/handle resolution, dedup/order; pure unit tests. (v1's no-mention → lead fallback was reversed by D6, #35.) | T1 |
| T5 | **System prompt builder** | Role + social contract + lead DoD prompt from config (§5); golden tests. | T1 |
| T6 | **Turn loop + hop cap + nudge** | `TurnLoop` over fakes: dispatch, settle, append, chain propagation, `max_hops` nudge, `hop_limit_reached` halt, human reset; state-machine tests. | T2, T3, T4, T5 |
| T7 | **Startup task / idle modes** | Boot posts `task` + triggers lead when present; idle start otherwise; D2 tests. | T6 |
| T8 | **Real `PiAgentClient`** | Spawn `pi --mode rpc` with `--session-dir`/`--session-id`/`--system-prompt`/`--append-system-prompt`; prompt→settle→`get_last_assistant_text`; pushContext via `bash`; shutdown. Integration test against a real `pi` session. | T3 |
| T9 | **Real `HerdrPaneManager`** | Open agent panes, tail logs, close (hide) without killing pi. Integration test. | T3 |
| T10 | **Coordinator wiring** | Compose config→persistence→router→turn loop→real seams→panes; end-to-end run of a 2-agent room; `typecheck` + `bun test` green. | T6, T8, T9 |

Sequence is linear (T1→T10). T3/T4/T5 are parallelizable after T1, then T6 joins them; T8/T9 are parallelizable after T3; T10 is the integration join.

---

## 13. Definition of Done for the project

- `bun test` green (fake-seam unit tests + at least one real-`pi` integration test + one herdr integration test, the latter skippable when herdr is absent).
- `tsc --noEmit` clean.
- A 2-agent YAML team runs end-to-end: startup task → lead → specialist → `DONE`, visible in the room pane, with per-agent panes tailing logs.
- `max_hops` nudge and `hop_limit_reached` halt both observed in a test.
