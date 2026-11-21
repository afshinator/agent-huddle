/**
 * A run's collateral, prepared before a room boots.
 *
 * A template owns the agents, models and prompts; a run owns the ask. What makes a run
 * reproducible afterwards is one directory beside the ask holding the fully resolved
 * config and a copy of the prompt files that ran — with the template reference removed, so
 * editing the template later cannot change what a past run says it was.
 *
 * That directory is gitignored: the run's output belongs on a branch, its collateral
 * belongs to the machine that ran it.
 */
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type AgentSpec, type RoomConfig } from "./config";

export interface PreparedRun {
  runDir: string;
  configPath: string;
  promptFiles: string[];
}

/** One agent as the resolved file records it: prompt paths point at the snapshot. */
function agentForSnapshot(agent: AgentSpec, snapshotName: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { id: agent.id, handle: agent.handle, role: agent.role };
  if (snapshotName !== null) out.system_prompt_file = snapshotName;
  if (agent.system_prompt !== undefined) out.system_prompt = agent.system_prompt;
  for (const key of ["provider", "model", "thinking", "tools", "pane_writable"] as const) {
    if (agent[key] !== undefined) out[key] = agent[key];
  }
  return out;
}

function roomForSnapshot(config: RoomConfig, roomDir: string, prompts: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: config.name,
    room_dir: roomDir,
  };
  for (const key of ["task", "definition_of_done"] as const) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  out.max_hops = config.max_hops;
  out.turn_timeout_ms = config.turn_timeout_ms;
  if (config.launch_guard !== undefined) out.launch_guard = config.launch_guard;
  out.lead = agentForSnapshot(config.lead, prompts.get(config.lead.id) ?? null);
  out.agents = config.agents.map((agent) => agentForSnapshot(agent, prompts.get(agent.id) ?? null));
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `run.resolved.yaml`, a `prompts/` snapshot, a copy of the ask and an empty
 * `notes.md` into the run's directory. Idempotent: a second call overwrites the snapshot
 * and leaves `notes.md` alone.
 */
export async function prepareRun(runPath: string, opts: { outDir?: string } = {}): Promise<PreparedRun> {
  const loaded = await loadConfig(runPath);
  const runDir = resolve(opts.outDir ?? loaded.config.room_dir);
  const promptsDir = join(runDir, "prompts");
  await mkdir(promptsDir, { recursive: true });

  const promptNames = new Map<string, string>();
  const promptFiles: string[] = [];
  for (const agent of loaded.allAgents) {
    if (agent.system_prompt_file === undefined) continue;
    const name = `prompts/${agent.id}.md`;
    await copyFile(agent.system_prompt_file, join(runDir, name));
    promptNames.set(agent.id, name);
    promptFiles.push(join(runDir, name));
  }

  const snapshot = roomForSnapshot(loaded.config, runDir, promptNames);
  const configPath = join(runDir, "run.resolved.yaml");
  await writeFile(configPath, stringify(snapshot), "utf8");

  const askCopy = join(runDir, "run.yaml");
  if (resolve(runPath) !== askCopy) await copyFile(runPath, askCopy);

  const notes = join(runDir, "notes.md");
  if (!(await exists(notes))) {
    await writeFile(
      notes,
      `# Run ${basename(runDir)}\n\nWhat was asked, what to look for, what happened.\n\n` +
        `Resolved config: \`${relative(runDir, configPath)}\` · prompts: \`prompts/\`\n`,
      "utf8",
    );
  }

  return { runDir, configPath, promptFiles };
}

if (import.meta.path === Bun.main) {
  const [command, runPath] = process.argv.slice(2);
  if (command !== "prepare" || !runPath || (runPath ?? "").startsWith("--")) {
    console.error("usage: bun src/room-run.ts prepare <run.yaml> [--out <dir>]");
    process.exit(2);
  }
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  const prepared = await prepareRun(runPath, outDir ? { outDir } : {});
  const resolvedText = await readFile(prepared.configPath, "utf8");
  if (!resolvedText.includes("room_dir")) {
    console.error("prepare: resolved config has no room_dir");
    process.exit(1);
  }
  // One line on stdout: the path the launcher hands to the coordinator.
  console.log(prepared.configPath);
}
