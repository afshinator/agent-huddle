/**
 * Failure text for anything thrown. `Error` → its message; a plain object → its
 * JSON (so `{ code: 42 }` reads as something); anything else → `String(value)`.
 * Never throws: it runs inside catch blocks whose only job is to report.
 */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
