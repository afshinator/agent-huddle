#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { join } from "node:path";
import { loadConfig } from "./config";
import { RoomStore } from "./store";
import { JsonlTelemetry } from "./telemetry";
import { RealPiAgentClient } from "./real/pi-agent-client-real";
import { HerdrPaneManagerReal } from "./real/herdr-pane-manager-real";
import { Coordinator } from "./coordinator";
import { createShutdown } from "./shutdown";
import { LaunchGuardError } from "./launch-guard";

async function main(): Promise<void> {
  const yamlPath = process.argv[2];
  if (!yamlPath) {
    console.error("usage: bun src/index.ts <config.yaml>");
    process.exit(2);
  }

  const config = await loadConfig(yamlPath);
  const store = new RoomStore(config.config.room_dir);
  const telemetry = new JsonlTelemetry(join(config.config.room_dir, "telemetry.jsonl"));
  const pi = new RealPiAgentClient({ roomDir: config.config.room_dir });
  const panes = process.env.HERDR_ENV === "1" ? new HerdrPaneManagerReal({ cwd: process.cwd() }) : null;
  const coordinator = new Coordinator({ config, store, pi, telemetry, panes });

  const shutdown = createShutdown({
    shutdown: () => coordinator.shutdown(),
    flush: () => telemetry.flush(),
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await coordinator.boot();

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") continue;
    await coordinator.submit(text);
  }
  await shutdown();
}

main().catch((e) => {
  // A guard refusal is a decision, not a crash: one line, no stack trace.
  console.error(e instanceof LaunchGuardError ? e.message : e);
  process.exit(1);
});
