import { defineConfig, devices } from "@playwright/test";

// Expects the web app (port 3000) and API (port 4000) to be running: `npm run dev` at the repo root.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  // One browser at a time: parallel browsers plus on-demand dev compiles starve each other.
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
