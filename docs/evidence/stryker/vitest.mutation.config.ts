import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "bun:test": "vitest" } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000 },
});
