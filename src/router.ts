import type { LoadedConfig } from "./config";

const MENTION_RE = /@[A-Za-z0-9_-]+/g;
const BROADCAST_TOKENS = new Set(["@all", "@everyone"]);

/**
 * Resolve a room message's `@mentions` into ordered, deduplicated agent ids.
 *
 * - `@handle` → that agent's id (first-occurrence order).
 * - `@lead` (or the lead's handle) → lead id.
 * - `@all` / `@everyone` → every agent (lead + specialists).
 * - no mention → `[leadId]`.
 * - unknown `@handle` → skipped (never throws). If every mention is unknown,
 *   the message falls back to the lead rather than being silently dropped.
 */
export function resolveTargets(text: string, config: LoadedConfig): string[] {
  const handleToId = new Map<string, string>();
  for (const a of config.allAgents) handleToId.set(a.handle, a.id);

  const leadId = config.config.lead.id;
  const allIds = config.allAgents.map((a) => a.id);

  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(id);
    }
  };

  let found = false;
  for (const m of text.matchAll(MENTION_RE)) {
    found = true;
    const token = m[0];
    if (BROADCAST_TOKENS.has(token)) {
      for (const id of allIds) add(id);
      continue;
    }
    if (token === "@lead") {
      add(leadId);
      continue;
    }
    const id = handleToId.get(token);
    if (id !== undefined) add(id);
    // unknown @handle: skip
  }

  if (!found || targets.length === 0) return [leadId];
  return targets;
}
