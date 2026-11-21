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
  pane_writable?: boolean;       // pane accepts typed input (default true, D7)
}

export interface RoomConfig {
  name: string;
  room_dir: string;              // absolute
  task?: string;                 // D2 optional startup task
  definition_of_done?: string;   // D2 optional
  max_hops: number;              // default 12
  turn_timeout_ms: number;       // default 300000: how long one agent turn may take
  launch_guard?: "refuse" | "warn" | "off";  // default warn: git-root boot guard (#38)
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
  "name", "room_dir", "task", "definition_of_done", "max_hops", "turn_timeout_ms",
  "launch_guard", "lead", "agents",
]);

/** A run file names a template and carries only what is specific to that run. */
const RUN_KEYS = new Set<string>([...ROOM_KEYS, "template"]);

/** Keys a run may not set: they belong to the template, or to the file itself. */
const TEMPLATE_OWNED = new Set<string>(["name"]);

const LAUNCH_GUARDS = new Set(["refuse", "warn", "off"]);

const AGENT_KEYS = new Set<string>([
  "id", "handle", "role", "system_prompt", "system_prompt_file",
  "provider", "model", "thinking", "tools", "pane_writable",
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

  const paneWritable = obj.pane_writable;
  if (paneWritable !== undefined && typeof paneWritable !== "boolean") {
    fail(`${what}.pane_writable must be true or false`);
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
  if (paneWritable !== undefined) agent.pane_writable = paneWritable as boolean;
  return agent;
}

/**
 * Load and validate a YAML team template.
 * - `room_dir` resolves against `cwd` (default: <cwd>/rooms/<name>).
 * - `system_prompt_file` resolves against the YAML file's directory.
 */
interface ParsedFile {
  obj: Record<string, unknown>;
  path: string;
}

/** Read one YAML file, rejecting unknown keys, with prompt paths made absolute. */
async function readRoomFile(path: string, what: string, isRun: boolean): Promise<ParsedFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    fail(`cannot read ${what}: ${errorMessage(e)}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    fail(`invalid YAML in ${what}: ${errorMessage(e)}`);
  }

  const obj = assertPlainObject(raw, "config");
  rejectUnknownKeys(obj, isRun ? RUN_KEYS : ROOM_KEYS, "config");
  // A prompt path belongs to the file that wrote it: resolve it there, so a run that
  // overrides one agent cannot accidentally point into the template's directory.
  const dir = dirname(path);
  const entries = [obj.lead, ...(Array.isArray(obj.agents) ? obj.agents : [])];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const agent = entry as Record<string, unknown>;
    if (typeof agent.system_prompt_file === "string" && !isAbsolute(agent.system_prompt_file)) {
      agent.system_prompt_file = resolve(dir, agent.system_prompt_file);
    }
  }
  return { obj, path };
}

/** Template then run: the run replaces whole agents by id and owns the ask. */
function overlayRun(template: Record<string, unknown>, run: Record<string, unknown>): Record<string, unknown> {
  for (const key of TEMPLATE_OWNED) {
    if (run[key] !== undefined) {
      fail(`config.${key} belongs to the template: a run may override the ask and its budgets, not the template's identity`);
    }
  }

  const merged: Record<string, unknown> = { ...template };
  for (const [key, value] of Object.entries(run)) {
    if (key === "template") continue;
    if (key === "lead") {
      merged.lead = value; // whole-agent replacement, never a field merge
      continue;
    }
    if (key === "agents") {
      const base = Array.isArray(template.agents) ? [...(template.agents as unknown[])] : [];
      const overrides = Array.isArray(value) ? value : [];
      const overridden = new Map<string, unknown>();
      for (const entry of overrides) {
        const id = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined;
        if (typeof id === "string") overridden.set(id, entry);
      }
      const replaced = base.map((entry) => {
        const id = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined;
        return typeof id === "string" && overridden.has(id) ? overridden.get(id) : entry;
      });
      const known = new Set(
        base.map((entry) =>
          typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined,
        ),
      );
      const added = [...overridden].filter(([id]) => !known.has(id)).map(([, entry]) => entry);
      merged.agents = [...replaced, ...added];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export async function loadConfig(yamlPath: string, cwd = process.cwd()): Promise<LoadedConfig> {
  const sourcePath = resolve(cwd, yamlPath);
  const own = await readRoomFile(sourcePath, "config", true);

  let obj = own.obj;
  const templateRef = own.obj.template;
  if (templateRef !== undefined) {
    const templatePath = resolve(dirname(sourcePath), assertString(templateRef, "config.template"));
    // Read with the run key set so a nested `template:` reaches the check below,
    // where the error can name the real problem instead of "unknown key".
    const template = await readRoomFile(templatePath, "template", true);
    if (template.obj.template !== undefined) {
      fail(`a template cannot reference another template (${templatePath})`);
    }
    obj = overlayRun(template.obj, own.obj);
    // Collateral for a run sits beside the ask unless the run says otherwise.
    if (obj.room_dir === undefined) obj.room_dir = dirname(sourcePath);
  }

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

  const launchGuardRaw = obj.launch_guard;
  if (launchGuardRaw !== undefined && (typeof launchGuardRaw !== "string" || !LAUNCH_GUARDS.has(launchGuardRaw))) {
    fail(`config.launch_guard must be one of ${[...LAUNCH_GUARDS].join(", ")}`);
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
      ...(launchGuardRaw !== undefined ? { launch_guard: launchGuardRaw as "refuse" | "warn" | "off" } : {}),
      lead,
      agents,
    },
    sourcePath,
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}
