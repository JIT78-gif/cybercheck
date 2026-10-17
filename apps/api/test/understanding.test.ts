import { describe, expect, it } from "vitest";
import type { ProjectDossier } from "@cybercheck/contracts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { isSecretFile, redactDeep, redactJsonText, redactSecrets, sourceFromFiles, type SnapshotSource } from "../src/understanding/source.ts";
import { expressShop as expressApp } from "./fixtures.ts";

/** Build an in-memory snapshot the same way loadSnapshotSource would. */
const snapshot = (files: Record<string, string>): SnapshotSource => sourceFromFiles(files);

const run = (files: Record<string, string>) => analyzeSource(snapshot(files), { snapshotId: "s1", contentDigest: "d1" });
const route = (d: ProjectDossier, method: string, path: string) => d.entryPoints.find((e) => e.method === method && e.path === path);

// ---------------- Express + Prisma + OpenAI ----------------


describe("TypeScript: Express + Prisma + OpenAI", () => {
  it("finds every route with its full mounted path, auth status and schema", async () => {
    const d = await run(expressApp);
    expect(route(d, "GET", "/api/orders")).toMatchObject({ control: { kind: "session_required" }, mutates: false, framework: "express" });
    expect(route(d, "POST", "/api/orders")).toMatchObject({ control: { kind: "session_required" }, requestSchema: "CreateOrder" });
    expect(route(d, "DELETE", "/api/orders/:id")).toMatchObject({ control: { kind: "none_found" }, mutates: true, handler: { path: "src/routes/orders.ts", line: 9 } });
    expect(route(d, "POST", "/api/login")?.control.kind).toBe("public_intentional");
    expect(route(d, "POST", "/webhooks/stripe")?.kind).toBe("webhook");
  });

  it("builds the data model with relations and enums", async () => {
    const d = await run(expressApp);
    const user = d.dataModel.entities.find((e) => e.name === "User")!;
    expect(user.fields.find((f) => f.name === "email")).toMatchObject({ unique: true });
    expect(user.relations).toContainEqual({ to: "Order", kind: "many", field: "orders" });
    expect(d.dataModel.entities.find((e) => e.name === "Order")!.relations).toContainEqual({ to: "User", kind: "one", field: "user" });
    expect(d.dataModel.enums.map((e) => e.name)).toEqual(expect.arrayContaining(["OrderStatus", "Role"]));
    expect(d.domainTypes.find((t) => t.name === "CreateOrder")?.kind).toBe("zod");
    expect(d.domainTypes.find((t) => t.name === "Order")?.fields.map((f) => f.name)).toEqual(["id", "status", "total"]);
  });

  it("maps structure, integrations, AI, config, deployment and quality", async () => {
    const d = await run(expressApp);
    expect(d.stack.frameworks).toContain("Express");
    expect(d.stack.runtimes).toContainEqual({ name: "Node.js", version: ">=20" });
    expect(d.graph.edges).toBeGreaterThanOrEqual(5); // includes the @/lib/auth alias import
    expect(d.keyFiles[0]?.path).toMatch(/src\/lib\/(auth|db)\.ts/);
    expect(d.integrations.map((i) => i.name)).toEqual(expect.arrayContaining(["OpenAI", "Prisma ORM", "Stripe", "Authentication"]));
    const ai = d.aiComponents.find((a) => a.sdk === "OpenAI")!;
    expect(ai.calls[0]).toMatchObject({ model: "gpt-4o-mini" });
    expect(ai.toolDefinitions).toHaveLength(1);
    expect(ai.systemPrompts[0]?.preview).toContain("Acme support assistant");
    expect(d.config.envVars.find((e) => e.name === "JWT_SECRET")).toMatchObject({ documented: false });
    expect(d.config.envVars.find((e) => e.name === "OPENAI_API_KEY")).toMatchObject({ documented: true });
    expect(d.deployment.containers.map((c) => c.name)).toEqual(["api", "db"]);
    expect(d.deployment.ci[0]?.jobs[0]?.steps).toEqual(["actions/checkout@v4", "Test"]);
    expect(d.dependencies.find((x) => x.name === "express")).toMatchObject({ resolved: "4.19.2", dev: false });
    expect(d.securityModel).toMatchObject({ passwordHashing: ["bcrypt"], validationLibraries: ["zod"] });
    expect(d.securityModel.cors[0]?.allowsAnyOrigin).toBe(true);
    expect(d.quality.testFiles).toBe(1);
    expect(d.modules.find((m) => m.files > 0 && m.keyFiles.includes("src/routes/orders.ts"))?.tested).toBe(true);
    expect(d.runCommands.map((r) => r.name)).toEqual(expect.arrayContaining(["dev", "test", "build"]));
  });

  it("never reads secret files and reports evidence-backed observations", async () => {
    const d = await run(expressApp);
    expect(JSON.stringify(d)).not.toContain("sk-real-secret-value");
    const titles = d.observations.map((o) => o.title);
    expect(titles).toEqual(expect.arrayContaining([
      "A secret file is included in the project",
      "DELETE /api/orders/:id: changes data with no protection found",
      "Webhook POST /webhooks/stripe: no signature verification found",
      "CORS allows any origin",
      "Sign-in endpoints with no rate limiting found",
      "OpenAI: the model can call tools",
    ]));
    for (const o of d.observations.filter((x) => x.evidence.length)) for (const e of o.evidence) expect(e.line).toBeGreaterThan(0);
  });

  it("grades every checklist area and generates the diagrams", async () => {
    const d = await run(expressApp);
    expect(d.checklist).toHaveLength(19);
    expect(new Set(d.checklist.map((c) => c.area)).size).toBe(19);
    expect(d.checklist.find((c) => c.area === "apis")?.summary).toContain("5 endpoints");
    expect(d.checklist.find((c) => c.area === "apis")?.summary).toContain("2 no protection found");
    for (const k of ["dependencies", "data_model", "domain_types", "api_map", "auth_map", "deployment", "integrations", "test_map"]) expect(d.diagrams[k], k).toBeTruthy();
    // Node ids are hashes of the entity identity; labels carry the real names.
    const ids = Object.fromEntries([...d.diagrams.data_model!.matchAll(/^\s+(e_\w+)\["(\w+)"\] \{/gm)].map((m) => [m[2], m[1]]));
    expect(Object.keys(ids)).toEqual(expect.arrayContaining(["User", "Order"]));
    expect(d.diagrams.data_model).toContain(`${ids.User} ||--o{ ${ids.Order}`);
  });

  it("README instructions are data: they don't change any finding", async () => {
    const withoutReadme = { ...expressApp };
    delete withoutReadme["README.md"];
    const a = await run(expressApp);
    const b = await run(withoutReadme);
    expect(a.entryPoints).toEqual(b.entryPoints);
    expect(a.observations.map((o) => o.title)).toEqual(b.observations.map((o) => o.title));
  });
});

// ---------------- FastAPI + SQLAlchemy ----------------

describe("Python: FastAPI + SQLAlchemy + Celery", () => {
  const app: Record<string, string> = {
    "pyproject.toml": `[project]\nname = "items-api"\nrequires-python = ">=3.11"\ndependencies = ["fastapi>=0.110", "sqlalchemy>=2.0", "pydantic>=2", "celery[redis]>=5", "requests"]\n`,
    "app/__init__.py": "",
    "app/main.py": `from fastapi import FastAPI\nfrom app.routers import items\nimport os\napp = FastAPI()\napp.include_router(items.router, prefix="/api")\nDB = os.getenv("DATABASE_URL")\n`,
    "app/routers/__init__.py": "",
    "app/routers/items.py": `from fastapi import APIRouter, Depends
from app.schemas import ItemCreate
from app.auth import get_current_user
router = APIRouter(prefix="/items")

@router.get("/")
def list_items():
    return []

@router.post("/")
def create_item(item: ItemCreate, user=Depends(get_current_user)):
    return item

@router.delete("/{item_id}")
def delete_item(item_id: int):
    return None
`,
    "app/auth.py": "def get_current_user():\n    return None\n",
    "app/models.py": `from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import relationship, declarative_base
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)

class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey("users.id"))
    owner = relationship("User")
`,
    "app/schemas.py": "from pydantic import BaseModel\n\nclass ItemCreate(BaseModel):\n    name: str\n    price: float\n",
    "app/tasks.py": "from celery import shared_task\nimport requests\n\n@shared_task\ndef sync_prices():\n    requests.get(\"https://api.prices.example.com/v1/latest\")\n",
    "tests/test_items.py": "from app.routers import items\n\ndef test_x():\n    pass\n",
  };

  it("finds FastAPI routes with router prefixes and Depends() auth", async () => {
    const d = await run(app);
    expect(route(d, "GET", "/api/items")?.control.kind).toBe("none_found");
    expect(route(d, "POST", "/api/items")).toMatchObject({ control: { kind: "session_required", via: ["get_current_user"] }, requestSchema: "ItemCreate", framework: "fastapi" });
    expect(route(d, "DELETE", "/api/items/{item_id}")).toMatchObject({ mutates: true, control: { kind: "none_found" } });
  });

  it("builds SQLAlchemy entities, Pydantic types, Celery tasks and integrations", async () => {
    const d = await run(app);
    const item = d.dataModel.entities.find((e) => e.name === "Item")!;
    expect(item).toMatchObject({ table: "items", source: "sqlalchemy" });
    expect(item.relations.map((r) => r.to)).toEqual(expect.arrayContaining(["users", "User"]));
    expect(d.domainTypes.find((t) => t.name === "ItemCreate")).toMatchObject({ kind: "pydantic", fields: [{ name: "name", type: "str" }, { name: "price", type: "float" }] });
    expect(d.background[0]).toMatchObject({ kind: "task", name: "sync_prices", library: "celery" });
    expect(d.integrations.map((i) => i.name)).toEqual(expect.arrayContaining(["HTTP API: api.prices.example.com", "SQL ORM", "Job queue / messaging"]));
    expect(d.stack.frameworks).toContain("FastAPI");
    expect(d.stack.runtimes).toContainEqual({ name: "Python", version: ">=3.11" });
    expect(d.config.envVars.map((e) => e.name)).toContain("DATABASE_URL");
    expect(d.quality.testFiles).toBe(1);
  });
});

// ---------------- Next.js, NestJS, Django ----------------

describe("Next.js App Router", () => {
  it("maps route handlers, pages and middleware-protected APIs", async () => {
    const d = await run({
      "package.json": JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0", "next-auth": "5.0.0" } }),
      "middleware.ts": `import { auth } from "./auth";\nexport default auth;\nexport const config = { matcher: ["/api/admin/:path*"] };\n`,
      "app/api/orders/route.ts": `import { auth } from "@/auth";\nexport async function GET() { const s = await auth(); return Response.json([]); }\nexport async function POST(req: Request) { return Response.json({}); }\n`,
      "app/api/admin/users/route.ts": "export async function DELETE() { return new Response(null); }\n",
      "app/(shop)/products/[id]/page.tsx": "export default function P() { return <form><button /></form>; }\n",
      "app/page.tsx": "export default function Home() { return <main />; }\n",
      "app/actions.ts": `"use server";\nexport async function updateProfile(form: FormData) {}\n`,
    });
    expect(route(d, "GET", "/api/orders")?.control.kind).toBe("session_required");
    expect(route(d, "POST", "/api/orders")?.control.kind).toBe("none_found");
    expect(route(d, "DELETE", "/api/admin/users")?.control.via[0]).toContain("middleware");
    expect(d.screens.map((s) => s.route)).toEqual(["/", "/products/:id"]);
    expect(d.screens.find((s) => s.route === "/products/:id")?.forms).toBe(1);
    expect(d.entryPoints.find((e) => e.method === "ACTION")?.path).toBe("server action updateProfile()");
  });
});

describe("NestJS", () => {
  it("combines controller prefixes with method routes and guards", async () => {
    const d = await run({
      "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0", "@nestjs/common": "10.0.0" } }),
      "src/users.controller.ts": `import { Controller, Get, Post, Body, UseGuards } from "@nestjs/common";
@Controller("users")
export class UsersController {
  @Get()
  list() { return []; }

  @UseGuards(JwtAuthGuard)
  @Post(":id/promote")
  promote(@Body() dto: PromoteDto) { return dto; }
}
`,
    });
    expect(route(d, "GET", "/users")?.control.kind).toBe("unknown");
    expect(route(d, "POST", "/users/:id/promote")).toMatchObject({ control: { kind: "session_required", via: ["JwtAuthGuard"] }, requestSchema: "PromoteDto" });
  });
});

describe("Django", () => {
  it("follows include() prefixes and DRF routers with permission classes", async () => {
    const d = await run({
      "requirements.txt": "django==5.0\ndjangorestframework==3.15\n",
      "project/urls.py": `from django.urls import path, include\nurlpatterns = [path("api/", include("shop.urls")), path("health/", views.health)]\n`,
      "shop/urls.py": `from rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\nrouter.register(r"orders", OrderViewSet)\nurlpatterns = router.urls\n`,
      "shop/views.py": `from rest_framework import viewsets\nfrom rest_framework.permissions import IsAuthenticated\nclass OrderViewSet(viewsets.ModelViewSet):\n    permission_classes = [IsAuthenticated]\n`,
      "shop/models.py": `from django.db import models\nclass Order(models.Model):\n    total = models.DecimalField(max_digits=8, decimal_places=2)\n    customer = models.ForeignKey("Customer", on_delete=models.CASCADE)\n`,
    });
    expect(route(d, "DELETE", "/api/orders")).toMatchObject({ framework: "django-rest-framework", control: { kind: "session_required" } });
    expect(d.dataModel.entities.find((e) => e.name === "Order")).toMatchObject({ source: "django", relations: [{ to: "Customer", kind: "one", field: "customer" }] });
    expect(d.stack.frameworks).toEqual(expect.arrayContaining(["Django", "Django REST Framework"]));
  });
});

describe("authentication mechanisms", () => {
  const authFor = (files: Record<string, string>) => run(files).then((d) => d.securityModel.authMechanisms.map((m) => m.kind));

  it("recognises a hand-made bearer token (signed or unsigned) as authentication, not a contradiction", async () => {
    const unsigned = await authFor({
      "package.json": JSON.stringify({ dependencies: { express: "4.18.0" } }),
      "src/app.js": `const { requireUser } = require("./auth");\nconst app = require("express")();\napp.get("/api/me", requireUser, (req, res) => res.json(req.user));\n`,
      "src/auth.js": `function issueToken(u) { return Buffer.from(JSON.stringify({ id: u.id })).toString("base64url"); }\nfunction requireUser(req, res, next) { const raw = req.get("authorization")?.replace(/^Bearer\\s+/i, ""); const claim = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); req.user = claim; next(); }\nmodule.exports = { issueToken, requireUser };\n`,
    });
    expect(unsigned).toContain("bearer_token");

    const signed = await run({
      "package.json": JSON.stringify({ dependencies: { express: "4.18.0" } }),
      "src/auth.js": `const crypto = require("node:crypto");\nfunction sign(p) { return crypto.createHmac("sha256", process.env.S).update(p).digest("base64url"); }\nfunction issueToken(u) { const p = Buffer.from(JSON.stringify({ id: u.id })).toString("base64url"); return p + "." + sign(p); }\nfunction requireUser(req, res, next) { const raw = req.get("authorization")?.replace(/^Bearer\\s+/i, ""); const [p, s] = raw.split("."); if (!crypto.timingSafeEqual(Buffer.from(sign(p)), Buffer.from(s))) return res.status(401).end(); next(); }\n`,
    });
    const bearer = signed.securityModel.authMechanisms.find((m) => m.kind === "bearer_token");
    expect(bearer?.detail).toMatch(/signed and verified/);
    expect(signed.securityModel.notDetected.some((n) => n.control === "Authentication")).toBe(false);
  });

  it("does not turn stray Base64 or a JWT library into a hand-made token mechanism", async () => {
    const base64 = await authFor({
      "package.json": JSON.stringify({ dependencies: { express: "4.18.0" } }),
      "src/util.js": `const encoded = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");\nmodule.exports = { encoded };\n`,
    });
    expect(base64).not.toContain("bearer_token");

    const jwt = await authFor({
      "package.json": JSON.stringify({ dependencies: { jsonwebtoken: "9.0.0", express: "4.18.0" } }),
      "src/auth.js": `const jwt = require("jsonwebtoken");\nfunction mw(req, res, next) { const raw = req.get("authorization").replace(/^Bearer /, ""); req.user = jwt.verify(raw, process.env.S); next(); }\n`,
    });
    expect(jwt).toContain("jwt");
    expect(jwt).not.toContain("bearer_token");
  });
});

describe("secrets", () => {
  it("recognises secret files but not documentation examples", () => {
    for (const p of [".env", ".env.local", "config/.env.production", "certs/server.key", "id_rsa", "gcp/service-account-prod.json"]) expect(isSecretFile(p), p).toBe(true);
    for (const p of [".env.example", ".env.sample", "src/env.ts", "keys.ts"]) expect(isSecretFile(p), p).toBe(false);
  });
  it("redacts secret-looking strings in excerpts", () => {
    const { text, count } = redactSecrets(`const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\nconst password = "hunter2hunter2";\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789`);
    expect(count).toBe(3);
    expect(text).not.toMatch(/sk-abc|hunter2|ghp_/);
    expect(text).toContain(`password = "[redacted]"`);
  });
  it("keeps exported JSON valid while redacting the secrets inside it", () => {
    const run = { findings: [{ reproduction: `node -e "console.log('TOKEN='abcd1234efgh")"`, note: "key sk-abcdefghijklmnopqrstuvwxyz123456" }], n: 3, at: null };
    // The old way: redacting the serialized text swallows the escaped quote.
    expect(() => JSON.parse(redactSecrets(JSON.stringify(run, null, 2)).text)).toThrow();
    const out = JSON.parse(JSON.stringify(redactDeep(run), null, 2));
    expect(out.findings[0].reproduction).toBe(`node -e "console.log('TOKEN='[redacted]")"`);
    expect(out.findings[0].note).toBe("key [redacted]");
    expect(out).toMatchObject({ n: 3, at: null });
    expect(JSON.parse(redactJsonText(JSON.stringify(run)))).toEqual(out);
    expect(redactJsonText("not json sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("not json [redacted]");
  });
});
