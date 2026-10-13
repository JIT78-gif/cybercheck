import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    // Benchmark projects for the Testing check are inputs, not tests of this API.
    exclude: ["**/node_modules/**", "test/testing-bench/**", "test/testing-holdout/**"],
  },
});
