import type { LoadedConfig } from "./config";
import type { TurnLoop } from "./turn-loop";

/**
 * Post the startup task (if configured) and kick off its chain (D2).
 *
 * Returns the chain result, or `null` when no `task` is configured — the room
 * starts idle and waits for the first human message (the coordinator owns the
 * same `TurnLoop` and calls `submit(text, "user")` on that input).
 */
export async function startRoom(
  config: LoadedConfig,
  loop: TurnLoop,
): Promise<Awaited<ReturnType<TurnLoop["submit"]>> | null> {
  if (config.config.task === undefined) return null;
  return loop.submit(config.config.task, "startup_task");
}
