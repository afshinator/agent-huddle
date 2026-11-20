/**
 * Wrap a value as one POSIX shell word.
 *
 * The whole rule, in one place: everything a shell would interpret is inert inside
 * single quotes, and a literal `'` is written `'\''` (close, escaped quote, reopen).
 * A newline or a `$` therefore stays literal, which is what `pushContext`'s
 * `echo <word>` depends on when it forwards a multi-line room message.
 */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
