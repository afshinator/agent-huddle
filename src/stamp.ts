/**
 * The time a line was said, to the second, in the reader's local time.
 *
 * A room can have several agents talking at once, and a transcript without times leaves the order to be
 * inferred — which is how a reply that answered a superseded message read as the lead ignoring a verdict
 * (T17). One helper, so every place that prints a message prints the same clock.
 */
export function stampOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--:--";
  return at.toTimeString().slice(0, 8);
}

/** The stamp for something happening now. */
export function stampNow(): string {
  return stampOf(new Date().toISOString());
}
