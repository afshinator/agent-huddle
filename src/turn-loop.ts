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

/** `DONE` on a line of its own (§6.5: `/^DONE$/m` with trimmed lines). */
export function hasDoneSignal(text: string | null): boolean {
  if (text === null) return false;
  return text.split("\n").some((line) => line.trim() === "DONE");
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
  now?: () => string;
  newId?: () => string;
  onChainState?: (state: ChainState | null) => Promise<void> | void;
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
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly handleById: Map<string, string>;
  private readonly onChainState?: (state: ChainState | null) => Promise<void> | void;
  private readonly isStoppingHook?: () => boolean;

  constructor(deps: TurnLoopDeps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.pi = deps.pi;
    this.telemetry = deps.telemetry;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 300_000;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.handleById = new Map(deps.config.allAgents.map((a) => [a.id, a.handle]));
    this.onChainState = deps.onChainState;
    this.isStoppingHook = deps.isStopping;
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
    const queue: Array<{ agentId: string; text: string; from: string; ackRequired: boolean }> = initialTargets.map(
      (agentId) => ({
        agentId,
        text,
        from: "supervisor",
        ackRequired: needsAck(this.cfg, kind, initialTargets, text, "supervisor"),
      }),
    );
    await this.syncContext(chain, text, queue.map((t) => t.agentId));

    if (queue.length === 0) {
      await this.append(
        chain,
        "notice",
        "room",
        `no agent addressed; ${this.cfg.allAgents.length} agents have the message as context`,
        0,
      );
      return this.finish(chain, "completed");
    }

    while (queue.length > 0) {
      const { agentId, text: promptText, ackRequired } = queue.shift()!;
      if (chain.hopCount >= this.cfg.config.max_hops) {
        return this.wrapUp(chain);
      }
      const settled = await this.dispatch(chain, agentId, promptText, true);
      if (settled === null) return this.finish(chain, this.isStopping() ? "cancelled" : "halted");

      if (ackRequired && !hasAck(settled.lastText)) {
        const handle = this.cfg.agentById.get(agentId)?.handle ?? agentId;
        await this.append(
          chain,
          "notice",
          "room",
          `${handle} answered a direct message without "Got it: …" — a silent pickup is indistinguishable from a miss`,
          chain.hopCount,
        );
      }
      if (this.isDone(agentId, settled.lastText)) return this.finish(chain, "completed");

      const reply = settled.lastText ?? "";
      const resolution = resolveMentions(reply, this.cfg);
      if (resolution.unknownHandles.length > 0) {
        await this.append(chain, "notice", "room", `unknown agent mention(s): ${resolution.unknownHandles.join(", ")}`, chain.hopCount);
      }
      // A mention of the author is a note to others, not a dispatch to itself.
      const nextIds = resolution.targets.filter((id) => id !== agentId);
      for (const nextId of nextIds) {
        queue.push({
          agentId: nextId,
          text: reply,
          from: agentId,
          ackRequired: needsAck(this.cfg, "user", resolution.targets, reply, agentId),
        });
      }
      await this.syncContext(chain, reply, nextIds, agentId);
    }

    return this.finish(chain, "completed");
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
    if (countHop) chain.hopCount += 1;
    const hop = chain.hopCount;
    if (!chain.dispatchedAgentIds.includes(agentId)) chain.dispatchedAgentIds.push(agentId);
    await this.notifyChainState(chain);

    return this.telemetry.span("agent.turn", { agentId, hop, chainId: chain.chainId }, async (span) => {
      this.telemetry.counter("room.hops_total", { agentId, chainId: chain.chainId });
      span.addEvent("dispatch", { agentId });
      try {
        await this.pi.prompt(agentId, { message: text, streamingBehavior: "followUp" });
        const startedAt = performance.now();
        const settled = await this.pi.waitForSettled(agentId, this.turnTimeoutMs);
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
