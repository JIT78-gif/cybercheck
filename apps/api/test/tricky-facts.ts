// Facts with names that commonly break Mermaid (brackets, quotes, pipes, keywords, unicode),
// plus duplicates across files. Used to prove every generated diagram stays valid and every
// node id unique, whatever the project calls things.
const ev = (path: string, line = 1) => ({ path, line });
const weird = ["end", "class", "note", "style", "graph", "default", "click", "subgraph", "a (b) [c] {d}", "pipe|name", 'quote"name', "tick`name`", "émoji 🚀 ünïcode", "semi;colon#hash", "arrow-->x", "x".repeat(120)];

const control = (kind: string, via: string[] = []) => ({ kind, reason: `reason (${kind}) "quoted" [x]`, via, evidence: [] });

export const trickyFacts = {
  stack: { languages: [{ name: "TypeScript", files: 3, loc: 30 }], frameworks: ['Express (custom) "v5"', "React"], runtimes: [], packageManagers: ["npm"], workspaces: [] },
  modules: weird.map((w, i) => ({ id: `src/${w}`, path: `src/${w}`, files: 1, loc: 10 + i, dependsOn: [], keyFiles: [`src/${w}/index.ts`], tested: i % 2 === 0 })),
  keyFiles: [{ path: "src/end/index.ts", rank: 1, loc: 10, importedBy: 3 }],
  graph: { nodes: 16, edges: 15, moduleEdges: weird.slice(1).map((w, i) => ({ from: `src/${weird[i]}`, to: `src/${w}`, weight: i + 1 })) },
  entryPoints: weird.flatMap((w, i) => [
    { id: `endpoint:GET /api/${w}`, status: "observed", kind: "http", method: "GET", path: `/api/${w}/:id(\\d+)|*`, framework: "express", handler: ev("src/a.ts", i + 1), control: control(["session_required", "public_intentional", "none_found", "unknown", "service_token"][i % 5]!, [`requireAuth (applied to router "${w}")`]), requestSchema: null, inputs: { params: w, query: null, body: null, files: i % 2 === 0 }, mutates: false, sideEffects: ["writes database"] },
    { id: `endpoint:POST /${w}`, status: "observed", kind: "webhook", method: "POST", path: `/${w}`, framework: "express", handler: ev("src/b.ts", i + 1), control: control("none_found"), requestSchema: null, inputs: { params: null, query: null, body: `Body${i}`, files: false }, mutates: true, sideEffects: [] },
  ]),
  screens: [],
  dataModel: {
    sources: ["prisma"],
    entities: weird.slice(0, 8).flatMap((w, i) => [
      { id: `entity:prisma:${w}`, status: "observed", name: w, table: `${w}_table`, source: "prisma", fields: [{ name: `${w} id`, type: "String(36)", primaryKey: true, sensitivity: "secret" }, { name: "ref", type: "Decimal(10,2)?", references: weird[(i + 1) % 8], sensitivity: "personal" }], relations: [{ to: weird[(i + 1) % 8]!, kind: i % 2 ? "many" : "one", field: `rel (${w}) "x"` }], evidence: ev("prisma/schema.prisma", i + 1) },
      // Same table name from another source: must still get its own node.
      { id: `entity:sql:${w}`, status: "observed", name: w, table: `${w}_table`, source: "sql", fields: [{ name: "id", type: "integer" }], relations: [], evidence: ev("db/schema.sql", i + 1) },
    ]),
    enums: [],
  },
  domainTypes: weird.flatMap((w, i) => [
    { id: `src/a/types.ts#${w}`, name: w, kind: "interface", fields: [{ name: "fn", type: "(a: string, b: { c: number[] }) => Promise<Record<string, Array<'x' | \"y\">>>" }, { name: w, type: "`template ${literal}`" }, { name: "list", type: "string[]" }, { name: "dir", type: "\"in\" | \"out\"" }], extends: i ? [weird[i - 1]!] : [], evidence: ev("src/a/types.ts", i + 1) },
    // Same type name in a second module.
    { id: `src/b/types.ts#${w}`, name: w, kind: "interface", fields: [{ name: "other", type: "number" }], extends: [], evidence: ev("src/b/types.ts", i + 1) },
  ]),
  integrations: weird.map((w, i) => ({ id: `integration:${i}`, status: "observed", name: w, category: i % 2 ? "ai" : "payment", side: (["backend", "frontend", "infrastructure"] as const)[i % 3], detectedBy: ["package"], packages: [w], hosts: [], envNames: [], scopes: [w], usedIn: [ev("src/x.ts")] })),
  aiComponents: [],
  config: { envVars: [] },
  deployment: {
    containers: weird.slice(0, 6).flatMap((w, i) => ["docker-compose.yml", "deploy/compose (prod).yml"].map((file) => ({ id: `container:${file}#${w}`, status: "observed", name: w, file, image: i % 2 ? `postgres:16 "${w}"` : null, build: `./${w}`, ports: ["5432:5432", "[::1]:80:80"], exposes: ["3000"], dependsOn: i ? [weird[i - 1]!] : [], envNames: [], evidence: ev(file, i + 1) }))),
    dockerfiles: [{ path: "Dockerfile (prod)", baseImages: ["node:24 | alpine"], exposes: ["3000"], cmd: null }],
    ci: [{ path: ".github/workflows/ci (main).yml", provider: "GitHub Actions", jobs: weird.slice(0, 5).map((w) => ({ name: w, steps: [] })) }],
    platforms: [{ name: 'Vercel "edge" (beta)', evidence: ev("vercel.json") }],
    infraResources: [],
  },
  background: [],
  securityModel: { authMechanisms: [], credentialChecks: [], guards: [], roles: [], passwordHashing: [], validationLibraries: [], rateLimiting: [], securityHeaders: [], csrf: [], cors: [], notDetected: [] },
  dependencies: [],
  quality: { testFiles: 1, testFrameworks: [], logging: [], errorTracking: [], hotspots: [], todoCount: 0 },
  runCommands: [],
  runPlan: { status: "declared", workspaces: [], ports: [], requiredEnv: [], requiredOneOf: [], notes: [], runtimes: [] },
  runtime: {
    uploads: [],
    session: null,
    limits: [],
    outboundCalls: [],
    errorHandling: { globalHandler: false, evidence: [] },
    reverseProxy: null,
    agentInstructionFiles: [],
    supplyChain: { images: [], installs: [], ci: [{ path: ".github/workflows/ci (main).yml", runsTests: false, runsTypecheck: false, runsLint: false, publishes: 'ghcr.io "x" [y]' }] },
    frontend: null,
  },
  coverage: { filesTotal: 3, filesParsed: 3, categories: [] },
};

// AI insights with the same awkward names, for the code-generated AI diagrams.
export const trickyAi = {
  status: "ready", error: null, models: { fast: "f", strong: "s", critic: "c" }, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 },
  purpose: { summary: 'A "quoted" system; with: separators [x] {y}.', users: weird.slice(0, 4).map((w) => ({ name: w, description: w })), mainFeatures: [] },
  components: [], trustBoundaries: [], designNotes: [], questions: [], risks: [], aiSurface: null,
  dataFlows: weird.map((w, i) => ({ id: `flow-${i}`, verification: "verified", evidence: [], from: w, to: weird[(i + 1) % weird.length]!, data: [w, 'a;b:c'], sensitivity: (["secret", "personal", "none"] as const)[i % 3], boundary: i % 2 ? w : null, description: w })),
  stateMachines: [{ id: "state-1", verification: "verified", evidence: [], entity: "end", field: 'state "x"', states: weird.slice(0, 6), transitions: weird.slice(0, 5).map((w, i) => ({ from: w, to: weird[i + 1]!, trigger: `on ${w}: go; now` })) }],
  sequences: [{ id: "sequence-1", verification: "verified", evidence: [], name: 'flow "x"', participants: weird.slice(0, 5), steps: weird.slice(0, 5).map((w, i) => ({ from: w, to: weird[(i + 2) % 5]!, message: `send ${w}; then: #done` })) }],
  verification: { claims: 0, verified: 0, relocated: 0, unverified: 0, droppedByCritic: 0 },
};
