import type { Span, Telemetry } from "../src/telemetry";

/** Records what the code under test emits, so tests can assert on observability. */
export class RecordingTelemetry implements Telemetry {
  readonly chainDeltas: number[] = [];
  readonly errors: string[] = [];
  readonly warns: Array<{ msg: string; attrs?: Record<string, unknown> }> = [];

  span<T>(_name: string, _attrs: Record<string, unknown>, fn: (s: Span) => T): T {
    return fn({ addEvent() {}, setStatus() {} });
  }

  log(level: "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>): void {
    if (level === "warn") this.warns.push({ msg, attrs });
    if (level === "error") this.errors.push(msg);
  }

  counter(): void {}
  histogram(): void {}

  upDownCounter(name: string, _attrs?: Record<string, unknown>, delta = 1): void {
    if (name === "room.active_chains") this.chainDeltas.push(delta);
  }
}
