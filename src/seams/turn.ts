/**
 * What a turn means, written once for both `PiAgentClient` implementations.
 *
 * The fake used to re-derive these rules and `test/client-parity.test.ts` existed to notice when the
 * copies drifted — which is the seam admitting it had two definitions of a turn. A rule that lives here
 * cannot drift: a client that skips it fails a test that names it, instead of agreeing with the other
 * copy's mistake (#88).
 */
import type { SettledResult } from "./pi-agent-client";

export type StreamingBehavior = "followUp" | "steer";

/** A steer feeds the turn already in flight: it must neither replace that turn's settle nor start one (§T16). */
export function steersInFlight(behavior: StreamingBehavior | undefined, hasPendingSettle: boolean): boolean {
  return behavior === "steer" && hasPendingSettle;
}

/**
 * Wait for a turn's settle under the turn's own budget.
 *
 * The budget and the wording live together because a caller that shared one and not the other is the
 * divergence this module exists to remove: the message reaches a room notice, so both clients must say
 * the same thing.
 */
export async function awaitSettle(settle: Promise<SettledResult>, timeoutMs: number): Promise<SettledResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<SettledResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`settle timeout after ${timeoutMs}ms`)), timeoutMs);
      settle.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** What a caller sees when the process ends mid-turn. */
export function childExitedMessage(agentId: string): string {
  return `pi process for ${agentId} exited before settling`;
}

/**
 * The result of a settled turn.
 *
 * The only place the optional verdict fields are added, so both clients omit an absent one rather than
 * one of them spreading `undefined` and the other leaving the key out (#81, #88).
 */
export function settledResult(parts: {
  aborted: boolean;
  lastText: string | null;
  stopReason?: string;
  errorMessage?: string;
}): SettledResult {
  return {
    aborted: parts.aborted,
    lastText: parts.lastText,
    ...(parts.stopReason === undefined ? {} : { stopReason: parts.stopReason }),
    ...(parts.errorMessage === undefined ? {} : { errorMessage: parts.errorMessage }),
  };
}
