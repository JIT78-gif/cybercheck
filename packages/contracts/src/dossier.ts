import { z } from "zod";

// The Project Dossier: everything needed to understand one immutable snapshot.
// It is the shared source for the Testing, Security, AI Evaluator and AI Adversarial agents.
// Facts come from static analysis with file:line evidence; AI sections arrive later and must
// cite evidence too. Every claim says how it is known, and every checklist area is answered,
// partial, or unknown with a question.

export const Evidence = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * How a claim is known.
 * observed: seen directly in the code or config · inferred: derived from observed facts by a rule
 * not_observed: looked for within a stated scope and not found · unresolved: conflicting or incomplete evidence
 */
export const ClaimStatus = z.enum(["observed", "inferred", "not_observed", "unresolved"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

// ---------------------------------------------------------------- Endpoints

/** What protects an endpoint. Findings are only raised when an expected control is missing. */
export const ControlKind = z.enum([
  "public_intentional", // reachable without a session by design (login, OAuth callback, health, legal pages)
  "session_required", // a session or sign-in check runs before the handler
  "role_required", // a role or permission check runs before the handler
  "service_token", // a shared token or API key from configuration is compared in the handler
  "webhook_signature", // the sender's signature is verified
  "callback_state", // an OAuth callback that checks the state parameter
  "handler_check", // some other check inside the handler rejects callers (401/403)
  "none_found", // no control found, and the endpoint is not public by design
  "unknown", // could not be determined (for example a global guard elsewhere)
]);
export type ControlKind = z.infer<typeof ControlKind>;

export const EndpointControl = z.object({
  kind: ControlKind,
  /** Plain-language reason, e.g. "requireAuth preHandler hook registered for this router". */
  reason: z.string(),
  /** Names of guards, hooks or checks involved. */
  via: z.array(z.string()),
  evidence: z.array(Evidence),
});
export type EndpointControl = z.infer<typeof EndpointControl>;

export const EntryPoint = z.object({
  id: z.string(),
  status: ClaimStatus,
  kind: z.enum(["http", "webhook", "graphql", "page"]),
  method: z.string(),
  path: z.string(),
  framework: z.string(),
  handler: Evidence,
  control: EndpointControl,
  /** Name of a request/response type or schema found next to the handler, if any. */
  requestSchema: z.string().nullable(),
  /** Validation schemas applied to each part of the request, as named in code. */
  inputs: z.object({ params: z.string().nullable(), query: z.string().nullable(), body: z.string().nullable(), files: z.boolean() }),
  /** True for POST/PUT/PATCH/DELETE. */
  mutates: z.boolean(),
  /** What the handler does besides reading, even for GET: "writes database", "calls AI provider", "sends message", "sends email". */
  sideEffects: z.array(z.string()),
});
export type EntryPoint = z.infer<typeof EntryPoint>;

export const Screen = z.object({
  route: z.string(),
  /** Full browser path including the router basename, e.g. /dashboard/chats. */
  url: z.string(),
  /** API paths called from the screen and the components it renders. */
  endpoints: z.array(z.string()),
  file: z.string(),
  framework: z.string(),
  /** Literal <form> elements. */
  forms: z.number(),
  /** Editable inputs and actions, which matter more than <form> tags. */
  interactions: z.object({
    inputs: z.number(),
    buttons: z.number(),
    submitHandlers: z.number(),
    mutations: z.number(),
    formLibraries: z.array(z.string()),
  }),
});
export type Screen = z.infer<typeof Screen>;

// ---------------------------------------------------------------- Data

export const Sensitivity = z.enum(["secret", "personal", "none"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const EntityField = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean().optional(),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  references: z.string().optional(),
  /** secret: credentials or tokens · personal: data about a person (email, phone, name, messages) */
  sensitivity: Sensitivity.optional(),
  /** Added by a migration rather than the original definition. */
  addedBy: Evidence.optional(),
});
export const Entity = z.object({
  id: z.string(),
  status: ClaimStatus,
  name: z.string(),
  table: z.string().nullable(),
  source: z.string(),
  fields: z.array(EntityField),
  relations: z.array(z.object({ to: z.string(), kind: z.enum(["one", "many"]), field: z.string().optional() })),
  evidence: Evidence,
});
export type Entity = z.infer<typeof Entity>;

export const EnumDef = z.object({ name: z.string(), values: z.array(z.string()), evidence: Evidence });
export type EnumDef = z.infer<typeof EnumDef>;

export const DomainType = z.object({
  /** Qualified identity: path#name. Same-named types in different files stay separate. */
  id: z.string(),
  name: z.string(),
  kind: z.enum(["interface", "type", "class", "zod", "pydantic", "dataclass", "typeddict"]),
  fields: z.array(z.object({ name: z.string(), type: z.string() })),
  extends: z.array(z.string()),
  evidence: Evidence,
});
export type DomainType = z.infer<typeof DomainType>;

// ---------------------------------------------------------------- Integrations and AI

export const IntegrationCategory = z.enum([
  "payment",
  "email",
  "sms",
  "messaging",
  "storage",
  "database",
  "cache",
  "queue",
  "ai",
  "auth",
  "calendar",
  "monitoring",
  "search",
  "backup",
  "http",
  "other",
]);
export const Integration = z.object({
  id: z.string(),
  status: ClaimStatus,
  name: z.string(),
  category: IntegrationCategory,
  /** Where the calls happen: backend code, frontend code, or deployment configuration. */
  side: z.enum(["backend", "frontend", "infrastructure"]),
  detectedBy: z.array(z.enum(["package", "host", "config"])),
  packages: z.array(z.string()),
  hosts: z.array(z.string()),
  /** Environment variables whose names tie them to this service (names only). */
  envNames: z.array(z.string()),
  /** OAuth scopes requested from this service, as written in code. */
  scopes: z.array(z.string()),
  usedIn: z.array(Evidence),
});
export type Integration = z.infer<typeof Integration>;

export const AiComponent = z.object({
  /** Provider or SDK, e.g. "Google Gemini", "OpenRouter (HTTP)". */
  sdk: z.string(),
  calls: z.array(z.object({ evidence: Evidence, model: z.string().nullable(), api: z.string() })),
  toolDefinitions: z.array(Evidence),
  systemPrompts: z.array(z.object({ evidence: Evidence, preview: z.string() })),
});
export type AiComponent = z.infer<typeof AiComponent>;

// ---------------------------------------------------------------- Configuration

export const EnvVar = z.object({
  id: z.string(),
  status: ClaimStatus,
  name: z.string(),
  /** Where the value is read: code, or deployment files (compose, Caddyfile, scripts). */
  usedIn: z.array(Evidence),
  /** Where the name is declared for operators (.env.example and similar). */
  declaredIn: z.array(Evidence),
  documented: z.boolean(),
  /** true: startup fails without it · false: has a default or is optional · null: unknown */
  required: z.boolean().nullable(),
  hasDefault: z.boolean().nullable(),
  /** The default written in code. Never shown for secrets. */
  defaultValue: z.string().nullable(),
  sensitivity: z.enum(["secret", "config"]),
  /** browser: bundled into frontend code (VITE_, NEXT_PUBLIC_ or read in a frontend workspace) */
  side: z.enum(["server", "browser", "deploy"]),
  /** Helper functions it is read through, e.g. required(), optional(). */
  readVia: z.array(z.string()),
});
export type EnvVar = z.infer<typeof EnvVar>;

// ---------------------------------------------------------------- Infrastructure

export const Container = z.object({
  id: z.string(),
  status: ClaimStatus,
  name: z.string(),
  /** Compose file that defines it; the same service name can appear in several files. */
  file: z.string(),
  image: z.string().nullable(),
  build: z.string().nullable(),
  /** Published to the host. */
  ports: z.array(z.string()),
  /** Reachable only by other containers. */
  exposes: z.array(z.string()),
  dependsOn: z.array(z.string()),
  envNames: z.array(z.string()),
  evidence: Evidence,
});
export const Deployment = z.object({
  containers: z.array(Container),
  dockerfiles: z.array(z.object({ path: z.string(), baseImages: z.array(z.string()), exposes: z.array(z.string()), cmd: z.string().nullable() })),
  ci: z.array(z.object({ path: z.string(), provider: z.string(), jobs: z.array(z.object({ name: z.string(), steps: z.array(z.string()) })) })),
  platforms: z.array(z.object({ name: z.string(), evidence: Evidence })),
  infraResources: z.array(z.object({ type: z.string(), name: z.string(), evidence: Evidence })),
});
export type Deployment = z.infer<typeof Deployment>;

export const BackgroundJob = z.object({
  id: z.string(),
  status: ClaimStatus,
  kind: z.enum(["cron", "queue", "worker", "task", "event"]),
  name: z.string(),
  /** Schedule exactly as written, e.g. "0 ${config.scheduler.reminderHourIst} * * *". */
  schedule: z.string().nullable(),
  /** Schedule with configuration defaults filled in, when they can be traced. */
  resolvedSchedule: z.string().nullable(),
  /** How the resolved schedule was derived, e.g. "hour from REMINDER_HOUR_IST (default 9)". */
  scheduleNote: z.string().nullable(),
  timezone: z.string().nullable(),
  /** Function the job runs, when it can be named. */
  handler: z.string().nullable(),
  library: z.string(),
  evidence: Evidence,
});
export type BackgroundJob = z.infer<typeof BackgroundJob>;

// ---------------------------------------------------------------- Security model

export const AuthMechanism = z.object({
  kind: z.enum(["session", "jwt", "oauth", "api_key", "basic", "third_party"]),
  /** e.g. "Encrypted cookie session (@fastify/secure-session)" */
  detail: z.string(),
  library: z.string().nullable(),
  evidence: z.array(Evidence),
});
export const CredentialCheck = z.object({
  kind: z.enum(["password_hash", "constant_time_compare", "plain_compare", "third_party"]),
  detail: z.string(),
  evidence: z.array(Evidence),
});
export const RoleDef = z.object({
  name: z.string(),
  values: z.array(z.string()),
  /** Only app_role answers "who may do what". The others are listed so they aren't mistaken for it. */
  kind: z.enum(["app_role", "llm_role", "message_direction", "status"]),
  evidence: Evidence,
});
export const Guard = z.object({
  name: z.string(),
  /** How many endpoints it protects. */
  endpoints: z.number(),
  evidence: z.array(Evidence),
});
/** A control that was looked for and not found, with the scope of the search. */
export const NotDetected = z.object({ control: z.string(), scope: z.string() });

export const SecurityModel = z.object({
  authMechanisms: z.array(AuthMechanism),
  credentialChecks: z.array(CredentialCheck),
  guards: z.array(Guard),
  roles: z.array(RoleDef),
  passwordHashing: z.array(z.string()),
  validationLibraries: z.array(z.string()),
  rateLimiting: z.array(z.string()),
  securityHeaders: z.array(z.string()),
  csrf: z.array(z.string()),
  cors: z.array(z.object({ evidence: Evidence, allowsAnyOrigin: z.boolean() })),
  notDetected: z.array(NotDetected),
});
export type SecurityModel = z.infer<typeof SecurityModel>;

export const Dependency = z.object({
  ecosystem: z.enum(["npm", "pypi"]),
  name: z.string(),
  declared: z.string(),
  resolved: z.string().nullable(),
  dev: z.boolean(),
  manifest: z.string(),
});
export type Dependency = z.infer<typeof Dependency>;

export const ModuleInfo = z.object({
  id: z.string(),
  path: z.string(),
  files: z.number(),
  loc: z.number(),
  dependsOn: z.array(z.string()),
  keyFiles: z.array(z.string()),
  tested: z.boolean(),
});
export type ModuleInfo = z.infer<typeof ModuleInfo>;

// ---------------------------------------------------------------- Runtime behaviour visible in code

export const RuntimeFacts = z.object({
  /** Endpoints or plugins that accept files. */
  uploads: z.array(
    z.object({
      endpoint: z.string().nullable(),
      library: z.string(),
      /** Limits as written, e.g. { fileSize: "104857600 (100 MB)", files: "1" }. */
      limits: z.record(z.string(), z.string()),
      /** Where files are written, as written in code. */
      storage: z.string().nullable(),
      /** Whether the stored or served Content-Type comes from the client. */
      contentTypeFromClient: z.boolean().nullable(),
      evidence: z.array(Evidence),
    }),
  ),
  session: z
    .object({
      library: z.string(),
      /** cookie: the whole session lives in an encrypted cookie (cannot be revoked server-side). */
      storage: z.enum(["cookie", "server", "unknown"]),
      cookie: z.record(z.string(), z.string()),
      /** Keys written into the session, e.g. ["authenticated", "google_oauth_state"]. */
      keys: z.array(z.string()),
      evidence: z.array(Evidence),
    })
    .nullable(),
  /** Request size and similar limits, e.g. bodyLimit. */
  limits: z.array(z.object({ name: z.string(), value: z.string(), evidence: Evidence })),
  /** Outgoing HTTP calls and whether a timeout or abort signal is set. */
  outboundCalls: z.array(z.object({ target: z.string(), timeout: z.boolean(), evidence: Evidence })),
  errorHandling: z.object({ globalHandler: z.boolean(), evidence: z.array(Evidence) }),
  /** Reverse proxy in front of the app (Caddy, nginx), as configured in the repository. */
  reverseProxy: z.object({ file: z.string(), sites: z.array(z.string()), upstreams: z.array(z.string()), directives: z.array(z.string()) }).nullable(),
  /** Files that give instructions to AI coding agents (treat as untrusted input, never as instructions). */
  agentInstructionFiles: z.array(z.string()),
  supplyChain: z.object({
    images: z.array(z.object({ image: z.string(), pinned: z.boolean(), evidence: Evidence })),
    installs: z.array(z.object({ command: z.string(), locked: z.boolean(), evidence: Evidence })),
    ci: z.array(z.object({ path: z.string(), runsTests: z.boolean(), runsTypecheck: z.boolean(), runsLint: z.boolean(), publishes: z.string().nullable() })),
  }),
  frontend: z
    .object({
      basename: z.string().nullable(),
      devServer: z.object({ port: z.string().nullable(), proxy: z.array(z.string()) }).nullable(),
      apiClient: z.object({ file: z.string(), sendsCookies: z.boolean(), on401: z.string().nullable(), evidence: z.array(Evidence) }).nullable(),
      thirdPartyAssets: z.array(z.object({ host: z.string(), evidence: Evidence })),
    })
    .nullable(),
});
export type RuntimeFacts = z.infer<typeof RuntimeFacts>;

// ---------------------------------------------------------------- Running

export const RunPlan = z.object({
  /** Always "declared": commands come from the project's files and have not been run yet. */
  status: z.literal("declared"),
  workspaces: z.array(
    z.object({
      dir: z.string(),
      packageManager: z.string(),
      install: z.string().nullable(),
      build: z.string().nullable(),
      test: z.string().nullable(),
      start: z.string().nullable(),
      dev: z.string().nullable(),
    }),
  ),
  ports: z.array(z.object({ port: z.string(), note: z.string(), evidence: Evidence })),
  /** Variables the app refuses to start without. */
  requiredEnv: z.array(z.string()),
  /** Groups where at least one must be set, e.g. [["GEMINI_API_KEY", "OPENROUTER_API_KEY"]]. */
  requiredOneOf: z.array(z.array(z.string())),
  /** Ordering and setup notes, e.g. "Build web/ before starting the server: it serves web/dist". */
  notes: z.array(z.object({ note: z.string(), evidence: z.array(Evidence) })),
  runtimes: z.array(z.object({ name: z.string(), version: z.string().nullable(), source: z.string() })),
});
export type RunPlan = z.infer<typeof RunPlan>;

// ---------------------------------------------------------------- Checklist, findings, questions

export const ChecklistArea = z.enum([
  "purpose",
  "users_roles",
  "screens",
  "architecture",
  "code_structure",
  "data_structures",
  "business_logic",
  "apis",
  "data_flow",
  "integrations",
  "security_model",
  "ai_components",
  "background_work",
  "infrastructure",
  "configuration",
  "dependencies",
  "quality",
  "how_to_run",
  "risks_questions",
]);
export type ChecklistArea = z.infer<typeof ChecklistArea>;

export const ChecklistItem = z.object({
  area: ChecklistArea,
  /** answered: evidence found · partial: some facts · unknown: not determinable (has a question) · pending_ai: needs the AI step */
  status: z.enum(["answered", "partial", "unknown", "pending_ai"]),
  summary: z.string(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const CheckTab = z.enum(["testing", "security", "ai-evaluator", "adversarial"]);

export const Observation = z.object({
  id: z.string(),
  status: ClaimStatus,
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["info", "low", "medium", "high"]),
  evidence: z.array(Evidence),
  suggestedCheck: CheckTab,
});
export type Observation = z.infer<typeof Observation>;

export const Question = z.object({
  id: z.string(),
  area: ChecklistArea,
  question: z.string(),
  why: z.string(),
  /** Checks whose plan depends on the answer. */
  blocks: z.array(CheckTab),
});
export type Question = z.infer<typeof Question>;

/** A contradiction or gap found by comparing sections of the dossier with each other. */
export const ConsistencyIssue = z.object({
  rule: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  evidence: z.array(Evidence),
});
export type ConsistencyIssue = z.infer<typeof ConsistencyIssue>;

export const CoverageCategory = z.object({
  id: z.enum(["parsed_code", "read_config", "lockfile", "parse_failed", "not_source", "too_large", "binary", "secret_skipped", "secret_excluded", "budget"]),
  label: z.string(),
  count: z.number(),
  examples: z.array(z.string()),
});

export const DiagramKey = z.enum([
  "dependencies",
  "data_model",
  "domain_types",
  "api_map",
  "auth_map",
  "deployment",
  "integrations",
  "test_map",
]);
export type DiagramKey = z.infer<typeof DiagramKey>;

// ---------------------------------------------------------------- AI synthesis

/**
 * How an AI-written claim was checked.
 * verified: every citation exists and contains what the claim names · relocated: a citation pointed
 * at the wrong line and was moved to where the named symbol is · unverified: no citation could be confirmed
 */
export const AiVerification = z.enum(["verified", "relocated", "unverified"]);
export const AiEvidence = Evidence.extend({ symbol: z.string() });

const aiClaim = { id: z.string(), verification: AiVerification, evidence: z.array(Evidence) };

export const AiComponentSummary = z.object({ ...aiClaim, name: z.string(), modules: z.array(z.string()), responsibility: z.string(), dataHandled: z.array(z.string()) });
export const DataFlow = z.object({
  ...aiClaim,
  from: z.string(),
  to: z.string(),
  data: z.array(z.string()),
  sensitivity: z.enum(["secret", "personal", "none"]),
  /** Name of the trust boundary crossed, if any. */
  boundary: z.string().nullable(),
  description: z.string(),
});
export const TrustBoundary = z.object({ ...aiClaim, name: z.string(), description: z.string() });
export const StateMachine = z.object({
  ...aiClaim,
  entity: z.string(),
  field: z.string(),
  states: z.array(z.string()),
  transitions: z.array(z.object({ from: z.string(), to: z.string(), trigger: z.string() })),
});
export const SequenceFlow = z.object({
  ...aiClaim,
  name: z.string(),
  participants: z.array(z.string()),
  steps: z.array(z.object({ from: z.string(), to: z.string(), message: z.string() })),
});
export const Risk = z.object({
  ...aiClaim,
  title: z.string(),
  category: z.enum(["spoofing", "tampering", "repudiation", "information_disclosure", "denial_of_service", "elevation_of_privilege", "business_logic", "privacy", "ai_safety", "reliability"]),
  description: z.string(),
  affected: z.array(z.string()),
  likelihood: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  testedBy: CheckTab,
  /** Independent critic model's judgement of whether the cited code supports the risk. */
  critic: z.object({ verdict: z.enum(["supported", "partly_supported", "not_checked"]), note: z.string() }),
});
export const AiSurface = z.object({
  providers: z.array(z.object({ name: z.string(), role: z.string(), evidence: z.array(Evidence) })),
  prompts: z.array(z.object({ name: z.string(), purpose: z.string(), inputs: z.array(z.string()), personalData: z.array(z.string()), evidence: z.array(Evidence) })),
  fallbacks: z.string().nullable(),
  outputHandling: z.string().nullable(),
});

export const AiInsights = z.object({
  status: z.enum(["running", "ready", "partial", "failed"]),
  error: z.string().nullable(),
  models: z.object({ fast: z.string(), strong: z.string(), critic: z.string() }),
  usage: z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number(), ms: z.number() }),
  purpose: z.object({ summary: z.string(), users: z.array(z.object({ name: z.string(), description: z.string() })), mainFeatures: z.array(z.string()) }).nullable(),
  components: z.array(AiComponentSummary),
  trustBoundaries: z.array(TrustBoundary),
  dataFlows: z.array(DataFlow),
  stateMachines: z.array(StateMachine),
  sequences: z.array(SequenceFlow),
  risks: z.array(Risk),
  aiSurface: AiSurface.nullable(),
  designNotes: z.array(z.object({ ...aiClaim, title: z.string(), note: z.string() })),
  questions: z.array(z.object({ id: z.string(), question: z.string(), why: z.string(), blocks: z.array(CheckTab) })),
  /** Claims checked, confirmed, moved to the right line, or left unconfirmed; and claims dropped by the critic. */
  verification: z.object({ claims: z.number(), verified: z.number(), relocated: z.number(), unverified: z.number(), droppedByCritic: z.number() }),
});
export type AiInsights = z.infer<typeof AiInsights>;

export const ProjectDossier = z.object({
  schemaVersion: z.literal(2),
  meta: z.object({
    analyzerVersion: z.string(),
    snapshotId: z.string(),
    contentDigest: z.string(),
    generatedAt: z.string(),
    durationMs: z.number(),
  }),
  stack: z.object({
    languages: z.array(z.object({ name: z.string(), files: z.number(), loc: z.number() })),
    frameworks: z.array(z.string()),
    runtimes: z.array(z.object({ name: z.string(), version: z.string().nullable() })),
    packageManagers: z.array(z.string()),
    workspaces: z.array(z.object({ name: z.string(), path: z.string() })),
  }),
  modules: z.array(ModuleInfo),
  keyFiles: z.array(z.object({ path: z.string(), rank: z.number(), loc: z.number(), importedBy: z.number() })),
  graph: z.object({
    nodes: z.number(),
    edges: z.number(),
    /** Module-level edges (directory clusters) used for the dependency diagram. */
    moduleEdges: z.array(z.object({ from: z.string(), to: z.string(), weight: z.number() })),
  }),
  entryPoints: z.array(EntryPoint),
  screens: z.array(Screen),
  dataModel: z.object({ sources: z.array(z.string()), entities: z.array(Entity), enums: z.array(EnumDef) }),
  domainTypes: z.array(DomainType),
  integrations: z.array(Integration),
  aiComponents: z.array(AiComponent),
  config: z.object({ envVars: z.array(EnvVar) }),
  deployment: Deployment,
  background: z.array(BackgroundJob),
  securityModel: SecurityModel,
  dependencies: z.array(Dependency),
  quality: z.object({
    testFiles: z.number(),
    testFrameworks: z.array(z.string()),
    logging: z.array(z.string()),
    errorTracking: z.array(z.string()),
    hotspots: z.array(z.object({ path: z.string(), loc: z.number(), complexity: z.number() })),
    todoCount: z.number(),
  }),
  runCommands: z.array(z.object({ name: z.string(), command: z.string(), source: z.string() })),
  runPlan: RunPlan,
  runtime: RuntimeFacts,
  coverage: z.object({
    /** Stored files plus files left out at intake. Equals the sum of the categories. */
    filesTotal: z.number(),
    filesParsed: z.number(),
    categories: z.array(CoverageCategory),
  }),
  checklist: z.array(ChecklistItem),
  observations: z.array(Observation),
  questions: z.array(Question),
  consistency: z.array(ConsistencyIssue),
  /** AI synthesis built on the facts above. null when the AI step has not run (no key or not started). */
  ai: AiInsights.nullable(),
  diagrams: z.record(z.string(), z.string()),
});
export type ProjectDossier = z.infer<typeof ProjectDossier>;

export const UnderstandingStatus = z.enum(["queued", "analyzing", "ready", "failed"]);
export type UnderstandingStatus = z.infer<typeof UnderstandingStatus>;

export const UnderstandingRun = z.object({
  id: z.string(),
  snapshotId: z.string(),
  status: UnderstandingStatus,
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  dossier: ProjectDossier.nullable(),
  /** Live progress while the code is read or the AI step runs; null when idle. */
  progress: z.object({ step: z.string(), progress: z.number().nullable() }).nullable(),
});
export type UnderstandingRun = z.infer<typeof UnderstandingRun>;

export const SourceExcerpt = z.object({
  path: z.string(),
  start: z.number(),
  end: z.number(),
  totalLines: z.number(),
  lines: z.array(z.string()),
  redactions: z.number(),
});
export type SourceExcerpt = z.infer<typeof SourceExcerpt>;
