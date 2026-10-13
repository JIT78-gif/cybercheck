import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Queue tests exercise real timers and slow task chains.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
