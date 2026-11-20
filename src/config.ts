import { access, readFile } from "node:fs/promises";
import { errorMessage } from "./errors";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSpec {
  id: string;                    // unique, stable session id (D7)
  handle: string;                // "@name" (unique: the @mention namespace)
  role: string;                  // one-line lane description
  system_prompt?: string;        // XOR system_prompt_file
  system_prompt_file?: string;   // resolved absolute
  provider?: string;             // pi --provider
  model?: string;                // pi --model
  thinking?: ThinkingLevel;      // pi --thinking
  tools?: string[];              // pi --tools allowlist
}

export interface RoomConfig {
  name: string;
  room_dir: string;              // absolute
  task?: string;                 // D2 optional startup task
  definition_of_done?: string;   // D2 optional
  max_hops: number;              // default 12
  turn_timeout_ms: number;       // default 300000: how long one agent turn may take
  lead: AgentSpec;
  agents: AgentSpec[];
}

export interface LoadedConfig {
  config: RoomConfig;
  sourcePath: string;
  allAgents: AgentSpec[];        // [lead, ...agents] in stable order
  agentById: Map<string, AgentSpec>;
}

const THINKING_LEVELS = new Set<string>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

const ROOM_KEYS = new Set<string>([
  "name", "room_dir", "task", "definition_of_done", "max_hops", "turn_timeout_ms", "lead", "agents",
]);

const AGENT_KEYS = new Set<string>([
  "id", "handle", "role", "system_prompt", "system_prompt_file",
  "provider", "model", "thinking", "tools",
]);

import { HANDLE_RE, LEAD_TOKEN, RESERVED_HANDLES } from "./router";

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(msg);
}

function assertPlainObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`${what} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

function assertString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${what} must be a non-empty string`);
  return v;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  what: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${what}: unknown key "${key}"`);
  }
}

function parseAgent(v: unknown, what: string): AgentSpec {
  const obj = assertPlainObject(v, what);
  rejectUnknownKeys(obj, AGENT_KEYS, what);

  const id = assertString(obj.id, `${what}.id`);
  const handle = assertString(obj.handle, `${what}.handle`);
  const role = assertString(obj.role, `${what}.role`);

  if (!HANDLE_RE.test(handle)) {
    fail(`${what}.handle must look like "@dev1" (got "${handle}")`);
  }

  const systemPrompt = obj.system_prompt;
  const systemPromptFile = obj.system_prompt_file;
  if (systemPrompt !== undefined && systemPromptFile !== undefined) {
    fail(`${what}: system_prompt and system_prompt_file are mutually exclusive`);
  }
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
    fail(`${what}.system_prompt must be a string`);
  }
  if (systemPromptFile !== undefined && typeof systemPromptFile !== "string") {
    fail(`${what}.system_prompt_file must be a string`);
  }

  const thinking = obj.thinking;
  if (
    thinking !== undefined &&
    (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))
  ) {
    fail(`${what}.thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
  }

  const tools = obj.tools;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every((t) => typeof t === "string"))) {
    fail(`${what}.tools must be a list of strings`);
  }

  const provider = obj.provider;
  if (provider !== undefined && typeof provider !== "string") fail(`${what}.provider must be a string`);
  const model = obj.model;
  if (model !== undefined && typeof model !== "string") fail(`${what}.model must be a string`);

  const agent: AgentSpec = { id, handle, role };
  if (systemPrompt !== undefined) agent.system_prompt = systemPrompt as string;
  if (systemPromptFile !== undefined) agent.system_prompt_file = systemPromptFile as string;
  if (provider !== undefined) agent.provider = provider as string;
  if (model !== undefined) agent.model = model as string;
  if (thinking !== undefined) agent.thinking = thinking as ThinkingLevel;
  if (tools !== undefined) agent.tools = tools as string[];
  return agent;
}

/**
 * Load and validate a YAML team template.
 * - `room_dir` resolves against `cwd` (default: <cwd>/rooms/<name>).
 * - `system_prompt_file` resolves against the YAML file's directory.
 */
export async function loadConfig(yamlPath: string, cwd = process.cwd()): Promise<LoadedConfig> {
  const sourcePath = resolve(cwd, yamlPath);

  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (e) {
    fail(`cannot read config: ${errorMessage(e)}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    fail(`invalid YAML: ${errorMessage(e)}`);
  }

  const obj = assertPlainObject(raw, "config");
  rejectUnknownKeys(obj, ROOM_KEYS, "config");

  const name = assertString(obj.name, "config.name");

  const roomDirRaw = obj.room_dir;
  const room_dir = resolve(
    cwd,
    roomDirRaw !== undefined ? assertString(roomDirRaw, "config.room_dir") : `rooms/${name}`,
  );

  const task = obj.task;
  if (task !== undefined && typeof task !== "string") fail("config.task must be a string");
  const definition_of_done = obj.definition_of_done;
  if (definition_of_done !== undefined && typeof definition_of_done !== "string") {
    fail("config.definition_of_done must be a string");
  }

  const maxHopsRaw = obj.max_hops;
  let max_hops = 12;
  if (maxHopsRaw !== undefined) {
    if (typeof maxHopsRaw !== "number" || !Number.isInteger(maxHopsRaw) || maxHopsRaw < 1) {
      fail("config.max_hops must be a positive integer");
    }
    max_hops = maxHopsRaw;
  }

  const turnTimeoutRaw = obj.turn_timeout_ms;
  let turn_timeout_ms = 300_000;
  if (turnTimeoutRaw !== undefined) {
    if (typeof turnTimeoutRaw !== "number" || !Number.isInteger(turnTimeoutRaw) || turnTimeoutRaw < 1) {
      fail("config.turn_timeout_ms must be a positive integer");
    }
    turn_timeout_ms = turnTimeoutRaw;
  }

  if (obj.lead === undefined) fail("config.lead is required");
  const lead = parseAgent(obj.lead, "config.lead");

  const agentsRaw = obj.agents ?? [];
  if (!Array.isArray(agentsRaw)) fail("config.agents must be a list");
  const agents = agentsRaw.map((a, i) => parseAgent(a, `config.agents[${i}]`));

  const allAgents = [lead, ...agents];

  // Resolve system_prompt_file against the YAML file's directory.
  const yamlDir = dirname(sourcePath);
  for (const agent of allAgents) {
    if (agent.system_prompt_file !== undefined) {
      agent.system_prompt_file = isAbsolute(agent.system_prompt_file)
        ? agent.system_prompt_file
        : resolve(yamlDir, agent.system_prompt_file);
      try {
        await access(agent.system_prompt_file);
      } catch (error: unknown) {
        const message = errorMessage(error);
        fail(`${agent.id}.system_prompt_file is not readable: ${agent.system_prompt_file} (${message})`);
      }
    }
  }

  // Unique ids (session ids) and unique handles (@mention namespace).
  const seenIds = new Set<string>();
  for (const a of allAgents) {
    if (seenIds.has(a.id)) fail(`duplicate agent id "${a.id}"`);
    seenIds.add(a.id);
  }
  const seenHandles = new Set<string>();
  for (const a of allAgents) {
    if (seenHandles.has(a.handle)) fail(`duplicate agent handle "${a.handle}"`);
    seenHandles.add(a.handle);
  }
  // Routed before the handle map ever sees it, so such an agent is unreachable.
  // The lead keeps `@lead`, which the router resolves to it. Duplicate ids were
  // rejected above, so `a.id === lead.id` identifies the lead.
  for (const a of allAgents) {
    const allowedReserved = a.id === lead.id && a.handle === LEAD_TOKEN;
    if (RESERVED_HANDLES.has(a.handle) && !allowedReserved) {
      const field =
        a.id === lead.id ? "config.lead.handle" : `config.agents[${agents.indexOf(a)}].handle`;
      fail(`${field} is reserved by the router and would never reach this agent (got "${a.handle}")`);
    }
  }

  return {
    config: {
      name,
      room_dir,
      ...(task !== undefined ? { task: task as string } : {}),
      ...(definition_of_done !== undefined ? { definition_of_done: definition_of_done as string } : {}),
      max_hops,
      turn_timeout_ms,
      lead,
      agents,
    },
    sourcePath,
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}
