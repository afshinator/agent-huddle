#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { join } from "node:path";
import { loadConfig } from "./config";
import { RoomStore } from "./store";
import { JsonlTelemetry } from "./telemetry";
import { RealPiAgentClient } from "./real/pi-agent-client-real";
import { HerdrPaneManagerReal } from "./real/herdr-pane-manager-real";
import { Coordinator } from "./coordinator";

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

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await coordinator.shutdown();
    await telemetry.flush();
    process.exit(0);
  };
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
  console.error(e);
  process.exit(1);
});
