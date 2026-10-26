import { describe, expect, it } from "vitest";
import type { ProjectDossier } from "@cybercheck/contracts";
import { planWorkspaces } from "../src/testing/adapters.ts";
import { seededAccounts } from "../src/testing/fixtures.ts";
import { buildIdentities } from "../src/security/proofs/run.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

const dossier = (entryPoints: ProjectDossier["entryPoints"] = []) => ({
  runPlan: { ports: [], workspaces: [], requiredEnv: [], requiredOneOf: [] },
  entryPoints,
} as unknown as ProjectDossier);

describe("Python security runtime preparation", () => {
  it("derives a FastAPI uvicorn start command from source without AI", () => {
    const src = sourceFromFiles({
      "requirements.txt": "fastapi==0.115.9\n",
      "app/main.py": "from fastapi import FastAPI\napi = FastAPI()\n",
    });
    const workspace = planWorkspaces(dossier(), src).find((w) => w.ecosystem === "python")!;
    expect(workspace.start).toBe("/work/venv-root/bin/python -m uvicorn app.main:api --host 0.0.0.0 --port 8000");
    expect(workspace.install?.command).toMatch(/import uvicorn.*pip.*uvicorn/);
  });

  it("extracts adjacent multiline Python seed records without pairing two users together", () => {
    const src = sourceFromFiles({ "app/seed.py": `users = [\n  {\n    "email": "member@example.test",\n    "password_hash": hash_password("MemberPass123!"),\n    "role": "customer",\n  },\n  {\n    "email": "admin@example.test",\n    "password_hash": hash_password("AdminPass123!"),\n    "role": "admin",\n  },\n]\n` });
    expect(seededAccounts(src)).toMatchObject([
      { account: "member@example.test", password: "MemberPass123!", role: "customer" },
      { account: "admin@example.test", password: "AdminPass123!", role: "admin" },
    ]);
  });

  it("supports OAuth form login and FastAPI's access_token response", () => {
    const src = sourceFromFiles({ "app/seed.py": `{\n  "email": "admin@example.test",\n  "password": "AdminPass123!",\n  "role": "admin"\n}` });
    const d = dossier([]);
    const { nodes } = buildIdentities(src, { method: "POST", path: "/auth/login", accountField: "username", passwordField: "password", body: "form", tokenPath: "access_token" }, d);
    expect(nodes[0]?.auth).toMatchObject({ request: { form: { username: "admin@example.test", password: "AdminPass123!" } }, tokenPath: "access_token" });
  });
});
