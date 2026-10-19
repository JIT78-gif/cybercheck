import { describe, expect, it } from "vitest";
import { AD_CANARY, classifyAttackers, missingFixtures, requiredFixtures, resetStrategyFor, syntheticDocuments, type FixtureAvailability } from "../src/adversarial/fixtures.ts";

// AI Adversarial Step 8: synthetic fixtures and reset support. Everything is synthetic and sandbox-local.

describe("AI Adversarial fixtures", () => {
  it("keeps canaries synthetic and sandbox-local", () => {
    expect(AD_CANARY.ssrfUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(syntheticDocuments("acme")[0]!.body).toContain(AD_CANARY.poison);
    expect(syntheticDocuments("acme")[1]!.tenant).toBe("acme-other"); // a different tenant for cross-tenant retrieval
  });

  it("classifies the attacker vantage points onto seeded identities", () => {
    const m = classifyAttackers([
      { name: "user-a", role: "customer", tenant: "acme" },
      { name: "user-b", role: "customer", tenant: "globex" },
      { name: "admin", role: "admin", tenant: "acme" },
    ]);
    expect(m.anonymous).toBe("anonymous");
    expect(m.user).toBe("user-a");
    expect(m.cross_user).toBe("user-b");
    expect(m.cross_tenant).toBe("user-b"); // different tenant from user-a
    expect(m.admin).toBe("admin");
    expect(m.lower_role).toBe("user-a"); // a non-admin exists alongside an admin
    expect(m.service).toBeNull();
    expect(m.agent).toBeNull();
  });

  it("leaves vantage points null when the run cannot stand them up", () => {
    const m = classifyAttackers([{ name: "solo", role: "customer", tenant: null }]);
    expect(m.user).toBe("solo");
    expect(m.cross_user).toBeNull();
    expect(m.cross_tenant).toBeNull();
    expect(m.admin).toBeNull();
    expect(m.lower_role).toBeNull(); // no admin, so there is no lower-role contrast
  });

  it("chooses a reset strategy for every lane and mutating lanes reseed or refresh", () => {
    expect(resetStrategyFor("tools_approval")).toBe("db_reseed");
    expect(resetStrategyFor("rag_memory")).toBe("memory_cleanup");
    expect(resetStrategyFor("output_handling")).toBe("fresh_browser");
    expect(resetStrategyFor("prompt")).toBe("new_conversation");
  });

  it("reports the fixtures a lane is missing", () => {
    const bare: FixtureAvailability = { identities: 1, tenants: 1, hasTools: false, hasDocuments: false, hasMemory: false, hasApproval: false, hasBrowser: false };
    expect(missingFixtures("tools_approval", bare)).toEqual(expect.arrayContaining(["a tool to invoke", "an approval gate to test"]));
    expect(missingFixtures("identity_tenant", bare)).toContain("a second seeded identity");
    expect(requiredFixtures("prompt")).toEqual(["identity"]);
    const rich: FixtureAvailability = { identities: 2, tenants: 2, hasTools: true, hasDocuments: true, hasMemory: true, hasApproval: true, hasBrowser: true };
    expect(missingFixtures("rag_memory", rich)).toEqual([]);
  });
});
