import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, ConfigError } from "../src/config";

/**
 * A run is a small file that names a template and carries only what is specific to that
 * run: the ask, its definition of done, and any budget it wants to change. The template
 * owns the agents, their models, tools and prompts, so a run never repeats them — which is
 * the whole point of the split (retro 2026-11-20, layout redesign).
 */
const TEMPLATE = `
name: docs-audit
max_hops: 16
launch_guard: refuse
definition_of_done: "template default DoD"
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
    role: "Audit the docs"
    system_prompt_file: prompts/dev.md
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
  - id: reviewer
    handle: "@reviewer"
    role: "Review"
    system_prompt_file: prompts/reviewer.md
    provider: commandcode
    model: gpt-5.6-luna
`;

async function scaffold(): Promise<{ root: string; template: string; runDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ah-template-"));
  const templateDir = join(root, "templates", "docs-audit");
  await mkdir(join(templateDir, "prompts"), { recursive: true });
  await writeFile(join(templateDir, "template.yaml"), TEMPLATE, "utf8");
  for (const name of ["lead", "dev", "reviewer"]) {
    await writeFile(join(templateDir, "prompts", `${name}.md`), `prompt ${name}`, "utf8");
  }
  const runDir = join(root, "target", "_run", "2026-11-20-audit");
  await mkdir(runDir, { recursive: true });
  return { root, template: join(templateDir, "template.yaml"), runDir };
}

async function withRun(
  runYaml: (paths: { root: string; template: string; runDir: string }) => string,
  fn: (paths: { root: string; template: string; runDir: string }, runPath: string) => Promise<void>,
): Promise<void> {
  const paths = await scaffold();
  try {
    const runPath = join(paths.runDir, "run.yaml");
    await writeFile(runPath, runYaml(paths), "utf8");
    await fn(paths, runPath);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
}

describe("template overlay", () => {
  test("the run supplies the ask, the template supplies the agents", async () => {
    await withRun(
      ({ template }) => `
template: ${template}
task: "Audit the docs against the code"
definition_of_done: "docs/DOCS-AUDIT.md exists"
max_hops: 20
`,
      async ({ runDir }, runPath) => {
        const { config, allAgents } = await loadConfig(runPath);
        expect(config.name).toBe("docs-audit");
        expect(config.task).toBe("Audit the docs against the code");
        expect(config.definition_of_done).toBe("docs/DOCS-AUDIT.md exists");
        expect(config.max_hops).toBe(20);
        expect(config.launch_guard).toBe("refuse");
        expect(allAgents.map((a) => a.id)).toEqual(["lead", "dev1", "reviewer"]);
        expect(config.lead.model).toBe("deepseek/deepseek-v4-pro");
        // collateral sits beside the ask unless the run says otherwise
        expect(config.room_dir).toBe(runDir);
      },
    );
  });

  test("a prompt path resolves against the file that declared it", async () => {
    await withRun(
      ({ template, runDir }) => `
template: ${template}
task: "ask"
agents:
  - id: dev1
    handle: "@dev1"
    role: "Replaced dev"
    system_prompt: "inline prompt"
    model: z-ai/glm-5.3-flash
`,
      async ({ root }, runPath) => {
        const { agentById } = await loadConfig(runPath);
        expect(agentById.get("lead")!.system_prompt_file).toBe(
          join(root, "templates", "docs-audit", "prompts", "lead.md"),
        );
        expect(agentById.get("dev1")!.system_prompt).toBe("inline prompt");
        expect(agentById.get("dev1")!.system_prompt_file).toBeUndefined();
      },
    );
  });

  test("an agent of the same id is replaced whole, not field by field", async () => {
    await withRun(
      ({ template }) => `
template: ${template}
task: "ask"
agents:
  - id: dev1
    handle: "@dev1"
    role: "Replaced dev"
    provider: commandcode
    model: z-ai/glm-5.3-flash
`,
      async (_paths, runPath) => {
        const { agentById, allAgents } = await loadConfig(runPath);
        const dev1 = agentById.get("dev1")!;
        expect(dev1.model).toBe("z-ai/glm-5.3-flash");
        // the template's prompt and tools are gone with the entry it replaced
        expect(dev1.system_prompt_file).toBeUndefined();
        expect(dev1.tools).toBeUndefined();
        // untouched agents keep theirs
        expect(agentById.get("reviewer")!.system_prompt_file).toBeDefined();
        expect(allAgents.map((a) => a.id)).toEqual(["lead", "dev1", "reviewer"]);
      },
    );
  });

  test("a run may add an agent the template does not have", async () => {
    await withRun(
      ({ template }) => `
template: ${template}
task: "ask"
agents:
  - id: extra
    handle: "@extra"
    role: "Extra hands"
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
`,
      async (_paths, runPath) => {
        const { allAgents } = await loadConfig(runPath);
        expect(allAgents.map((a) => a.id)).toEqual(["lead", "dev1", "reviewer", "extra"]);
      },
    );
  });

  test("a run may not rename the room", async () => {
    await withRun(
      ({ template }) => `
template: ${template}
name: something-else
task: "ask"
`,
      async (_paths, runPath) => {
        const error = await loadConfig(runPath).catch((e: Error) => e);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain("template");
        expect((error as Error).message).toContain("name");
      },
    );
  });

  test("a missing template fails naming the path", async () => {
    await withRun(
      ({ runDir }) => `
template: ${join(runDir, "nope.yaml")}
task: "ask"
`,
      async (_paths, runPath) => {
        const error = await loadConfig(runPath).catch((e: Error) => e);
        expect((error as Error).message).toContain("cannot read template");
        expect((error as Error).message).toContain("nope.yaml");
      },
    );
  });

  test("a template cannot reference another template", async () => {
    await withRun(
      ({ template, root }) => `
template: ${template}
task: "ask"
`,
      async ({ template }, runPath) => {
        await writeFile(template, `${TEMPLATE}\ntemplate: /elsewhere/base.yaml\n`, "utf8");
        const error = await loadConfig(runPath).catch((e: Error) => e);
        expect((error as Error).message).toContain("cannot reference another template");
      },
    );
  });

  test("a run still rejects an unknown key, so a typo is not silently ignored", async () => {
    await withRun(
      ({ template }) => `
template: ${template}
task: "ask"
max_hosp: 20
`,
      async (_paths, runPath) => {
        const error = await loadConfig(runPath).catch((e: Error) => e);
        expect((error as Error).message).toContain('unknown key "max_hosp"');
      },
    );
  });

  test("a plain config with no template keeps its defaults and a relative room_dir", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ah-plain-"));
    try {
      const p = join(cwd, "room.yaml");
      await writeFile(
        p,
        `name: plain
lead:
  id: lead
  handle: "@lead"
  role: "Lead"
`,
        "utf8",
      );
      const { config } = await loadConfig(p, cwd);
      expect(config.room_dir).toBe(resolve(cwd, "rooms/plain"));
      expect(config.max_hops).toBe(12);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
