import { readFile } from "node:fs/promises";
import type { AgentSpec, LoadedConfig } from "./config";
import { errorMessage } from "./errors";

async function readSystemPrompt(agent: AgentSpec): Promise<string | null> {
  if (agent.system_prompt !== undefined) return agent.system_prompt;
  if (agent.system_prompt_file !== undefined) {
    try {
      return await readFile(agent.system_prompt_file, "utf8");
    } catch (e) {
      throw new Error(
        `cannot read system_prompt_file for "${agent.id}": ${errorMessage(e)}`,
      );
    }
  }
  return null;
}

/** `--system-prompt`: role + custom system prompt (+ lead block for the lead). */
export async function buildRolePrompt(
  agent: AgentSpec,
  config: LoadedConfig,
): Promise<string> {
  const parts: string[] = [agent.role];
  const custom = await readSystemPrompt(agent);
  if (custom !== null) parts.push(custom);
  if (agent.id === config.config.lead.id) parts.push(buildLeadPrompt(config));
  // Every agent is measured against the same bar, so every agent is told what it is; a dev that
  // has to guess it builds to its own (d65ff65).
  parts.push(buildDonePrompt(config));
  return parts.join("\n\n");
}

/** The run's own bar, appended to every agent's prompt. */
export function buildDonePrompt(config: LoadedConfig): string {
  const dod = config.config.definition_of_done ?? "(none specified)";
  return `The definition of done for this run is: ${dod}`;
}

/** Lead-only block: coordinator instructions + the DONE signal. */
export function buildLeadPrompt(config: LoadedConfig): string {
  return [
    "You are the lead coordinator. Decompose the task, assign work via @handle,",
    "and integrate results. Do the specialist work yourself only as a last resort.",
    "When the definition of done is satisfied, end your reply with the line: DONE",
  ].join("\n");
}

/** `--append-system-prompt`: the shared-room social contract (§5 verbatim). */
export function buildSocialContract(agent: AgentSpec, config: LoadedConfig): string {
  const roomName = config.config.name;
  return [
    `You are ${agent.handle} in the shared room "${roomName}".`,
    "Every room message is shown to you as context.",
    `- If a message mentions you (${agent.handle}), respond from your lane: ${agent.role}.`,
    "- If a message mentions only other agents, read it and stay quiet — do not reply.",
    "- If the lead addresses you directly, respond from your lane.",
    "- You may mention other agents with @handle to hand off work.",
    config.config.ack_scope === "anyone"
      ? "- When any agent mentions you directly (one agent, not @all), begin your reply with"
      : "- When the lead or the supervisor mentions you directly (one agent, not @all), begin",
    "  your reply with one line: `Got it: <what you understood>`. Put no @handle in that",
    "  line — a mention there would dispatch the agent you are only quoting.",
  ].join("\n");
}
