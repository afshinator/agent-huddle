import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, ConfigError } from "../src/config";
import { HANDLE_RE, LEAD_TOKEN, RESERVED_HANDLES } from "../src/router";

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

  test("turn_timeout_ms is configurable and defaults above the real turnaround", async () => {
    await withConfig(`name: r\nturn_timeout_ms: 5000\n${LEAD}`, async (p, cwd) => {
      const { config } = await loadConfig(p, cwd);
      expect(config.turn_timeout_ms).toBe(5000);
    });
    await withConfig(`name: r\n${LEAD}`, async (p, cwd) => {
      const { config } = await loadConfig(p, cwd);
      expect(config.turn_timeout_ms).toBe(300_000);
    });
  });

  test("turn_timeout_ms rejects a non-positive value", async () => {
    await withConfig(`name: r\nturn_timeout_ms: 0\n${LEAD}`, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/positive integer/);
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

  test("ack_scope defaults to lead, and accepts anyone", async () => {
    await withConfig(`name: r\n${LEAD}`, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.config.ack_scope).toBe("lead");
    });
    await withConfig(`name: r\nack_scope: anyone\n${LEAD}`, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.config.ack_scope).toBe("anyone");
    });
  });

  test("dispatch_scope defaults to anyone, and accepts lead", async () => {
    await withConfig(`name: r\n${LEAD}`, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      // v1's rule stays the default: every mention dispatches (D18).
      expect(loaded.config.dispatch_scope).toBe("anyone");
    });
    await withConfig(`name: r\ndispatch_scope: lead\n${LEAD}`, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.config.dispatch_scope).toBe("lead");
    });
  });

  test("an unknown dispatch_scope fails load naming the field", async () => {
    await withConfig(`name: r\ndispatch_scope: peers\n${LEAD}`, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/config\.dispatch_scope must be one of/);
    });
  });

  test("an unknown ack_scope fails load naming the field", async () => {
    await withConfig(`name: r\nack_scope: nobody\n${LEAD}`, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/config\.ack_scope must be one of/);
    });
  });

  test("launch_guard accepts refuse, warn or off", async () => {
    for (const value of ["refuse", "warn", "off"]) {
      await withConfig(`name: r\nlaunch_guard: ${value}\n${LEAD}`, async (p, cwd) => {
        const loaded = await loadConfig(p, cwd);
        expect(loaded.config.launch_guard).toBe(value as "refuse" | "warn" | "off");
      });
    }
  });

  test("an unknown launch_guard fails load naming the field", async () => {
    await withConfig(`name: r\nlaunch_guard: ignore\n${LEAD}`, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/launch_guard/);
    });
  });

  test("pane_writable is optional and accepts a boolean", async () => {
    const yaml = `name: r
${LEAD}agents:
  - id: dev1
    handle: "@dev1"
    role: "dev"
    pane_writable: false
`;
    await withConfig(yaml, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.agentById.get("dev1")!.pane_writable).toBe(false);
    });
  });

  test("a non-boolean pane_writable fails load naming the field", async () => {
    const yaml = `name: r
${LEAD}agents:
  - id: dev1
    handle: "@dev1"
    role: "dev"
    pane_writable: "no"
`;
    await withConfig(yaml, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(/pane_writable/);
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
      await expect(loadConfig(p, cwd)).rejects.toThrow(
        'config.agents[0].handle must look like "@dev1" (got "dev1")',
      );
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

  test("reserved-handle error names the field that holds the offender", async () => {
    const leadOffender = `name: r\nlead:\n  id: lead\n  handle: "@all"\n  role: r\n`;
    await withConfig(leadOffender, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(
        'config.lead.handle is reserved by the router and would never reach this agent (got "@all")',
      );
    });

    const secondAgent = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "@dev1"\n    role: x\n  - id: dev2\n    handle: "@everyone"\n    role: x\n`;
    await withConfig(secondAgent, async (p, cwd) => {
      await expect(loadConfig(p, cwd)).rejects.toThrow(
        'config.agents[1].handle is reserved by the router and would never reach this agent (got "@everyone")',
      );
    });
  });

  test("config validation follows the router's grammar and reserved set", async () => {
    const ok = "@dev_1-x";
    expect(HANDLE_RE.test(ok)).toBe(true);
    const accepted = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "${ok}"\n    role: x\n`;
    await withConfig(accepted, async (p, cwd) => {
      const loaded = await loadConfig(p, cwd);
      expect(loaded.allAgents.map((a) => a.handle)).toContain(ok);
    });

    for (const token of RESERVED_HANDLES) {
      if (token === LEAD_TOKEN) continue; // the lead may keep @lead
      const yaml = `name: r\n${LEAD}\nagents:\n  - id: dev1\n    handle: "${token}"\n    role: x\n`;
      await withConfig(yaml, async (p, cwd) => {
        await expect(loadConfig(p, cwd)).rejects.toThrow(/is reserved by the router/);
      });
    }
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
