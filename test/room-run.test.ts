import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { prepareRun } from "../src/room-run";

/**
 * A run's collateral is the resolved config plus the prompts that actually ran, beside the
 * ask. Nothing else may be needed to reproduce a run after the template changes, and the
 * room's runtime files land in the same directory, which is gitignored.
 */
const TEMPLATE = `
name: docs-audit
max_hops: 16
launch_guard: refuse
lead:
  id: lead
  handle: "@lead"
  role: "Lead coordinator"
  system_prompt_file: prompts/lead.md
  provider: commandcode
  model: deepseek/deepseek-v4-pro
agents:
  - id: dev1
    handle: "@dev1"
    role: "Audit"
    system_prompt_file: prompts/dev.md
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
`;

async function scaffold(): Promise<{ root: string; template: string; runDir: string; runPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "ah-run-"));
  const templateDir = join(root, "templates", "docs-audit");
  await mkdir(join(templateDir, "prompts"), { recursive: true });
  await writeFile(join(templateDir, "template.yaml"), TEMPLATE, "utf8");
  await writeFile(join(templateDir, "prompts", "lead.md"), "you are the lead", "utf8");
  await writeFile(join(templateDir, "prompts", "dev.md"), "you audit docs", "utf8");

  const runDir = join(root, "target", "_run", "2026-11-20-audit");
  await mkdir(runDir, { recursive: true });
  const runPath = join(runDir, "run.yaml");
  await writeFile(runPath, `template: ${join(templateDir, "template.yaml")}\ntask: "audit the docs"\n`, "utf8");
  return { root, template: join(templateDir, "template.yaml"), runDir, runPath };
}

describe("prepareRun", () => {
  test("writes a resolved config and a snapshot of the prompts that ran", async () => {
    const { root, runDir, runPath } = await scaffold();
    try {
      const prepared = await prepareRun(runPath);

      expect(prepared.runDir).toBe(runDir);
      const resolved = await readFile(prepared.configPath, "utf8");
      expect(resolved).toContain("prompts/lead.md");
      expect(resolved).toContain("prompts/dev1.md");
      // the snapshot no longer mentions the template, so it cannot drift with it
      expect(resolved).not.toContain("template:");

      expect(await readFile(join(runDir, "prompts", "lead.md"), "utf8")).toBe("you are the lead");
      expect(await readFile(join(runDir, "prompts", "dev1.md"), "utf8")).toBe("you audit docs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the resolved config loads on its own and describes the same room", async () => {
    const { root, runDir, runPath } = await scaffold();
    try {
      const prepared = await prepareRun(runPath);
      const original = await loadConfig(runPath);
      const replay = await loadConfig(prepared.configPath);

      expect(replay.allAgents.map((a) => [a.id, a.model])).toEqual(
        original.allAgents.map((a) => [a.id, a.model]),
      );
      expect(replay.config.name).toBe("docs-audit");
      expect(replay.config.task).toBe("audit the docs");
      expect(replay.config.room_dir).toBe(runDir);
      expect(replay.agentById.get("lead")!.system_prompt_file).toBe(join(runDir, "prompts", "lead.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("every room setting survives the snapshot: nothing silently defaults", async () => {
    const { root, template, runDir, runPath } = await scaffold();
    try {
      // The template the room actually runs: the docs-audit one, with the settings that matter.
      const withSettings = (await readFile(template, "utf8")) +
        "task: \"\"\nturn_timeout_ms: 600000\nack_scope: anyone\ndispatch_scope: lead\n";
      await writeFile(template, withSettings, "utf8");

      const prepared = await prepareRun(runPath);
      const original = (await loadConfig(template)).config;
      const replay = (await loadConfig(prepared.configPath)).config;

      // A run that dropped `dispatch_scope` would silently route every mention, which is what
      // happened to the docs-audit room: the template said `lead`, the snapshot said nothing (#74).
      expect(replay.dispatch_scope).toBe(original.dispatch_scope);
      expect(replay.ack_scope).toBe(original.ack_scope);
      expect(replay.max_hops).toBe(original.max_hops);
      expect(replay.turn_timeout_ms).toBe(original.turn_timeout_ms);
      expect(replay.launch_guard).toBe(original.launch_guard);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("re-preparing keeps the notes a human wrote", async () => {
    const { root, runDir, runPath } = await scaffold();
    try {
      const notes = join(runDir, "notes.md");
      await writeFile(notes, "what I expect to see", "utf8");
      await prepareRun(runPath);
      await prepareRun(runPath);
      expect(await readFile(notes, "utf8")).toBe("what I expect to see");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the ask is copied beside the collateral when it lives elsewhere", async () => {
    const { root, runDir, runPath } = await scaffold();
    try {
      const elsewhere = join(root, "ask.yaml");
      await writeFile(
        elsewhere,
        `template: ${join(root, "templates", "docs-audit", "template.yaml")}\ntask: "from elsewhere"\n`,
        "utf8",
      );
      const prepared = await prepareRun(elsewhere, { outDir: runDir });
      expect(await readFile(join(runDir, "run.yaml"), "utf8")).toContain("from elsewhere");
      expect(prepared.configPath).toBe(join(runDir, "run.resolved.yaml"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
