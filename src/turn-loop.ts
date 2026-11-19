import { randomUUID } from "node:crypto";
import type { LoadedConfig } from "./config";
import type { MessageKind, RoomMessage } from "./messages";
import type { ChainState } from "./state";
import type { RoomStore } from "./store";
import { extractMentions, resolveTargets } from "./router";
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

export type SubmitKind = "user" | "startup_task";
export type ChainOutcome = "completed" | "halted";

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

  constructor(deps: TurnLoopDeps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.pi = deps.pi;
    this.telemetry = deps.telemetry;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 120_000;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.handleById = new Map(deps.config.allAgents.map((a) => [a.id, a.handle]));
  }

  async submit(text: string, kind: SubmitKind = "user"): Promise<SubmitResult> {
    const chain: ChainState = {
      chainId: this.newId(),
      startedBy: kind === "startup_task" ? "startup" : "supervisor",
      hopCount: 0,
      nudgeIssued: false,
      status: "active",
      dispatchedAgentIds: [],
    };

    return this.telemetry.span(
      "chain",
      { chainId: chain.chainId, room: this.cfg.config.name, kind },
      async () => {
        await this.append(chain, kind, kind === "user" ? "supervisor" : "room", text, 0);

        const queue: Array<{ agentId: string; text: string }> = resolveTargets(
          text,
          this.cfg,
        ).map((agentId) => ({ agentId, text }));
        await this.syncContext(text, queue.map((t) => t.agentId));

        while (queue.length > 0) {
          const { agentId, text: promptText } = queue.shift()!;
          if (chain.hopCount >= this.cfg.config.max_hops) {
            return this.wrapUp(chain);
          }
          const settled = await this.dispatch(chain, agentId, promptText, true);
          if (settled === null) return this.finish(chain, "halted");

          if (this.isDone(agentId, settled.lastText)) return this.finish(chain, "completed");

          const reply = settled.lastText ?? "";
          const nextIds = extractMentions(reply, this.cfg);
          for (const nextId of nextIds) queue.push({ agentId: nextId, text: reply });
          await this.syncContext(reply, nextIds, agentId);
        }

        return this.finish(chain, "completed");
      },
    );
  }

  /** Lead wrap-up, then one concluding turn per previously dispatched agent. */
  private async wrapUp(chain: ChainState): Promise<SubmitResult> {
    chain.nudgeIssued = true;
    chain.status = "wrap_up";
    this.telemetry.log("warn", "max_hops reached; issuing wrap-up nudge", {
      chainId: chain.chainId,
      maxHops: this.cfg.config.max_hops,
    });

    const leadId = this.cfg.config.lead.id;
    const nudge = await this.dispatch(chain, leadId, wrapUpPrompt(this.cfg.config.max_hops), false);
    if (nudge === null) return this.finish(chain, "halted");
    if (this.isDone(leadId, nudge.lastText)) return this.finish(chain, "completed");

    const others = chain.dispatchedAgentIds.filter((id) => id !== leadId);
    for (const agentId of others) {
      const settled = await this.dispatch(chain, agentId, CONCLUDE_PROMPT, false);
      if (settled === null) return this.finish(chain, "halted");
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

    return this.telemetry.span("agent.turn", { agentId, hop, chainId: chain.chainId }, async (span) => {
      this.telemetry.counter("room.hops_total", { agentId, chainId: chain.chainId });
      span.addEvent("dispatch", { agentId });
      try {
        await this.pi.prompt(agentId, { message: text });
        const settled = await this.pi.waitForSettled(agentId, this.turnTimeoutMs);
        await this.append(chain, "agent", agentId, settled.lastText ?? "", hop);
        if (settled.aborted) span.setStatus("error", "aborted");
        return settled;
      } catch (e) {
        const msg = (e as Error).message;
        this.telemetry.log("error", "agent turn failed", { agentId, error: msg });
        span.setStatus("error", msg);
        await this.append(chain, "notice", "room", `agent ${agentId} failed: ${msg}`, hop);
        return null;
      }
    });
  }

  private isDone(agentId: string, text: string | null): boolean {
    return agentId === this.cfg.config.lead.id && hasDoneSignal(text);
  }

  /** D8: every agent not targeted by this message still ingests it as context. */
  private async syncContext(text: string, targets: string[], excludeId?: string): Promise<void> {
    if (text.trim() === "") return;
    for (const agent of this.cfg.allAgents) {
      if (agent.id === excludeId) continue;
      if (!targets.includes(agent.id)) await this.pi.pushContext(agent.id, text);
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

  private finish(chain: ChainState, status: ChainOutcome): SubmitResult {
    if (status === "halted") chain.status = "halted";
    return { chainId: chain.chainId, status, hopCount: chain.hopCount };
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
