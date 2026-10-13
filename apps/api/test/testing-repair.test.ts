import { describe, expect, it } from "vitest";
import type { Obligation, TestFinding } from "@cybercheck/contracts";
import { applyEdits, judgeAttempt, repairScope, reviewEdits } from "../src/testing/repair.ts";

const files = new Map([
  ["app/routers/admin.py", 'from app.auth import require_admin\n\n@router.get("/feedback")\ndef feedback(period: str, user=Depends(require_admin)):\n    return list_feedback(period)\n'],
  ["frontend/app/menu/page.tsx", 'export default function Menu() {\n  return <button aria-label="Add item"><Plus /></button>;\n}\n'],
  ["app/total.py", "def total(items):\n    return sum(i.price for i in items)\n"],
]);
const allowed = [...files.keys()];

describe("a proposed patch is checked before it runs", () => {
  it("refuses edits that hide or weaken instead of fixing", () => {
    const why = (edits: Array<{ path: string; find: string; replace: string }>) => reviewEdits(edits, allowed, files).join(" ");
    expect(why([{ path: "tests/test_admin.py", find: "a", replace: "b" }])).toMatch(/tests may not be edited/);
    expect(why([{ path: "package.json", find: "a", replace: "b" }])).toMatch(/configuration/);
    expect(why([{ path: "app/other.py", find: "a", replace: "b" }])).toMatch(/not one of the files/);
    expect(why([{ path: "app/total.py", find: "i", replace: "j" }])).toMatch(/appears \d+ times/);
    expect(why([{ path: "app/total.py", find: "    return sum(i.price for i in items)", replace: "    return sum(i.price for i in items)  # type: ignore" }])).toMatch(/suppression/);
    expect(why([{ path: "app/routers/admin.py", find: "def feedback(period: str, user=Depends(require_admin)):", replace: "def feedback(period: str):" }])).toMatch(/weaken authorization/);
    expect(why([{ path: "frontend/app/menu/page.tsx", find: '  return <button aria-label="Add item"><Plus /></button>;', replace: "  return <button><Plus /></button>;" }])).toMatch(/accessibility/);
    expect(reviewEdits([{ path: "app/total.py", find: "    return sum(i.price for i in items)", replace: "    return sum(i.price * i.quantity for i in items)" }], allowed, files)).toEqual([]);
  });

  it("applies exact replacements and shows them as a unified diff", () => {
    const { patched, diff, changed } = applyEdits(files, [{ path: "app/total.py", find: "    return sum(i.price for i in items)", replace: "    return sum(i.price * i.quantity for i in items)" }]);
    expect(changed).toEqual(["app/total.py"]);
    expect(patched.get("app/total.py")).toContain("i.price * i.quantity");
    expect(diff).toContain("--- a/app/total.py");
    expect(diff).toContain("-    return sum(i.price for i in items)");
    expect(diff).toContain("+    return sum(i.price * i.quantity for i in items)");
    // The original is untouched.
    expect(files.get("app/total.py")).toContain("sum(i.price for i in items)");
  });
});

const ob = (id: string, status: Obligation["status"], ref = id): Obligation => ({ id, layer: "api", asset: { kind: "endpoint", ref, label: id }, objective: id, priority: "high", oracle: { source: "code_contract", expected: "x", evidence: [{ path: "app/total.py", line: 2 }] }, status, reason: status, origin: "dossier", executionIds: [], findingIds: [] });

describe("judging an attempt", () => {
  const before = [ob("api:POST /orders:authored:1", "failed", "orders"), ob("api:GET /orders:no-server-error", "passed", "orders"), ob("env:build:.", "passed"), ob("suite:passes:.", "passed"), ob("api:GET /other:x", "passed", "other")];
  const finding = { id: "F1", kind: "product_defect", obligationIds: ["api:POST /orders:authored:1"], location: { path: "app/total.py", line: 2 } } as unknown as TestFinding;
  const scope = repairScope(finding, before);
  const map = (list: Obligation[]) => new Map(list.map((o) => [o.id, o]));

  it("scopes the files of the problem and the checks that must keep passing", () => {
    expect(scope.files).toEqual(["app/total.py"]);
    expect(scope.reproduction).toEqual(["api:POST /orders:authored:1"]);
    expect(scope.regression.sort()).toEqual(["api:GET /orders:no-server-error", "env:build:.", "suite:passes:."]);
  });

  it("is verified only when the problem is gone and nothing that passed now fails", () => {
    const fixed = before.map((o) => (o.id === "api:POST /orders:authored:1" ? { ...o, status: "passed" as const } : o));
    expect(judgeAttempt(scope, map(before), map(fixed)).status).toBe("verified");
    expect(judgeAttempt(scope, map(before), map(before)).status).toBe("failed_validation");
    const broke = fixed.map((o) => (o.id === "suite:passes:." ? { ...o, status: "failed" as const } : o));
    const j = judgeAttempt(scope, map(before), map(broke));
    expect(j.status).toBe("regression_introduced");
    expect(j.regressions).toEqual(["suite:passes:."]);
  });

  it("verifies the exact accessibility rule even when a page still fails for another rule", () => {
    const a11y = (id: string, reason: string): Obligation => ({ ...ob(id, "failed", id), layer: "accessibility", reachedTarget: true, reason });
    const original = [
      a11y("a11y:/menu:wcag", "2 serious violations: button-name and select-name"),
      a11y("a11y:/settings:wcag", "1 serious violation: button-name"),
    ];
    const grouped = { ...finding, layer: "accessibility", rootCause: "axe-core rule button-name: Buttons must have discernible text.", obligationIds: original.map((o) => o.id) } as TestFinding;
    const a11yScope = repairScope(grouped, original);
    const repaired = [
      a11y("a11y:/menu:wcag", "1 serious violation: select-name"),
      { ...a11y("a11y:/settings:wcag", "No WCAG violation found"), status: "passed" as const },
    ];

    const result = judgeAttempt(a11yScope, map(original), map(repaired));
    expect(a11yScope.targetFailure?.marker).toBe("button-name");
    expect(result.status).toBe("verified");
    expect(result.checks.find((c) => c.obligationId === "a11y:/menu:wcag")?.targetResolved).toBe(true);
  });
});
