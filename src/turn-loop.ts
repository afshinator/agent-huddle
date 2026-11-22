import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { LoadedConfig } from "./config";
import type { MessageKind, RoomMessage } from "./messages";
import type { ChainState } from "./state";
import type { RoomStore } from "./store";
import { extractMentions, mentionsBroadcast, resolveMentions } from "./router";
import { errorMessage } from "./errors";
import type { PiAgentClient, SettledResult } from "./seams/pi-agent-client";
import type { Telemetry } from "./telemetry";

export function wrapUpPrompt(maxHops: number): string {
  return [
    `You have hit max_hops (${maxHops}) without finishing the definition of done.`,
    "Instruct the active agents to conclude now: summarize what is done, what",
    "remains, and the blockers. Do not start new work.",
  ].join("\n");
}

export const CONCLUDE_PROMPT =
  "Wrap up: summarize what is done, what remains, and the blockers. Do not start new work.";

/**
 * How long a turn may be silent before the room asks it for a status line.
 *
 * A live agent shows a tool call or a sentence every few seconds; two minutes of nothing means it is
 * thinking at length or has lost the thread, and both are better asked than waited out — the settle
 * timeout is thirty minutes (T16).
 */
export const NUDGE_IDLE_MS = 120_000;

/** How often a running turn's silence is checked. Costs a timer, not a token. */
export const NUDGE_CHECK_MS = 15_000;

/**
 * What the room says when it stops waiting. It has to ask for text: the room records a turn's words
 * (`settled.lastText`), so an agent that answers by running a command has said nothing.
 */
export const NUDGE_PROMPT =
  "Status only, in one line of text, now: what you have done so far and whether you are still on it. " +
  "The room reads only what you write in your reply — a tool call is not an answer to the room.";

/** `DONE` on a line of its own (§6.5: `/^DONE$/m` with trimmed lines). */
export function hasDoneSignal(text: string | null): boolean {
  if (text === null) return false;
  // A line of its own, or the word the reply ends on: models write "…said go. DONE" and meant it,
  // and a DONE the room ignores dispatches an agent that has nothing left to do (#75).
  if (/(^|\n)\s*DONE\s*$/.test(text)) return true;
  // …or after a sentence it closes: "Count matches, @reviewer said go. DONE". "almost DONE" is not
  // an ending, which is why the punctuation before it is required.
  return /[.!?]\s+DONE\s*$/.test(text);
}

/**
 * `Got it: …` on the first non-blank line of a reply (#60). Models start with a blank line
 * often enough that "the first line" has to mean the first one with text in it.
 */
export function hasAck(text: string | null): boolean {
  if (text === null) return false;
  const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "");
  return first !== undefined && /^Got it:\s+\S/.test(first);
}

/**
 * A direct message expects an acknowledgement; a broadcast does not, and neither does the
 * startup task, which is a boot directive rather than a peer message (#60).
 *
 * `ack_scope` decides whose direct mention counts (default `lead`): by default only the lead
 * and the supervisor, because a peer's hand-off is ordinary work; `anyone` widens it to every
 * agent. `sender` is the agent id that wrote the text, or `"supervisor"` for human input.
 */
function needsAck(cfg: LoadedConfig, kind: SubmitKind, targets: readonly string[], text: string, sender: string): boolean {
  if (kind === "startup_task") return false;
  if (targets.length !== 1 || mentionsBroadcast(text)) return false;
  if (cfg.config.ack_scope === "anyone") return true;
  return sender === "supervisor" || sender === cfg.config.lead.id;
}

export type SubmitKind = "user" | "startup_task";
/**
 * `cancelled`: the operator stopped the room with a turn in flight. Not a failure —
 * the turn died because we asked it to — so it must not halt the room (#51).
 */
export type ChainOutcome = "completed" | "halted" | "cancelled";

/** One agent's turn waiting to be dispatched: the message it gets, and who sent it. */
interface PendingTurn {
  agentId: string;
  text: string;
  from: string;
  ackRequired: boolean;
}

export interface SubmitResult {
  chainId: string;
  status: ChainOutcome;
  hopCount: number;
}

export interface TurnLoopDeps {
  config: LoadedConfig;
  store: RoomStore;
  pi: PiAgentClient;
  telemetry: Telemetry;
  turnTimeoutMs?: number;
  /** Silence before a status request; defaults to `NUDGE_IDLE_MS` (T16). */
  idleNudgeMs?: number;
  /** How often that silence is checked; defaults to `NUDGE_CHECK_MS`. */
  nudgeCheckMs?: number;
  now?: () => string;
  newId?: () => string;
  onChainState?: (state: ChainState | null) => Promise<void> | void;
  /** Called when an agent is dispatched, so the record can mark where its turn begins (#76). */
  onDispatch?: (agentId: string) => void;
  /** True once the room is stopping, so a dying turn reads as cancelled, not failed. */
  isStopping?: () => boolean;
}

/**
 * Drives one user-turn chain to completion (§6.1–§6.6).
 *
 * A hop = one dispatched agent turn. Hops are capped by `max_hops`; on reaching
 * the cap the lead gets one wrap-up turn, then every agent dispatched in the
 * chain gets exactly one concluding turn. Still no `DONE` → halt.
 */
export class TurnLoop {
  private readonly cfg: LoadedConfig;
  private readonly store: RoomStore;
  private readonly pi: PiAgentClient;
  private readonly telemetry: Telemetry;
  private readonly turnTimeoutMs: number;
  private readonly idleNudgeMs: number;
  private readonly nudgeCheckMs: number;
  /** Last time an agent showed any sign of life in its current turn (T16). */
  private readonly lastEvent = new Map<string, number>();
  /** Tools this agent has started and not yet finished: a running tool is work, not silence (T16). */
  private readonly openTools = new Map<string, number>();
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly handleById: Map<string, string>;
  /** Text streamed in each agent's current turn, so a timed-out turn still has something to say. */
  private readonly streamed = new Map<string, string>();
  private readonly onChainState?: (state: ChainState | null) => Promise<void> | void;
  private readonly onDispatch?: (agentId: string) => void;
  private readonly isStoppingHook?: () => boolean;

  constructor(deps: TurnLoopDeps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.pi = deps.pi;
    this.telemetry = deps.telemetry;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 300_000;
    this.idleNudgeMs = deps.idleNudgeMs ?? NUDGE_IDLE_MS;
    this.nudgeCheckMs = deps.nudgeCheckMs ?? NUDGE_CHECK_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.handleById = new Map(deps.config.allAgents.map((a) => [a.id, a.handle]));
    this.onChainState = deps.onChainState;
    this.onDispatch = deps.onDispatch;
    this.isStoppingHook = deps.isStopping;
    // The room's own copy of what has streamed this turn: a turn that times out has already said
    // things on screen, and dropping them ends the chain one step short (#73).
    for (const agent of deps.config.allAgents) {
      deps.pi.on("stream", agent.id, (delta) => {
        this.streamed.set(agent.id, (this.streamed.get(agent.id) ?? "") + delta);
        this.lastEvent.set(agent.id, Date.now());
      });
      // A tool call is activity too: an agent that runs forty of them is working, not stuck. A tool
      // that has *started* is still activity while it runs — `npm run check` takes minutes, and a
      // status request injected into that is a question the agent cannot answer until it ends.
      deps.pi.on("tool", agent.id, () => {
        this.lastEvent.set(agent.id, Date.now());
        this.openTools.set(agent.id, (this.openTools.get(agent.id) ?? 0) + 1);
      });
      deps.pi.on("tool_end", agent.id, () => {
        this.lastEvent.set(agent.id, Date.now());
        this.openTools.set(agent.id, Math.max(0, (this.openTools.get(agent.id) ?? 0) - 1));
      });
    }
  }

  /**
   * `targets` pins the first dispatch, for input whose text must stay as typed:
   * a pane line keeps the handles the supervisor wrote, but routes to that pane's
   * agent only (#40). Mentions in the text are still recorded and still produce
   * the unknown-handle notice.
   */
  async submit(text: string, kind: SubmitKind = "user", targets?: readonly string[]): Promise<SubmitResult> {
    const chain: ChainState = {
      chainId: this.newId(),
      startedBy: kind === "startup_task" ? "startup" : "supervisor",
      hopCount: 0,
      nudgeIssued: false,
      status: "active",
      dispatchedAgentIds: [],
    };
    await this.notifyChainState(chain);

    return this.telemetry.span(
      "chain",
      { chainId: chain.chainId, room: this.cfg.config.name, kind },
      async () => {
        this.telemetry.upDownCounter("room.active_chains", { room: this.cfg.config.name }, 1);
        try {
          return await this.runChain(chain, text, kind, targets);
        } finally {
          this.telemetry.upDownCounter("room.active_chains", { room: this.cfg.config.name }, -1);
        }
      },
    );
  }

  /** One chain: dispatch the initial targets, then follow every reply's mentions. */
  private async runChain(
    chain: ChainState,
    text: string,
    kind: SubmitKind,
    pinnedTargets?: readonly string[],
  ): Promise<SubmitResult> {
    await this.append(chain, kind, kind === "user" ? "supervisor" : "room", text, 0);

    const initialResolution = resolveMentions(text, this.cfg);
    if (initialResolution.unknownHandles.length > 0) {
      await this.append(chain, "notice", "room", `unknown agent mention(s): ${initialResolution.unknownHandles.join(", ")}`, 0);
    }
    // D6: no mention activates nobody. The startup task is a boot directive, not a
    // chat message, so it addresses the lead — even when it names agents (#57): the
    // named agents receive it as context, and the lead decides who works.
    const initialTargets =
      pinnedTargets ??
      (kind === "startup_task" ? [this.cfg.config.lead.id] : initialResolution.targets);
    let pending: PendingTurn[] = initialTargets.map(
      (agentId) => ({
        agentId,
        text,
        from: "supervisor",
        ackRequired: needsAck(this.cfg, kind, initialTargets, text, "supervisor"),
      }),
    );
    await this.syncContext(chain, text, pending.map((t) => t.agentId));

    if (pending.length === 0) {
      await this.append(
        chain,
        "notice",
        "room",
        `no agent addressed; ${this.cfg.allAgents.length} agents have the message as context`,
        0,
      );
      return this.finish(chain, "completed");
    }

    // One wave per message: every agent this message names is handed its turn now, not after the
    // previous one finishes. A two-verifier gate used to run in series — the second agent sat idle
    // for the whole of the first agent's turn — which is a room spending wall clock on nothing.
    // A repeat of an agent already in the wave waits for the next wave: one agent, one turn at a time.
    while (pending.length > 0) {
      if (chain.hopCount >= this.cfg.config.max_hops) {
        return this.wrapUp(chain);
      }
      const wave: PendingTurn[] = [];
      const later: PendingTurn[] = [];
      for (const item of pending) {
        if (wave.some((w) => w.agentId === item.agentId)) later.push(item);
        else wave.push(item);
      }
      pending = later;

      const settledWave = await Promise.all(
        wave.map((item) => this.dispatch(chain, item.agentId, item.text, true)),
      );
      const replies: string[] = [];
      let finished = false;
      for (const [index, item] of wave.entries()) {
        const settled = settledWave[index] ?? null;
        if (settled === null) return this.finish(chain, this.isStopping() ? "cancelled" : "halted");
        const { next, done, reply } = await this.routeReply(chain, item.agentId, item.ackRequired, settled);
        replies.push(reply);
        if (done) {
          finished = true;
          break;
        }
        pending.push(...next);
      }
      if (finished) return this.finish(chain, "completed");
      // One context push per wave, not one per reply: the agents left out of this wave are told what
      // the whole wave said, including anyone it just started. Pushing per reply told each of them the
      // same thing twice.
      const spoken = replies.filter((r) => r.trim() !== "").join("\n\n");
      const addressed = [...new Set([...wave.map((w) => w.agentId), ...pending.map((p) => p.agentId)])];
      await this.syncContext(chain, spoken, addressed);
    }

    return this.finish(chain, "completed");
  }

  /**
   * What a settled turn does once it has spoken: the ack notice, a `DONE`, and who it starts next.
   *
   * Extracted so a wave can settle several turns and route each reply identically; the rules here are
   * unchanged from the sequential loop (#68, #73, D18).
   */
  private async routeReply(
    chain: ChainState,
    agentId: string,
    ackRequired: boolean,
    settled: SettledResult,
  ): Promise<{ next: PendingTurn[]; done: boolean; reply: string }> {
    // An empty reply said nothing: "silent pickup" would be a notice about a turn that never spoke.
    if (ackRequired && (settled.lastText ?? "").trim() !== "" && !hasAck(settled.lastText)) {
      const handle = this.cfg.agentById.get(agentId)?.handle ?? agentId;
      await this.append(
        chain,
        "notice",
        "room",
        `${handle} answered a direct message without "Got it: …" — a silent pickup is indistinguishable from a miss`,
        chain.hopCount,
      );
    }
    const done = this.isDone(agentId, settled.lastText);

    const reply = settled.lastText ?? "";
    const resolution = resolveMentions(reply, this.cfg);
    if (resolution.unknownHandles.length > 0) {
      await this.append(chain, "notice", "room", `unknown agent mention(s): ${resolution.unknownHandles.join(", ")}`, chain.hopCount);
    }
    // D18: with `dispatch_scope: lead`, work is handed out by the lead and reports go back to it,
    // so dev1's report ending "@reviewer count is 28" cannot start a verification nobody asked
    // for. `anyone` (the default) keeps every mention a dispatch. A mention of the author is a
    // note to others, not a dispatch to itself.
    const leadOnly = this.cfg.config.dispatch_scope === "lead";
    const leadId = this.cfg.config.lead.id;
    // Under `lead` a reply from anyone else always reports upward: the lead is the router, so a
    // report that forgets to write "@lead" must not leave the chain silent (live run, #68).
    const reportUp = leadOnly && agentId !== leadId ? [leadId] : [];
    const nextIds = [
      ...new Set([
        ...reportUp,
        ...resolution.targets.filter(
          (id) => id !== agentId && (!leadOnly || agentId === leadId || id === leadId),
        ),
      ]),
    ];
    const next: PendingTurn[] = nextIds.map((nextId) => ({
      agentId: nextId,
      text: reply,
      from: agentId,
      ackRequired: needsAck(this.cfg, "user", resolution.targets, reply, agentId),
    }));
    // Why this reply started whom: without it, "the same agent ran twice" is unattributable
    // after the fact — a live run had the reviewer turn twice on one instruction (#73).
    this.telemetry.log("info", "dispatch", {
      chainId: chain.chainId,
      hop: chain.hopCount,
      from: agentId,
      targets: resolution.targets,
      queued: nextIds,
      broadcast: resolution.targets.length === this.cfg.allAgents.length,
      selfMention: resolution.targets.includes(agentId),
    });
    return { next, done, reply };
  }

  /**
   * Wait for a turn, and if it goes quiet, ask it once for a status line in the room.
   *
   * The nudge uses `steer`, not `followUp`: pi delivers a follow-up only when the agent stops, which is
   * after the turn it was meant to rescue (pi `docs/rpc-commands.md`). A steer lands at the agent's next
   * tool boundary, inside the same turn — so it costs no hop, and a failed steer is a notice rather than
   * the end of the chain (T16).
   */
  private async settleWithNudge(chain: ChainState, agentId: string, hop: number): Promise<SettledResult> {
    this.lastEvent.set(agentId, Date.now());
    this.openTools.set(agentId, 0);
    const pending = this.pi.waitForSettled(agentId, this.turnTimeoutMs);
    let settledNow = false;
    // Resolved either way, so the race below never waits on an error and the caller still awaits
    // `pending` for the value or the rejection.
    const settled = pending.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      settledNow = true;
    });

    let nudged = false;
    while (!settledNow) {
      // Raced, not slept: a turn that settles at once must not cost one check interval of latency.
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, this.nudgeCheckMs))]);
      if (settledNow || nudged) continue;
      // Nothing to ask while a tool is running: the agent is working, and a steer would only land
      // after that tool anyway.
      if ((this.openTools.get(agentId) ?? 0) > 0) continue;
      const silentFor = Date.now() - (this.lastEvent.get(agentId) ?? Date.now());
      if (silentFor < this.idleNudgeMs) continue;
      nudged = true;
      await this.append(
        chain,
        "notice",
        "room",
        `agent ${agentId}: silent for ${Math.max(1, Math.round(silentFor / 1000))}s — asked for a status line`,
        hop,
      );
      try {
        await this.pi.prompt(agentId, { message: NUDGE_PROMPT, streamingBehavior: "steer" });
      } catch (e) {
        await this.append(chain, "notice", "room", `agent ${agentId} nudge failed: ${errorMessage(e)}`, hop);
      }
    }
    return pending;
  }

  /** Lead wrap-up, then one concluding turn per previously dispatched agent. */
  private async wrapUp(chain: ChainState): Promise<SubmitResult> {
    chain.nudgeIssued = true;
    chain.status = "wrap_up";
    await this.notifyChainState(chain);
    this.telemetry.log("warn", "max_hops reached; issuing wrap-up nudge", {
      chainId: chain.chainId,
      maxHops: this.cfg.config.max_hops,
    });

    const leadId = this.cfg.config.lead.id;
    const nudge = await this.dispatch(chain, leadId, wrapUpPrompt(this.cfg.config.max_hops), false);
    if (nudge === null) return this.finish(chain, this.isStopping() ? "cancelled" : "halted");
    if (this.isDone(leadId, nudge.lastText)) return this.finish(chain, "completed");

    const others = chain.dispatchedAgentIds.filter((id) => id !== leadId);
    for (const agentId of others) {
      const settled = await this.dispatch(chain, agentId, CONCLUDE_PROMPT, false);
      if (settled === null) return this.finish(chain, this.isStopping() ? "cancelled" : "halted");
      if (this.isDone(agentId, settled.lastText)) return this.finish(chain, "completed");
    }

    return this.halt(chain);
  }

  private async dispatch(
    chain: ChainState,
    agentId: string,
    text: string,
    countHop: boolean,
  ): Promise<SettledResult | null> {
    this.onDispatch?.(agentId);
    if (countHop) chain.hopCount += 1;
    const hop = chain.hopCount;
    if (!chain.dispatchedAgentIds.includes(agentId)) chain.dispatchedAgentIds.push(agentId);
    await this.notifyChainState(chain);

    return this.telemetry.span("agent.turn", { agentId, hop, chainId: chain.chainId }, async (span) => {
      this.telemetry.counter("room.hops_total", { agentId, chainId: chain.chainId });
      span.addEvent("dispatch", { agentId });
      try {
        this.streamed.set(agentId, "");
        await this.pi.prompt(agentId, { message: text, streamingBehavior: "followUp" });
        const startedAt = performance.now();
        const settled = await this.settleWithNudge(chain, agentId, hop);
        this.telemetry.histogram("agent.settle_latency_ms", performance.now() - startedAt, { agentId, chainId: chain.chainId });
        if (settled.aborted) {
          span.setStatus("error", "aborted");
          await this.append(chain, "notice", "room", `agent ${agentId} aborted`, hop);
          return null;
        }
        await this.append(chain, "agent", agentId, settled.lastText ?? "", hop);
        return settled;
      } catch (e) {
        const msg = errorMessage(e);
        // Ctrl-C kills the children in this process group too, so a turn in flight dies.
        // Reporting that as a failure would make a deliberate stop look like a crash.
        if (this.isStopping()) {
          this.telemetry.log("info", "agent turn cancelled by shutdown", { agentId, chainId: chain.chainId });
          span.setStatus("ok", "cancelled");
          return null;
        }
        this.telemetry.log("error", "agent turn failed", { agentId, error: msg });
        span.setStatus("error", msg);
        await this.append(chain, "notice", "room", `agent ${agentId}: ${msg}`, hop);
        // A timeout is not a failed turn: the agent wrote what it wrote, and a chain that ignores it
        // leaves the agent it named waiting forever. Hand on the text and keep going.
        const partial = this.streamed.get(agentId) ?? "";
        if (/settle timeout/.test(msg) && partial !== "") {
          await this.append(chain, "agent", agentId, partial, hop);
          await this.append(
            chain,
            "notice",
            "room",
            `agent ${agentId}: continuing with the ${partial.length} characters it had written`,
            hop,
          );
          return { aborted: false, lastText: partial };
        }
        return null;
      }
    });
  }

  private isStopping(): boolean {
    return this.isStoppingHook?.() ?? false;
  }

  private isDone(agentId: string, text: string | null): boolean {
    return agentId === this.cfg.config.lead.id && hasDoneSignal(text);
  }

  /** D8: every agent not targeted by this message still ingests it as context. */
  private async syncContext(
    chain: ChainState,
    text: string,
    targets: string[],
    excludeId?: string,
  ): Promise<void> {
    if (text.trim() === "") return;
    for (const agent of this.cfg.allAgents) {
      if (agent.id === excludeId) continue;
      if (targets.includes(agent.id)) continue;
      try {
        await this.pi.pushContext(agent.id, text);
        // Silence used to mean success and failure alike; one record per push makes the
        // difference visible without reading the agent's session file.
        this.telemetry.log("info", "context.push", { agentId: agent.id, chars: text.length });
      } catch (e) {
        // Context delivery is best-effort: it must never end the chain.
        const msg = errorMessage(e);
        this.telemetry.log("error", "context push failed", { agentId: agent.id, error: msg });
        await this.append(chain, "notice", "room", `agent ${agent.id} context push failed: ${msg}`, chain.hopCount);
      }
    }
  }

  private async halt(chain: ChainState): Promise<SubmitResult> {
    await this.append(
      chain,
      "hop_limit_reached",
      "room",
      `Hop limit reached (max_hops=${this.cfg.config.max_hops}) without the lead signalling DONE. ` +
        "Automatic routing has stopped; waiting for human input.",
      chain.hopCount,
    );
    return this.finish(chain, "halted");
  }

  private async finish(chain: ChainState, status: ChainOutcome): Promise<SubmitResult> {
    if (status === "halted") chain.status = "halted";
    await this.notifyChainState(status === "halted" ? chain : null);
    return { chainId: chain.chainId, status, hopCount: chain.hopCount };
  }

  private async notifyChainState(state: ChainState | null): Promise<void> {
    if (this.onChainState) await this.onChainState(state);
  }

  private async append(
    chain: ChainState,
    kind: MessageKind,
    from: string,
    text: string,
    hop: number,
  ): Promise<void> {
    const leadId = this.cfg.config.lead.id;
    const msg: RoomMessage = {
      id: this.newId(),
      ts: this.now(),
      kind,
      from,
      handle: this.handleById.get(from) ?? from,
      text,
      mentions: extractMentions(text, this.cfg),
      chainId: chain.chainId,
      hop,
      ...(from === leadId && hasDoneSignal(text) ? { doneSignal: true } : {}),
    };
    await this.store.appendMessage(msg);
  }
}
