import { shellWord } from "./shell";

/**
 * The script a pane runs (D7, §9.2).
 *
 * A pane cannot tail a file and read a keyboard at once, so a writable pane runs
 * the tail in the background and a reader in the foreground. The order matters: a
 * POSIX background job gets its stdin from /dev/null, so a backgrounded reader never
 * sees a keystroke — measured, not assumed.
 *
 * A read-only pane runs the tail alone behind a banner: without it, typing looks
 * accepted and is silently dropped.
 *
 * The script goes to a file and the pane runs `sh <file>`. `herdr pane run` types its
 * arguments into the pane shell one word per argument, so an inline `sh -c '...'`
 * loses its quoting and the pane runs garbage — measured, not assumed.
 */
export function paneScript(opts: { stream: string; inbox: string | null }): string {
  const tail = `exec tail -f ${shellWord(opts.stream)}`;
  if (opts.inbox === null) {
    return `printf '%s\\n' 'read-only - type in the chat pane'\n${tail}\n`;
  }
  const follower = `tail -f ${shellWord(opts.stream)} &`;
  const reader = `while IFS= read -r line; do printf '%s\\n' "$line" >> ${shellWord(opts.inbox)}; done`;
  return `${follower}\n${reader}\n`;
}
