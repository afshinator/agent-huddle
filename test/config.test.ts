import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, ConfigError } from "../src/config";

const LEAD = `
lead:
  id: lead
  handle: "@lead"
  role: "Lead coordinator"
  provider: commandcode
  model: deepseek/deepseek-v4-pro
`;

async function withConfig(
  yaml: string,
  fn: (path: string, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-huddle-"));
  try {
    const p = join(cwd, "team.yaml");
    await writeFile(p, yaml, "utf8");
    await fn(p, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  test("loads a valid config and applies defaults", async () => {
    await withConfig(`name: tiny-factory\nmax_hops: 7\n${LEAD}`, async (p, cwd) => {
      const { config, allAgents, agentById } = await loadConfig(p, cwd);
      expect(config.name).toBe("tiny-factory");
      expect(config.max_hops).toBe(7);
      expect(config.room_dir).toBe(resolve(cwd, "rooms/tiny-factory"));
      expect(config.lead.id).toBe("lead");
      expect(allAgents.map((a) => a.id)).toEqual(["lead"]);
      expect(agentById.get("lead")!.handle).toBe("@lead");
    });
  });

  test("max_hops defaults to 12", async () => {
    await withConfig(`name: r\n${LEAD}`, async (p, cwd) => {
      const { config } = await loadConfig(p, cwd);
      expect(config.max_hops).toBe(12);
    });
  });

  test("explicit room_dir resolves absolute", async () => {
    await withConfig(`name: r\nroom_dir: ./custom\n${LEAD}`, async (p, cwd) => {
      const { config } = await loadConfig(p, cwd);
      expect(config.room_dir).toBe(resolve(cwd, "custom"));
    });
  });

  test("missing system_prompt_file is rejected during load", async () => {
    const yaml = `name: r\nlead:\n  id: lead\n  handle: "@lead"\n  role: r\n  system_prompt_file: prompts/missing.md\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/system_prompt_file is not readable/);
      await expect(loadConfig(p, cwd)).rejects.toThrow(resolve(cwd, "prompts/missing.md"));
    });
  });

  test("system_prompt_file resolves relative to the YAML file", async () => {
    const yaml = `name: r\nlead:\n  id: lead\n  handle: "@lead"\n  role: r\n  system_prompt_file: prompts/lead.md\n`;
    await withConfig(yaml, async (p, cwd) => {
      await mkdir(join(cwd, "prompts"), { recursive: true });
      await writeFile(join(cwd, "prompts", "lead.md"), "lead", "utf8");
      const { config } = await loadConfig(p, cwd);
      expect(config.lead.system_prompt_file).toBe(resolve(cwd, "prompts/lead.md"));
    });
  });

  test("agents list appends to allAgents", async () => {
    const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "@dev1"\n    role: dev\n`;
    await withConfig(yaml, async (p, cwd) => {
      const { allAgents, agentById } = await loadConfig(p, cwd);
      expect(allAgents.map((a) => a.id)).toEqual(["lead", "dev1"]);
      expect(agentById.has("dev1")).toBe(true);
    });
  });

  test("rejects unknown room key", async () => {
    await withConfig(`name: r\nbogus: 1\n${LEAD}`, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(ConfigError);
      await expect(loadConfig(p, cwd)).rejects.toThrow(/unknown key "bogus"/);
    });
  });

  test("rejects unknown agent key", async () => {
    const yaml = `name: r\nlead:\n  id: lead\n  handle: "@lead"\n  role: r\n  bogus: x\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/unknown key "bogus"/);
    });
  });

  test("rejects system_prompt + system_prompt_file together", async () => {
    const yaml = `name: r\nlead:\n  id: lead\n  handle: "@lead"\n  role: r\n  system_prompt: a\n  system_prompt_file: b.md\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/mutually exclusive/);
    });
  });

  test("rejects duplicate agent ids", async () => {
    const yaml = `name: r\n${LEAD}\nagents:\n  - id: lead\n    handle: "@other"\n    role: x\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/duplicate agent id "lead"/);
    });
  });

  test("rejects duplicate handles", async () => {
    const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "@lead"\n    role: x\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/duplicate agent handle/);
    });
  });

  test("rejects a handle without @", async () => {
    const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: dev1\n    role: x\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/handle must look like/);
    });
  });

  test("rejects a handle the router could never match", async () => {
    for (const handle of ['"@dev 1"', '"@dev.1"', '"@@dev"', '"@"']) {
      const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: ${handle}\n    role: x\n`;
      await withConfig(yaml, async (p, cwd) => {
        await expect(loadConfig(p, cwd)).rejects.toThrow(/handle must look like/);
      });
    }
  });

  test("rejects reserved broadcast handles", async () => {
    for (const handle of ['"@all"', '"@everyone"']) {
      const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: ${handle}\n    role: x\n`;
      await withConfig(yaml, async (p, cwd) => {
        await expect(loadConfig(p, cwd)).rejects.toThrow(/reserved/);
      });
    }
  });

  test("rejects @lead on a specialist but allows it on the lead", async () => {
    const otherLead = `lead:\n  id: lead\n  handle: "@coordinator"\n  role: r\n`;
    const reserved = `name: r\n${otherLead}\nagents:\n  - id: dev1\n    handle: "@lead"\n    role: x\n`;
    await withConfig(reserved, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/reserved/);
    });

    await withConfig(`name: r\n${LEAD}`, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.config.lead.handle).toBe("@lead");
    });
  });

  test("accepts handles the router can match", async () => {
    const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "@dev_1-x"\n    role: x\n`;
    await withConfig(yaml, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.allAgents.map((a) => a.handle)).toEqual(["@lead", "@dev_1-x"]);
    });
  });

  test("rejects invalid thinking level", async () => {
    const yaml = `name: r\nlead:\n  id: lead\n  handle: "@lead"\n  role: r\n  thinking: banana\n`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/thinking/);
    });
  });

  test("rejects non-integer max_hops", async () => {
    const yaml = `name: r\nmax_hops: 0\n${LEAD}`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/max_hops/);
    });
  });
});
