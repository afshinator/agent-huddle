import type { LoadedConfig } from "./config";

/** Handle grammar: `@` plus word characters. Config validation uses it too. */
const HANDLE_CHARS = "[A-Za-z0-9_-]+";
export const HANDLE_RE = new RegExp(`^@${HANDLE_CHARS}$`);
// A mention is `@handle` on its own: not the tail of an email (`dev1@example.com`) and not the head
// of a scoped package (`@testing-library/react`, `@types/node`), which the handle grammar would
// otherwise take for an agent and report as unknown (#79).
const MENTION_RE = new RegExp(`(?<![A-Za-z0-9_.-])@${HANDLE_CHARS}`, "g");
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

/**
 * The text with fenced blocks and inline code spans blanked to spaces, keeping every offset, so an
 * `@` inside code is not read as a handle. A lone backtick is not a span; only a closed pair is.
 */
function proseOnly(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return " ".repeat(line.length);
      }
      if (marker !== undefined) {
        fence = marker;
        return " ".repeat(line.length);
      }
      return line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
    })
    .join("\n");
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
  // A mention is reported as unknown only when it sits in prose, not inside code; targets still read
  // the raw text, so a backticked `@dev1` dispatches.
  const prose = new Set([...proseOnly(text).matchAll(MENTION_RE)].map((m) => m.index));
  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[0];
    // `@testing-library/react` stops at the slash; the rest of the path is what makes it a package
    // rather than an agent, and a lookahead here backtracks into `@testing-librar` (#79).
    if (text[m.index + token.length] === "/") continue;
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
    else if (prose.has(m.index) && !unknownHandles.includes(token)) unknownHandles.push(token);
  }

  return { targets, unknownHandles };
}

/** True when the text carries a broadcast token (`@all` / `@everyone`), whatever the roster size. */
export function mentionsBroadcast(text: string): boolean {
  for (const m of text.matchAll(MENTION_RE)) {
    if (BROADCAST_TOKENS.has(m[0])) return true;
  }
  return false;
}

/** Routing entry point: explicit mentions, else nothing (§6.1/§6.4, D6). */
export function extractMentions(text: string, config: LoadedConfig): string[] {
  return resolveMentions(text, config).targets;
}
