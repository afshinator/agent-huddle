import type { LoadedConfig } from "./config";

const MENTION_RE = /@[A-Za-z0-9_-]+/g;
const BROADCAST_TOKENS = new Set(["@all", "@everyone"]);

/**
 * Extract explicit `@mentions` as ordered, deduplicated agent ids.
 * Returns `[]` when the text mentions nobody (no lead fallback).
 *
 * - `@handle` → that agent's id (first-occurrence order).
 * - `@lead` (or the lead's handle) → lead id.
 * - `@all` / `@everyone` → every agent (lead + specialists).
 * - unknown `@handle` → skipped (never throws).
 */
export interface MentionResolution {
  targets: string[];
  unknownHandles: string[];
  hadMention: boolean;
}

export function resolveMentions(text: string, config: LoadedConfig): MentionResolution {
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
  const unknownHandles: string[] = [];
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
    else if (!BROADCAST_TOKENS.has(token) && !unknownHandles.includes(token)) unknownHandles.push(token);
  }

  return { targets, unknownHandles, hadMention: found };
}

export function extractMentions(text: string, config: LoadedConfig): string[] {
  return resolveMentions(text, config).targets;
}

/** Routing entry point: explicit mentions, else the lead (§6.1/§6.4). */
export function resolveTargets(text: string, config: LoadedConfig): string[] {
  const resolution = resolveMentions(text, config);
  return resolution.hadMention ? resolution.targets : [config.config.lead.id];
}
