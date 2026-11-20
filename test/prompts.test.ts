import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRolePrompt, buildSocialContract, buildLeadPrompt } from "../src/prompts";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = {
  id: "lead",
  handle: "@lead",
  role: "Lead coordinator: decompose, assign, integrate. Never do specialist work.",
};

const dev1: AgentSpec = {
  id: "dev1",
  handle: "@dev1",
  role: "Implement features and tests.",
  system_prompt: "You write code and tests.",
};

function cfg(overrides?: {
  name?: string;
  dod?: string;
  lead?: AgentSpec;
  agents?: AgentSpec[];
}): LoadedConfig {
  const l = overrides?.lead ?? lead;
  const a = overrides?.agents ?? [dev1];
  const allAgents = [l, ...a];
  return {
    config: {
      name: overrides?.name ?? "tiny-factory",
      room_dir: "/r",
      ...(overrides?.dod !== undefined ? { definition_of_done: overrides.dod } : {}),
      max_hops: 12,
      turn_timeout_ms: 300_000,
      lead: l,
      agents: a,
    },
    sourcePath: "/r/team.yaml",
    allAgents,
    agentById: new Map(allAgents.map((x) => [x.id, x])),
  };
}

describe("buildSocialContract", () => {
  test("golden text with substitutions", () => {
    expect(buildSocialContract(dev1, cfg())).toBe(
      'You are @dev1 in the shared room "tiny-factory".\n' +
        "Every room message is shown to you as context.\n" +
        "- If a message mentions you (@dev1), respond from your lane: Implement features and tests..\n" +
        "- If a message mentions only other agents, read it and stay quiet — do not reply.\n" +
        "- If the lead addresses you directly, respond from your lane.\n" +
        "- You may mention other agents with @handle to hand off work.",
    );
  });
});

describe("buildLeadPrompt", () => {
  test("golden text with DoD", () => {
    expect(buildLeadPrompt(cfg({ dod: "A README plus one tested module." }))).toBe(
      "You are the lead coordinator. Decompose the task, assign work via @handle,\n" +
        "and integrate results. Do the specialist work yourself only as a last resort.\n" +
        "The definition of done is: A README plus one tested module.\n" +
        "When the definition of done is satisfied, end your reply with the line: DONE",
    );
  });

  test("absent DoD uses placeholder", () => {
    expect(buildLeadPrompt(cfg())).toContain("The definition of done is: (none specified)");
  });
});

describe("buildRolePrompt", () => {
  test("non-lead: role + inline system_prompt", async () => {
    expect(await buildRolePrompt(dev1, cfg())).toBe(
      "Implement features and tests.\n\nYou write code and tests.",
    );
  });

  test("non-lead without custom prompt: role only", async () => {
    const d: AgentSpec = { id: "dev2", handle: "@dev2", role: "Review changes." };
    expect(await buildRolePrompt(d, cfg({ agents: [d] }))).toBe("Review changes.");
  });

  test("lead: role + lead block", async () => {
    const result = await buildRolePrompt(lead, cfg({ lead, agents: [] }));
    expect(result).toBe(
      "Lead coordinator: decompose, assign, integrate. Never do specialist work.\n\n" +
        "You are the lead coordinator. Decompose the task, assign work via @handle,\n" +
        "and integrate results. Do the specialist work yourself only as a last resort.\n" +
        "The definition of done is: (none specified)\n" +
        "When the definition of done is satisfied, end your reply with the line: DONE",
    );
  });

  test("system_prompt_file content is read (non-lead)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-prompt-"));
    try {
      const file = join(dir, "dev.md");
      await writeFile(file, "You are a careful dev.", "utf8");
      const d: AgentSpec = { id: "dev2", handle: "@dev2", role: "Dev", system_prompt_file: file };
      expect(await buildRolePrompt(d, cfg({ agents: [d] }))).toBe(
        "Dev\n\nYou are a careful dev.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing system_prompt_file throws", async () => {
    const d: AgentSpec = {
      id: "dev2",
      handle: "@dev2",
      role: "Dev",
      system_prompt_file: "/nope/missing.md",
    };
    await expect(buildRolePrompt(d, cfg({ agents: [d] }))).rejects.toThrow(/system_prompt_file/);
  });
});
