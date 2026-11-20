export interface ShutdownParts {
  shutdown: () => Promise<void>;
  flush: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Build the signal handler body: stop the room, flush telemetry, exit 0.
 * Runs once no matter how many signals arrive, and a failing room shutdown
 * still flushes the telemetry that was written before the signal.
 */
export function createShutdown({ shutdown, flush, exit }: ShutdownParts): () => Promise<void> {
  let started = false;
  return async (): Promise<void> => {
    if (started) return;
    started = true;
    try {
      await shutdown();
    } catch (error: unknown) {
      console.error("shutdown failed:", error instanceof Error ? error.message : String(error));
    }
    await flush();
    exit(0);
  };
}
