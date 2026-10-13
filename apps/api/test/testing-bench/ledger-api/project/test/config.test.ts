import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("refuses to load without ADMIN_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ADMIN_TOKEN: "   " })).toThrow(/ADMIN_TOKEN/);
  });

  it("uses defaults for port, host and database", () => {
    const config = loadConfig({ ADMIN_TOKEN: "abc" });
    expect(config).toEqual({ port: 3000, host: "0.0.0.0", adminToken: "abc", dbPath: ":memory:" });
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ADMIN_TOKEN: "abc", PORT: "http" })).toThrow(/PORT/);
  });
});
