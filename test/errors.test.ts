import { test, expect } from "bun:test";
import { errorMessage } from "../src/errors";

test("errorMessage reads anything thrown without reading undefined", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("plain")).toBe("plain");
  expect(errorMessage(42)).toBe("42");
  expect(errorMessage(null)).toBe("null");
  expect(errorMessage(undefined)).toBe("undefined");
  expect(errorMessage({ code: 42 })).toBe('{"code":42}');
});

test("errorMessage survives a value JSON cannot serialise", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(errorMessage(circular)).toBe("[object Object]");
});
