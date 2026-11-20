import { appendFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface Span {
  addEvent(name: string, attrs?: Record<string, unknown>): void;
  setStatus(code: "ok" | "error", description?: string): void;
}

export interface Telemetry {
  span<T>(name: string, attrs: Record<string, unknown>, fn: (s: Span) => T): T;
  log(level: "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>): void;
  counter(name: string, attrs?: Record<string, unknown>, inc?: number): void;
  histogram(name: string, value: number, attrs?: Record<string, unknown>): void;
  upDownCounter(name: string, attrs?: Record<string, unknown>, delta?: number): void;
}

interface ActiveSpan {
  trace_id: string;
  span_id: string;
}

interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

class JsonlSpan implements Span {
  events: SpanEvent[] = [];
  status: { code: "ok" | "error"; description?: string } | null = null;

  addEvent(name: string, attrs?: Record<string, unknown>): void {
    this.events.push({ name, timestamp: new Date().toISOString(), attributes: attrs });
  }

  setStatus(code: "ok" | "error", description?: string): void {
    this.status = { code, ...(description !== undefined ? { description } : {}) };
  }
}

class NoopSpan implements Span {
  addEvent(): void {}
  setStatus(): void {}
}

export class NoopTelemetry implements Telemetry {
  span<T>(_name: string, _attrs: Record<string, unknown>, fn: (s: Span) => T): T {
    return fn(new NoopSpan());
  }
  log(_level: "info" | "warn" | "error", _msg: string, _attrs?: Record<string, unknown>): void {}
  counter(_name: string, _attrs?: Record<string, unknown>, _inc?: number): void {}
  histogram(_name: string, _value: number, _attrs?: Record<string, unknown>): void {}
  upDownCounter(_name: string, _attrs?: Record<string, unknown>, _delta?: number): void {}
}

export class JsonlTelemetry implements Telemetry {
  private readonly stack: ActiveSpan[] = [];
  private pending: Promise<void> = Promise.resolve();
  private ensuredDir = false;
  private writeErrorReported = false;

  constructor(private readonly logPath: string) {}

  span<T>(name: string, attrs: Record<string, unknown>, fn: (s: Span) => T): T {
    const parent = this.stack[this.stack.length - 1] ?? null;
    const trace_id = parent ? parent.trace_id : randomBytes(16).toString("hex");
    const span_id = randomBytes(8).toString("hex");
    const start_time = new Date().toISOString();
    const js = new JsonlSpan();
    const entry: ActiveSpan = { trace_id, span_id };

    const finish = (): void => {
      const at = this.stack.lastIndexOf(entry);
      if (at >= 0) this.stack.splice(at, 1);
      this.emit({
        kind: "span",
        name,
        trace_id,
        span_id,
        parent_id: parent ? parent.span_id : null,
        start_time,
        end_time: new Date().toISOString(),
        attributes: attrs,
        events: js.events,
        status: js.status ?? { code: "ok" },
      });
    };

    this.stack.push(entry);
    let result: T;
    try {
      result = fn(js);
    } catch (e) {
      if (js.status === null) js.status = { code: "error", description: (e as Error).message };
      finish();
      throw e;
    }

    // An async fn keeps the span open until it settles.
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finish();
          return value as T;
        },
        (e) => {
          if (js.status === null) js.status = { code: "error", description: String(e) };
          finish();
          throw e;
        },
      ) as unknown as T;
    }

    finish();
    return result;
  }

  log(level: "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>): void {
    const cur = this.stack[this.stack.length - 1] ?? null;
    this.emit({
      kind: "log",
      trace_id: cur ? cur.trace_id : null,
      span_id: cur ? cur.span_id : null,
      timestamp: new Date().toISOString(),
      level,
      message: msg,
      attributes: attrs ?? {},
    });
  }

  counter(name: string, attrs?: Record<string, unknown>, inc = 1): void {
    this.metric("counter", name, inc, attrs);
  }

  histogram(name: string, value: number, attrs?: Record<string, unknown>): void {
    this.metric("histogram", name, value, attrs);
  }

  upDownCounter(name: string, attrs?: Record<string, unknown>, delta = 1): void {
    this.metric("up_down_counter", name, delta, attrs);
  }

  private metric(kind: string, name: string, value: number, attrs?: Record<string, unknown>): void {
    const cur = this.stack[this.stack.length - 1] ?? null;
    this.emit({ kind: "metric", instrument: kind, name, trace_id: cur ? cur.trace_id : null, span_id: cur ? cur.span_id : null, timestamp: new Date().toISOString(), value, attributes: attrs ?? {} });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private emit(record: unknown): void {
    const line = JSON.stringify(record) + "\n";
    // The catch keeps the chain alive: one failed write must not drop every
    // later record, and flush() must never reject (shutdown awaits it).
    this.pending = this.pending
      .then(async () => {
        if (!this.ensuredDir) {
          await mkdir(dirname(this.logPath), { recursive: true });
          this.ensuredDir = true;
        }
        await appendFile(this.logPath, line, "utf8");
      })
      .catch((e: unknown) => {
        if (this.writeErrorReported) return;
        this.writeErrorReported = true;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[telemetry] write failed, records are being dropped: ${msg}\n`);
      });
  }
}
