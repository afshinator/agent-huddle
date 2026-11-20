import type { LoadedConfig } from "./config";

/** Handle grammar: `@` plus word characters. Config validation uses it too. */
const HANDLE_CHARS = "[A-Za-z0-9_-]+";
export const HANDLE_RE = new RegExp(`^@${HANDLE_CHARS}$`);
const MENTION_RE = new RegExp(`@${HANDLE_CHARS}`, "g");
/** Tokens the router expands to the whole roster. */
export const BROADCAST_TOKENS = new Set(["@all", "@everyone"]);
/** Token the router resolves to the lead. */
export const LEAD_TOKEN = "@lead";
/** Intercepted before the handle map, so no agent may hold one (the lead keeps `@lead`). */
export const RESERVED_HANDLES = new Set([...BROADCAST_TOKENS, LEAD_TOKEN]);

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

  const unknownHandles: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[0];
    if (BROADCAST_TOKENS.has(token)) {
      for (const id of allIds) add(id);
      continue;
    }
    if (token === LEAD_TOKEN) {
      add(leadId);
      continue;
    }
    const id = handleToId.get(token);
    if (id !== undefined) add(id);
    else if (!BROADCAST_TOKENS.has(token) && !unknownHandles.includes(token)) unknownHandles.push(token);
  }

  return { targets, unknownHandles };
}

/** Routing entry point: explicit mentions, else nothing (§6.1/§6.4, D6). */
export function extractMentions(text: string, config: LoadedConfig): string[] {
  return resolveMentions(text, config).targets;
}
