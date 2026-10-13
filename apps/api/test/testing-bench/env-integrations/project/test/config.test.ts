import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const valid = {
  STRIPE_SECRET_KEY: "sk_test_123",
  SENDGRID_API_KEY: "SG.abc",
  DATABASE_URL: "postgres://u:p@localhost:5432/checkout",
  INTERNAL_API_TOKEN: "internal-token",
};

describe("loadConfig", () => {
  it("loads a complete environment", () => {
    expect(loadConfig(valid)).toEqual({
      port: 3000,
      stripeSecretKey: "sk_test_123",
      sendgridApiKey: "SG.abc",
      databaseUrl: "postgres://u:p@localhost:5432/checkout",
      internalApiToken: "internal-token",
      mailFrom: "receipts@example.com",
    });
  });

  it("lists every missing variable", () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL })).toThrow(
      "Missing required environment variables: STRIPE_SECRET_KEY, SENDGRID_API_KEY, INTERNAL_API_TOKEN",
    );
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://localhost/db" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, DATABASE_URL: "not a url" })).toThrow(ConfigError);
  });
});
