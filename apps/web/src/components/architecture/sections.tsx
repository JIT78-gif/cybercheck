"use client";

import {
  Blocks,
  Bot,
  Boxes,
  CircleHelp,
  Clock,
  Cpu,
  Database,
  FileCode2,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Network,
  Package,
  Play,
  Plug,
  Route,
  Server,
  Sparkles,
  Workflow,
  GitBranch,
  ListOrdered,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { ChecklistArea, ChecklistItem, DiagramKey, EntryPoint, Observation, ProjectDossier } from "@cybercheck/contracts";
import { CHECK_INFO } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { EvidenceLink } from "./code-viewer";
import { MermaidDiagram } from "./mermaid-diagram";
import { AiSurfaceSection, DataFlows, Purpose, Risks, Runtime, Sequences, States } from "./meaning-sections";
import { Badge, DataTable, Empty, Facts, List, Mono, SectionHeader, SubTitle } from "./parts";

type D = ProjectDossier;

export type SectionId =
  | "summary"
  | "observations"
  | "questions"
  | "structure"
  | "data"
  | "types"
  | "apis"
  | "screens"
  | "security"
  | "integrations"
  | "ai"
  | "background"
  | "infrastructure"
  | "config"
  | "dependencies"
  | "quality"
  | "run"
  | "coverage"
  | "purpose"
  | "dataflow"
  | "states"
  | "sequences"
  | "risks"
  | "aisurface"
  | "runtime";

export type SectionDef = { id: SectionId; label: string; icon: LucideIcon; count?: (d: D) => number; render: (d: D, go: (id: SectionId) => void) => React.ReactNode };

const AREA_LABEL: Record<ChecklistArea, string> = {
  purpose: "Purpose",
  users_roles: "Users and roles",
  screens: "Screens and journeys",
  architecture: "Architecture",
  code_structure: "Code structure",
  data_structures: "Data structures",
  business_logic: "Business logic",
  apis: "APIs",
  data_flow: "Data flow",
  integrations: "Integrations",
  security_model: "Security model",
  ai_components: "AI components",
  background_work: "Background work",
  infrastructure: "Infrastructure",
  configuration: "Configuration",
  dependencies: "Dependencies",
  quality: "Quality and operations",
  how_to_run: "How to run",
  risks_questions: "Risks and questions",
};

const AREA_SECTION: Record<ChecklistArea, SectionId | null> = {
  purpose: "purpose",
  users_roles: "security",
  screens: "screens",
  architecture: "structure",
  code_structure: "structure",
  data_structures: "data",
  business_logic: "states",
  apis: "apis",
  data_flow: "dataflow",
  integrations: "integrations",
  security_model: "security",
  ai_components: "ai",
  background_work: "background",
  infrastructure: "infrastructure",
  configuration: "config",
  dependencies: "dependencies",
  quality: "quality",
  how_to_run: "run",
  risks_questions: "observations",
};

const STATUS: Record<ChecklistItem["status"], { label: string; tone: "good" | "warn" | "bad" | "info" }> = {
  answered: { label: "Answered", tone: "good" },
  partial: { label: "Partly", tone: "warn" },
  unknown: { label: "Unknown", tone: "bad" },
  pending_ai: { label: "Needs AI step", tone: "info" },
};

const SEVERITY: Record<Observation["severity"], { label: string; tone: "bad" | "warn" | "info" | "muted" }> = {
  high: { label: "High", tone: "bad" },
  medium: { label: "Medium", tone: "warn" },
  low: { label: "Low", tone: "info" },
  info: { label: "Info", tone: "muted" },
};

const CONTROL: Record<EntryPoint["control"]["kind"], { label: string; tone: "good" | "bad" | "muted" | "info" }> = {
  session_required: { label: "Sign-in required", tone: "good" },
  role_required: { label: "Role required", tone: "good" },
  service_token: { label: "Service token", tone: "good" },
  webhook_signature: { label: "Signature verified", tone: "good" },
  callback_state: { label: "OAuth state checked", tone: "good" },
  handler_check: { label: "Check in handler", tone: "good" },
  public_intentional: { label: "Public by design", tone: "info" },
  none_found: { label: "No protection found", tone: "bad" },
  unknown: { label: "Undetermined", tone: "muted" },
};
const PROTECTED = new Set<EntryPoint["control"]["kind"]>(["session_required", "role_required", "service_token", "webhook_signature", "callback_state", "handler_check"]);

const TAB_LABEL: Record<Observation["suggestedCheck"], string> = { testing: "Testing", security: "Security", "ai-evaluator": "AI Evaluator", adversarial: "AI Adversarial" };

const n = (x: number) => x.toLocaleString("en-US");

function Diagram({ d, k, label }: { d: D; k: DiagramKey; label: string }) {
  const code = d.diagrams[k];
  return code ? <MermaidDiagram code={code} label={label} /> : null;
}

function Evidences({ items, max = 3 }: { items: Array<{ path: string; line: number; endLine?: number }>; max?: number }) {
  if (!items.length) return <span className="text-fg-muted">n/a</span>;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      {items.slice(0, max).map((e) => (
        <EvidenceLink key={`${e.path}:${e.line}`} evidence={e} />
      ))}
      {items.length > max && <span className="text-xs text-fg-muted">and {items.length - max} more</span>}
    </span>
  );
}

function Stat({ label, value, onClick }: { label: string; value: number | string; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn("rounded-xl border border-border px-4 py-3 text-left", onClick && "cursor-pointer transition-colors hover:border-accent/40 hover:bg-surface-2/40")}
    >
      <p className="text-2xl font-semibold text-fg tabular-nums">{value}</p>
      <p className="text-xs text-fg-muted">{label}</p>
    </Tag>
  );
}

/* ---------------------------------------------------------------- Overview */

function Summary(d: D, go: (id: SectionId) => void) {
  const counts = { answered: 0, partial: 0, unknown: 0, pending_ai: 0 };
  for (const c of d.checklist) counts[c.status]++;
  const total = d.checklist.length;
  return (
    <div className="space-y-8">
      <SectionHeader
        title="Summary"
        intro="Everything below was read from the code itself, without running it. Each fact links to the exact file and line it came from."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Endpoints" value={n(d.entryPoints.length)} onClick={() => go("apis")} />
        <Stat label="Data entities" value={n(d.dataModel.entities.length)} onClick={() => go("data")} />
        <Stat label="Integrations" value={n(d.integrations.length)} onClick={() => go("integrations")} />
        <Stat label="Things to check" value={n(d.observations.length)} onClick={() => go("observations")} />
      </div>

      <div className="space-y-3">
        <SubTitle>How well we understand this project</SubTitle>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <div className="bg-success" style={{ width: `${(counts.answered / total) * 100}%` }} />
          <div className="bg-warning" style={{ width: `${(counts.partial / total) * 100}%` }} />
          <div className="bg-accent/60" style={{ width: `${(counts.pending_ai / total) * 100}%` }} />
          <div className="bg-danger" style={{ width: `${(counts.unknown / total) * 100}%` }} />
        </div>
        <p className="text-sm text-fg-muted">
          {counts.answered} of {total} areas answered from code, {counts.partial} partly, {counts.pending_ai} waiting for the AI step
          {counts.unknown ? `, ${counts.unknown} unknown (we ask you about these)` : ""}.
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {d.checklist.map((c) => {
            const target = AREA_SECTION[c.area];
            const body = (
              <>
                <span className="flex shrink-0 items-center gap-2 sm:w-56">
                  <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                  <span className="text-sm font-medium text-fg">{AREA_LABEL[c.area]}</span>
                </span>
                <span className="min-w-0 text-sm text-fg-muted">{c.summary}</span>
              </>
            );
            const row = "flex w-full flex-col gap-1 px-4 py-3 text-left sm:flex-row sm:items-start sm:gap-4";
            return (
              <li key={c.area}>
                {target ? (
                  <button type="button" onClick={() => go(target)} className={cn(row, "cursor-pointer transition-colors hover:bg-surface-2/40")}>
                    {body}
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {d.consistency.length > 0 && (
        <div className="space-y-3">
          <SubTitle>Gaps to know about</SubTitle>
          <p className="text-sm text-fg-muted">Places where the code leaves something open or the facts don&apos;t fully line up. The checks take these into account.</p>
          <ul className="space-y-2">
            {d.consistency.map((c, i) => (
              <li key={`${c.rule}-${i}`} className="flex flex-wrap items-start gap-2 rounded-xl border border-border px-4 py-3 text-sm">
                <Badge tone={c.severity === "error" ? "bad" : "warn"}>{c.severity === "error" ? "Contradiction" : "Gap"}</Badge>
                <span className="min-w-0 flex-1 text-fg">{c.message}</span>
                {c.evidence.length > 0 && <Evidences items={c.evidence} max={2} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        <SubTitle>Stack</SubTitle>
        <Facts
          items={[
            ["Languages", d.stack.languages.map((l) => `${l.name} (${n(l.loc)} lines)`).join(", ") || "None detected"],
            ["Frameworks", <List key="f" values={d.stack.frameworks} none="None detected" />],
            ["Runtimes", [...new Map(d.runPlan.runtimes.map((r) => [`${r.name} ${r.version ?? ""}`, r])).values()].map((r) => `${r.name}${r.version ? ` ${r.version}` : ""} (${r.source})`).join(", ") || "Not declared"],
            ["Package managers", <List key="p" values={d.stack.packageManagers} none="Not detected" />],
            ...(d.stack.workspaces.length ? [["Workspaces", d.stack.workspaces.map((w) => w.name).join(", ")] as [string, string]] : []),
          ]}
        />
      </div>
    </div>
  );
}

function Observations(d: D) {
  const order = ["high", "medium", "low", "info"] as const;
  const sorted = [...d.observations].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Things to check"
        intro="Patterns in the code that deserve a closer look. These are leads, not confirmed problems: the matching check tests each one."
      />
      {sorted.length === 0 ? (
        <Empty>Nothing stood out in the static analysis. The checks will still test the project.</Empty>
      ) : (
        <ul className="space-y-3">
          {sorted.map((o) => {
            const check = CHECK_INFO[o.suggestedCheck];
            return (
              <li key={o.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY[o.severity].tone}>{SEVERITY[o.severity].label}</Badge>
                  <p className="min-w-0 font-medium text-fg">{o.title}</p>
                </div>
                <p className="mt-2 text-sm text-fg-muted">{o.detail}</p>
                <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                  {o.evidence.length > 0 ? <Evidences items={o.evidence} max={5} /> : <span />}
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <check.icon className="size-3.5 text-accent" aria-hidden="true" /> Tested by the {check.name} check
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Questions(d: D, go: (id: SectionId) => void) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Open questions"
        intro="Some things can't be known from code alone. Your answers will be shared with every check, so they test what actually matters."
      />
      {d.questions.length === 0 ? (
        <Empty>No open questions right now.</Empty>
      ) : (
        <ol className="space-y-3">
          {d.questions.map((q, i) => (
            <li key={q.id} className="flex gap-3 rounded-xl border border-border p-4">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg tabular-nums">{i + 1}</span>
              <div className="min-w-0">
                <p className="font-medium text-fg">{q.question}</p>
                <p className="mt-1 text-sm text-fg-muted">{q.why}</p>
                {q.blocks.length > 0 && <p className="mt-2 text-xs text-fg-muted">Needed by: {q.blocks.map((b) => TAB_LABEL[b]).join(", ")}</p>}
                {AREA_SECTION[q.area] && (
                  <button type="button" onClick={() => go(AREA_SECTION[q.area]!)} className="mt-2 cursor-pointer text-xs font-medium text-accent hover:underline">
                    See {AREA_LABEL[q.area].toLowerCase()}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Structure */

function Structure(d: D) {
  return (
    <div className="space-y-8">
      <SectionHeader
        title="Code structure"
        intro={`${n(d.graph.nodes)} source files with ${n(d.graph.edges)} import links, grouped into ${d.modules.length} modules. Arrows point from a module to the modules it uses.`}
      />
      <Diagram d={d} k="dependencies" label="Module dependencies" />
      <div className="space-y-3">
        <SubTitle>Modules</SubTitle>
        <DataTable
          rows={d.modules}
          rowKey={(m) => m.id}
          searchText={(m) => m.path}
          searchLabel="Search modules"
          filters={[{ id: "untested", label: "Without tests", test: (m) => !m.tested }]}
          empty="No source modules were found."
          columns={[
            { label: "Module", cell: (m) => <Mono>{m.path}</Mono> },
            { label: "Files", cell: (m) => n(m.files), className: "tabular-nums" },
            { label: "Lines", cell: (m) => n(m.loc), className: "tabular-nums" },
            { label: "Uses", cell: (m) => (m.dependsOn.length ? <Mono className="text-fg-muted">{m.dependsOn.join(", ")}</Mono> : <span className="text-fg-muted">nothing</span>) },
            { label: "Tests", cell: (m) => (m.tested ? <Badge tone="good">Yes</Badge> : <Badge tone="muted">No</Badge>) },
          ]}
        />
      </div>
      <div className="space-y-3">
        <SubTitle>Most central files</SubTitle>
        <p className="text-sm text-fg-muted">Ranked by how much of the codebase depends on them. Changes here affect the most code.</p>
        <DataTable
          rows={d.keyFiles}
          rowKey={(k) => k.path}
          empty="No key files were found."
          columns={[
            { label: "File", cell: (k) => <EvidenceLink evidence={{ path: k.path, line: 1 }} /> },
            { label: "Imported by", cell: (k) => n(k.importedBy), className: "tabular-nums" },
            { label: "Lines", cell: (k) => n(k.loc), className: "tabular-nums" },
          ]}
        />
      </div>
    </div>
  );
}

function DataStructures(d: D) {
  const { entities, enums, sources } = d.dataModel;
  return (
    <div className="space-y-8">
      <SectionHeader
        title="Data structures"
        intro={
          entities.length
            ? `${entities.length} tables read from ${sources.join(", ")}. Lines between boxes are relations. Columns that hold credentials or data about people are marked.`
            : "No database schema was found."
        }
      />
      <Diagram d={d} k="data_model" label="Entity relationship diagram" />
      {entities.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {entities.map((e) => (
            <div key={`${e.source}:${e.name}`} className="min-w-0 rounded-xl border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <p className="font-medium text-fg">
                  {e.name}
                  {e.table && e.table !== e.name && <span className="ml-2 font-mono text-xs text-fg-muted">{e.table}</span>}
                </p>
                <EvidenceLink evidence={e.evidence} />
              </div>
              <ul className="divide-y divide-border/60 text-sm">
                {e.fields.map((f) => (
                  <li key={f.name} className="flex items-center justify-between gap-3 px-4 py-1.5">
                    <span className="min-w-0 truncate font-mono text-xs text-fg">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {f.sensitivity === "secret" && <Badge tone="bad">secret</Badge>}
                      {f.sensitivity === "personal" && <Badge tone="warn">personal</Badge>}
                      {f.addedBy && <span title={`Added by a migration at ${f.addedBy.path}:${f.addedBy.line}`}><Badge tone="muted">migration</Badge></span>}
                      {f.primaryKey && <Badge tone="info">PK</Badge>}
                      {f.unique && <Badge tone="muted">unique</Badge>}
                      {f.references && <Badge tone="muted">to {f.references}</Badge>}
                      <span className="font-mono text-xs text-fg-muted">
                        {f.type}
                        {f.nullable ? "?" : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {enums.length > 0 && (
        <div className="space-y-3">
          <SubTitle>Enums and status values</SubTitle>
          <DataTable
            rows={enums}
            rowKey={(e) => `${e.name}:${e.evidence.path}`}
            empty=""
            columns={[
              { label: "Enum", cell: (e) => <Mono>{e.name}</Mono> },
              { label: "Values", cell: (e) => <Mono className="text-fg-muted">{e.values.join(", ")}</Mono> },
              { label: "Defined at", cell: (e) => <EvidenceLink evidence={e.evidence} /> },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function DomainTypes(d: D) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Domain types" intro="Interfaces, classes and schemas that describe the data the code passes around." />
      <Diagram d={d} k="domain_types" label="Domain type diagram" />
      <DataTable
        rows={d.domainTypes}
        rowKey={(t) => `${t.name}:${t.evidence.path}:${t.evidence.line}`}
        searchText={(t) => `${t.name} ${t.fields.map((f) => f.name).join(" ")}`}
        searchLabel="Search types and fields"
        filters={[...new Set(d.domainTypes.map((t) => t.kind))].map((k) => ({ id: k, label: k, test: (t: D["domainTypes"][number]) => t.kind === k }))}
        empty="No domain types were found."
        columns={[
          { label: "Type", cell: (t) => <Mono>{t.name}</Mono> },
          { label: "Kind", cell: (t) => <Badge tone="muted">{t.kind}</Badge> },
          {
            label: "Fields",
            cell: (t) => (
              <Mono className="text-fg-muted">
                {t.fields.slice(0, 8).map((f) => `${f.name}: ${f.type}`).join(", ")}
                {t.fields.length > 8 ? `, and ${t.fields.length - 8} more` : ""}
              </Mono>
            ),
          },
          { label: "Defined at", cell: (t) => <EvidenceLink evidence={t.evidence} /> },
        ]}
      />
    </div>
  );
}

function Apis(d: D) {
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  return (
    <div className="space-y-8">
      <SectionHeader
        title="API and payloads"
        intro="Every endpoint found in the code and what protects it. “Public by design” covers sign-in, health and legal pages. “No protection found” means we didn't see a check; it may still be protected somewhere we can't see."
      />
      <Diagram d={d} k="api_map" label="API map" />
      <DataTable
        rows={routes}
        rowKey={(r) => r.id}
        searchText={(r) => `${r.method} ${r.path} ${r.control.via.join(" ")} ${r.control.reason} ${r.requestSchema ?? ""} ${r.handler.path}`}
        searchLabel="Search path, handler or schema"
        filters={[
          { id: "open", label: "No protection found", test: (r) => r.control.kind === "none_found" },
          { id: "public", label: "Public by design", test: (r) => r.control.kind === "public_intentional" },
          { id: "mutating", label: "Changes data", test: (r) => r.mutates },
          { id: "side", label: "GET with side effects", test: (r) => r.method === "GET" && r.sideEffects.length > 0 },
          { id: "files", label: "Accepts files", test: (r) => r.inputs.files },
          { id: "webhook", label: "Webhooks", test: (r) => r.kind === "webhook" },
        ]}
        empty="No API endpoints were found."
        columns={[
          { label: "Method", cell: (r) => <Mono className="font-semibold">{r.method}</Mono>, className: "w-20" },
          { label: "Path", cell: (r) => <Mono>{r.path}</Mono> },
          {
            label: "Protection",
            cell: (r) => (
              <span className="flex max-w-xs flex-col items-start gap-1">
                <Badge tone={CONTROL[r.control.kind].tone}>{CONTROL[r.control.kind].label}</Badge>
                <span className="text-xs text-fg-muted">{r.control.reason}</span>
                {r.control.evidence.length > 0 && <Evidences items={r.control.evidence} max={2} />}
              </span>
            ),
          },
          {
            label: "Takes and does",
            cell: (r) => {
              const inputs = [r.inputs.params && `params ${r.inputs.params}`, r.inputs.query && `query ${r.inputs.query}`, r.inputs.body && `body ${r.inputs.body}`, r.inputs.files && "files"].filter(Boolean) as string[];
              return (
                <span className="flex max-w-xs flex-col items-start gap-1">
                  {inputs.length ? <Mono className="text-fg-muted">{inputs.join(", ")}</Mono> : r.requestSchema ? <Mono className="text-fg-muted">{r.requestSchema}</Mono> : <span className="text-xs text-fg-muted">no validation schema found</span>}
                  {r.sideEffects.length > 0 && <span className="flex flex-wrap gap-1">{r.sideEffects.map((s) => <Badge key={s} tone={r.method === "GET" ? "warn" : "muted"}>{s}</Badge>)}</span>}
                </span>
              );
            },
          },
          { label: "Handler", cell: (r) => <EvidenceLink evidence={r.handler} /> },
        ]}
      />
    </div>
  );
}

function Screens(d: D) {
  return (
    <div className="space-y-6">
      <SectionHeader title="Screens" intro="Pages a user can open, found from the frontend router." />
      <DataTable
        rows={d.screens}
        rowKey={(s) => `${s.route}:${s.file}`}
        searchText={(s) => `${s.route} ${s.file}`}
        searchLabel="Search screens"
        filters={[
          { id: "inputs", label: "With inputs", test: (s) => s.interactions.inputs > 0 },
          { id: "mutations", label: "Changes data", test: (s) => s.interactions.mutations > 0 },
        ]}
        empty="No frontend screens were found. This may be an API-only project."
        columns={[
          { label: "URL", cell: (s) => <Mono>{s.url}</Mono> },
          { label: "Inputs", cell: (s) => s.interactions.inputs, className: "tabular-nums" },
          { label: "Data-changing calls", cell: (s) => s.interactions.mutations, className: "tabular-nums" },
          { label: "API calls", cell: (s) => (s.endpoints.length ? <Mono className="text-fg-muted">{s.endpoints.join(", ")}</Mono> : <span className="text-fg-muted">none found</span>) },
          { label: "File", cell: (s) => <EvidenceLink evidence={{ path: s.file, line: 1 }} /> },
        ]}
      />
    </div>
  );
}

/* ----------------------------------------------------- Behavior & security */

function Security(d: D) {
  const sm = d.securityModel;
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  const count = (pred: (k: EntryPoint["control"]["kind"]) => boolean) => routes.filter((r) => pred(r.control.kind)).length;
  return (
    <div className="space-y-8">
      <SectionHeader title="Auth and security model" intro="How the project signs people in, checks what they may do, and protects itself. Anything we looked for and didn't find says where we looked." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Protected endpoints" value={count((k) => PROTECTED.has(k))} />
        <Stat label="Public by design" value={count((k) => k === "public_intentional")} />
        <Stat label="No protection found" value={count((k) => k === "none_found")} />
        <Stat label="Undetermined" value={count((k) => k === "unknown")} />
      </div>
      <Diagram d={d} k="auth_map" label="Protection map" />
      <div className="space-y-3">
        <SubTitle>How callers prove who they are</SubTitle>
        <DataTable
          rows={sm.authMechanisms}
          rowKey={(m) => `${m.kind}:${m.detail}`}
          empty="No sign-in mechanism, session, token check or guard was found."
          columns={[
            { label: "Mechanism", cell: (m) => <Badge tone="muted">{m.kind.replace(/_/g, " ")}</Badge> },
            { label: "Detail", cell: (m) => m.detail },
            { label: "Where", cell: (m) => <Evidences items={m.evidence} /> },
          ]}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <SubTitle>Guards</SubTitle>
          <DataTable
            rows={sm.guards}
            rowKey={(g) => g.name}
            empty="No guard functions protect endpoints."
            columns={[
              { label: "Guard", cell: (g) => <Mono>{g.name}</Mono> },
              { label: "Endpoints", cell: (g) => g.endpoints, className: "tabular-nums" },
              { label: "Where", cell: (g) => <Evidences items={g.evidence} max={2} /> },
            ]}
          />
        </div>
        <div className="space-y-3">
          <SubTitle>Credential checks</SubTitle>
          <DataTable
            rows={sm.credentialChecks}
            rowKey={(c) => `${c.kind}:${c.detail}`}
            empty="No password or token check was recognised."
            columns={[
              { label: "Check", cell: (c) => c.detail },
              { label: "Where", cell: (c) => <Evidences items={c.evidence} max={2} /> },
            ]}
          />
        </div>
      </div>
      {sm.roles.length > 0 && (
        <div className="space-y-3">
          <SubTitle>Role-like types</SubTitle>
          <p className="text-sm text-fg-muted">Only application roles decide who may do what. The others are listed so they aren&apos;t mistaken for user roles.</p>
          <DataTable
            rows={sm.roles}
            rowKey={(r) => `${r.name}:${r.evidence.path}`}
            empty=""
            columns={[
              { label: "Type", cell: (r) => <Mono>{r.name}</Mono> },
              { label: "Values", cell: (r) => <Mono className="text-fg-muted">{r.values.join(", ")}</Mono> },
              { label: "Kind", cell: (r) => <Badge tone={r.kind === "app_role" ? "info" : "muted"}>{r.kind === "app_role" ? "Application role" : r.kind === "llm_role" ? "AI message role" : "Message direction"}</Badge> },
              { label: "Defined at", cell: (r) => <EvidenceLink evidence={r.evidence} /> },
            ]}
          />
        </div>
      )}
      {sm.notDetected.length > 0 && (
        <div className="space-y-3">
          <SubTitle>Not detected, and where we looked</SubTitle>
          <ul className="space-y-2">
            {sm.notDetected.map((x) => (
              <li key={x.control} className="rounded-xl border border-border px-4 py-3 text-sm">
                <p className="font-medium text-fg">{x.control}</p>
                <p className="mt-1 text-fg-muted">{x.scope}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Facts
        items={[
          ["Password hashing", <List key="p" values={sm.passwordHashing} none="Not detected" />],
          ["Input validation", <List key="v" values={sm.validationLibraries} none="Not detected" />],
          ["Rate limiting", <List key="r" values={sm.rateLimiting} none="Not detected" />],
          ["Security headers", <List key="h" values={sm.securityHeaders} none="Not detected" />],
          ["CSRF protection", <List key="c" values={sm.csrf} none="Not detected" />],
          [
            "CORS",
            sm.cors.length ? (
              <span key="cors" className="flex flex-col items-start gap-1">
                {sm.cors.map((c) => (
                  <span key={`${c.evidence.path}:${c.evidence.line}`} className="flex flex-wrap items-center gap-2">
                    <EvidenceLink evidence={c.evidence} />
                    {c.allowsAnyOrigin && <Badge tone="warn">Any origin</Badge>}
                  </span>
                ))}
              </span>
            ) : (
              "Not configured"
            ),
          ],
        ]}
      />
    </div>
  );
}

function Integrations(d: D) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Integrations" intro="Third-party services the code talks to, and where it calls them." />
      <Diagram d={d} k="integrations" label="Integration map" />
      <DataTable
        rows={d.integrations}
        rowKey={(i) => i.name}
        searchText={(i) => `${i.name} ${i.category} ${i.packages.join(" ")} ${i.hosts.join(" ")}`}
        searchLabel="Search services"
        filters={[...new Set(d.integrations.map((i) => i.category))].map((c) => ({ id: c, label: c, test: (i: D["integrations"][number]) => i.category === c }))}
        empty="No third-party integrations were found."
        columns={[
          { label: "Service", cell: (i) => <span className="font-medium">{i.name}</span> },
          { label: "Category", cell: (i) => <Badge tone="muted">{i.category}</Badge> },
          { label: "Via", cell: (i) => <Mono className="text-fg-muted">{[...i.packages, ...i.hosts].join(", ") || "n/a"}</Mono> },
          { label: "Used in", cell: (i) => <Evidences items={i.usedIn} /> },
        ]}
      />
    </div>
  );
}

function AiComponents(d: D) {
  return (
    <div className="space-y-6">
      <SectionHeader title="AI components" intro="Where the project calls AI models, which tools those models can use, and the instructions they get." />
      {d.aiComponents.length === 0 ? (
        <Empty>No AI model calls were found. The AI Evaluator check doesn&apos;t apply to this snapshot.</Empty>
      ) : (
        d.aiComponents.map((a) => (
          <div key={a.sdk} className="space-y-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Bot className="size-4 text-accent" aria-hidden="true" />
              <p className="font-medium text-fg">{a.sdk}</p>
              <Badge tone="muted">{a.calls.length} calls</Badge>
              {a.toolDefinitions.length > 0 && <Badge tone="warn">Model can call tools</Badge>}
            </div>
            <DataTable
              rows={a.calls}
              rowKey={(c) => `${c.evidence.path}:${c.evidence.line}`}
              empty="No calls."
              columns={[
                { label: "API", cell: (c) => <Mono>{c.api}</Mono> },
                { label: "Model", cell: (c) => (c.model ? <Mono>{c.model}</Mono> : <span className="text-fg-muted">set elsewhere</span>) },
                { label: "Where", cell: (c) => <EvidenceLink evidence={c.evidence} /> },
              ]}
            />
            {a.toolDefinitions.length > 0 && (
              <div className="text-sm">
                <p className="mb-1 text-fg-muted">Tool definitions</p>
                <Evidences items={a.toolDefinitions} max={10} />
              </div>
            )}
            {a.systemPrompts.map((p) => (
              <div key={`${p.evidence.path}:${p.evidence.line}`} className="rounded-lg bg-surface-2/60 p-3 text-sm">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
                  System prompt <EvidenceLink evidence={p.evidence} />
                </div>
                <p className="font-mono text-xs break-words text-fg">{p.preview}</p>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function Background(d: D) {
  return (
    <div className="space-y-6">
      <SectionHeader title="Background work" intro="Scheduled jobs, queues, workers and event handlers that run outside a request." />
      <DataTable
        rows={d.background}
        rowKey={(b) => `${b.evidence.path}:${b.evidence.line}:${b.name}`}
        empty="No background jobs, queues or schedules were found."
        columns={[
          { label: "Kind", cell: (b) => <Badge tone="muted">{b.kind}</Badge> },
          { label: "Name", cell: (b) => <Mono>{b.name}</Mono> },
          {
            label: "Schedule",
            cell: (b) => (
              <span className="flex flex-col items-start gap-0.5">
                {b.resolvedSchedule ? <Mono>{b.resolvedSchedule}{b.timezone ? ` (${b.timezone})` : ""}</Mono> : b.schedule ? <Badge tone="warn">Not resolved</Badge> : <span className="text-fg-muted">n/a</span>}
                {b.scheduleNote && <span className="text-xs text-fg-muted">{b.scheduleNote}</span>}
                {b.schedule && b.schedule !== b.resolvedSchedule && <Mono className="text-fg-muted">as written: {b.schedule}</Mono>}
              </span>
            ),
          },
          { label: "Runs", cell: (b) => (b.handler ? <Mono>{b.handler}()</Mono> : <span className="text-fg-muted">n/a</span>) },
          { label: "Library", cell: (b) => b.library },
          { label: "Where", cell: (b) => <EvidenceLink evidence={b.evidence} /> },
        ]}
      />
    </div>
  );
}

/* -------------------------------------------------------------- Operations */

function Infrastructure(d: D) {
  const dep = d.deployment;
  return (
    <div className="space-y-8">
      <SectionHeader title="Infrastructure" intro="How the project is built, packaged and deployed, as declared in its files." />
      <Diagram d={d} k="deployment" label="Deployment diagram" />
      <div className="space-y-3">
        <SubTitle>Containers and services</SubTitle>
        <DataTable
          rows={dep.containers}
          rowKey={(c) => c.id}
          empty="No container or compose definitions were found."
          columns={[
            { label: "Service", cell: (c) => <span className="font-medium">{c.name}</span> },
            { label: "Compose file", cell: (c) => <Mono className="text-fg-muted">{c.file}</Mono> },
            { label: "Image or build", cell: (c) => <Mono>{c.image ?? c.build ?? "n/a"}</Mono> },
            { label: "Published ports", cell: (c) => <Mono>{c.ports.join(", ") || "none"}</Mono> },
            { label: "Internal ports", cell: (c) => <Mono>{c.exposes.join(", ") || "none"}</Mono> },
            { label: "Depends on", cell: (c) => c.dependsOn.join(", ") || <span className="text-fg-muted">nothing</span> },
            { label: "Defined at", cell: (c) => <EvidenceLink evidence={c.evidence} /> },
          ]}
        />
      </div>
      {dep.dockerfiles.length > 0 && (
        <div className="space-y-3">
          <SubTitle>Dockerfiles</SubTitle>
          <DataTable
            rows={dep.dockerfiles}
            rowKey={(f) => f.path}
            empty=""
            columns={[
              { label: "File", cell: (f) => <EvidenceLink evidence={{ path: f.path, line: 1 }} /> },
              { label: "Base images", cell: (f) => <Mono>{f.baseImages.join(", ")}</Mono> },
              { label: "Exposes", cell: (f) => <Mono>{f.exposes.join(", ") || "n/a"}</Mono> },
              { label: "Starts with", cell: (f) => <Mono className="text-fg-muted">{f.cmd ?? "n/a"}</Mono> },
            ]}
          />
        </div>
      )}
      {dep.ci.length > 0 && (
        <div className="space-y-3">
          <SubTitle>CI/CD pipelines</SubTitle>
          <ul className="space-y-2">
            {dep.ci.map((c) => (
              <li key={c.path} className="rounded-xl border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">{c.provider}</Badge>
                  <EvidenceLink evidence={{ path: c.path, line: 1 }} />
                </div>
                <p className="mt-2 text-fg-muted">
                  Jobs: {c.jobs.map((j) => `${j.name} (${j.steps.length} steps)`).join(", ") || "none"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(dep.platforms.length > 0 || dep.infraResources.length > 0) && (
        <Facts
          items={[
            ["Deployment platforms", dep.platforms.length ? dep.platforms.map((p) => p.name).join(", ") : "None detected"],
            ["Infrastructure as code", dep.infraResources.length ? `${dep.infraResources.length} resources (${[...new Set(dep.infraResources.map((r) => r.type))].slice(0, 6).join(", ")})` : "None detected"],
          ]}
        />
      )}
    </div>
  );
}

function Configuration(d: D) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Configuration"
        intro="Environment variables the code and deployment files read. Only names are shown: values are never read, and secret files were left out of the snapshot."
      />
      <DataTable
        rows={d.config.envVars}
        rowKey={(e) => e.id}
        searchText={(e) => `${e.name} ${e.readVia.join(" ")}`}
        searchLabel="Search variables"
        filters={[
          { id: "required", label: "Required", test: (e) => e.required === true },
          { id: "secret", label: "Secret", test: (e) => e.sensitivity === "secret" },
          { id: "browser", label: "In the browser", test: (e) => e.side === "browser" },
          { id: "undocumented", label: "Not documented", test: (e) => e.usedIn.length > 0 && !e.documented },
          { id: "unused", label: "Never read", test: (e) => e.usedIn.length === 0 },
        ]}
        empty="No environment variables were found."
        columns={[
          { label: "Variable", cell: (e) => <Mono>{e.name}</Mono> },
          { label: "Required", cell: (e) => (e.required === true ? <Badge tone="warn">Required</Badge> : e.required === false ? <span className="text-fg-muted">{e.defaultValue != null ? <>Default <Mono>{e.defaultValue || '""'}</Mono></> : e.hasDefault ? "Has default" : "Optional"}</span> : <span className="text-fg-muted">Unknown</span>) },
          { label: "Kind", cell: (e) => <span className="flex flex-wrap gap-1">{e.sensitivity === "secret" && <Badge tone="bad">Secret</Badge>}<Badge tone="muted">{e.side === "browser" ? "Browser" : e.side === "deploy" ? "Deployment" : "Server"}</Badge></span> },
          { label: "Documented", cell: (e) => (e.documented ? <Badge tone="good">Yes</Badge> : <Badge tone="warn">No</Badge>) },
          { label: "Read in", cell: (e) => (e.usedIn.length ? <Evidences items={e.usedIn} max={2} /> : <span className="text-fg-muted">Never read</span>) },
        ]}
      />
    </div>
  );
}

function Dependencies(d: D) {
  return (
    <div className="space-y-6">
      <SectionHeader title="Dependencies" intro="Direct packages from the manifests, with the exact version locked when a lockfile exists. The Security check looks these up for known vulnerabilities." />
      <DataTable
        rows={d.dependencies}
        rowKey={(x) => `${x.manifest}:${x.ecosystem}:${x.name}`}
        searchText={(x) => `${x.name} ${x.manifest}`}
        searchLabel="Search packages"
        filters={[
          { id: "prod", label: "Runtime", test: (x) => !x.dev },
          { id: "dev", label: "Development", test: (x) => x.dev },
          { id: "unlocked", label: "Not locked", test: (x) => !x.resolved },
        ]}
        empty="No dependencies were found."
        columns={[
          { label: "Package", cell: (x) => <Mono>{x.name}</Mono> },
          { label: "Declared", cell: (x) => <Mono className="text-fg-muted">{x.declared}</Mono> },
          { label: "Locked", cell: (x) => (x.resolved ? <Mono>{x.resolved}</Mono> : <span className="text-fg-muted">n/a</span>) },
          { label: "Type", cell: (x) => <Badge tone="muted">{x.ecosystem}{x.dev ? " dev" : ""}</Badge> },
          { label: "Manifest", cell: (x) => <Mono className="text-fg-muted">{x.manifest}</Mono> },
        ]}
      />
    </div>
  );
}

function Quality(d: D) {
  const q = d.quality;
  return (
    <div className="space-y-8">
      <SectionHeader title="Quality and tests" intro="Which parts of the code have tests, plus the files that are hardest to change safely." />
      <Diagram d={d} k="test_map" label="Test map" />
      <Facts
        items={[
          ["Test files", `${n(q.testFiles)}${q.testFrameworks.length ? ` (${q.testFrameworks.join(", ")})` : ""}`],
          ["Logging", <List key="l" values={q.logging} />],
          ["Error tracking", <List key="e" values={q.errorTracking} />],
          ["TODO and FIXME notes", n(q.todoCount)],
        ]}
      />
      <div className="space-y-3">
        <SubTitle>Complexity hotspots</SubTitle>
        <DataTable
          rows={q.hotspots}
          rowKey={(h) => h.path}
          empty="No unusually complex files were found."
          columns={[
            { label: "File", cell: (h) => <EvidenceLink evidence={{ path: h.path, line: 1 }} /> },
            { label: "Lines", cell: (h) => n(h.loc), className: "tabular-nums" },
            { label: "Branches", cell: (h) => n(h.complexity), className: "tabular-nums" },
          ]}
        />
      </div>
    </div>
  );
}

function HowToRun(d: D) {
  const rp = d.runPlan;
  return (
    <div className="space-y-6">
      <SectionHeader title="How to run" intro="The run plan as the project declares it. Nothing has been run yet; checks run it later inside an isolated sandbox." />
      <DataTable
        rows={rp.workspaces}
        rowKey={(w) => `${w.dir}:${w.packageManager}`}
        empty="No package manifests were found."
        columns={[
          { label: "Directory", cell: (w) => <Mono>{w.dir}</Mono> },
          { label: "Install", cell: (w) => <Mono>{w.install ?? "n/a"}</Mono> },
          { label: "Build", cell: (w) => (w.build ? <Mono>{w.build}</Mono> : <span className="text-fg-muted">none</span>) },
          { label: "Test", cell: (w) => (w.test ? <Mono>{w.test}</Mono> : <span className="text-fg-muted">none</span>) },
          { label: "Start", cell: (w) => (w.start ?? w.dev ? <Mono>{w.start ?? w.dev}</Mono> : <span className="text-fg-muted">none</span>) },
        ]}
      />
      <Facts
        items={[
          ["Ports", rp.ports.length ? rp.ports.map((p) => `${p.port} (${p.note})`).join(", ") : "Not declared"],
          ["Required at startup", <List key="r" values={[...rp.requiredEnv, ...rp.requiredOneOf.map((g) => `one of ${g.join(" or ")}`)]} none="None found" />],
          ["Runtimes", [...new Map(rp.runtimes.map((r) => [`${r.name} ${r.version ?? ""}`, r])).values()].map((r) => `${r.name} ${r.version ?? ""} (${r.source})`).join(", ") || "Not declared"],
        ]}
      />
      {rp.notes.length > 0 && (
        <ul className="space-y-2">
          {rp.notes.map((x) => (
            <li key={x.note} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-border px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 text-fg">{x.note}</span>
              {x.evidence.length > 0 && <Evidences items={x.evidence} max={1} />}
            </li>
          ))}
        </ul>
      )}
      <SubTitle>All declared scripts</SubTitle>
      <DataTable
        rows={d.runCommands}
        rowKey={(r) => `${r.source}:${r.name}`}
        searchText={(r) => `${r.name} ${r.command}`}
        searchLabel="Search commands"
        empty="No run, build or test commands were declared."
        columns={[
          { label: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
          { label: "Command", cell: (r) => <Mono>{r.command}</Mono> },
          { label: "Declared in", cell: (r) => <Mono className="text-fg-muted">{r.source}</Mono> },
        ]}
      />
    </div>
  );
}

/* ---------------------------------------------------- About this analysis */

function Coverage(d: D) {
  const c = d.coverage;
  return (
    <div className="space-y-6">
      <SectionHeader title="Coverage and limits" intro="What was read and what wasn't, so you know how far to trust this page. Every file is counted exactly once." />
      <Facts
        items={[
          ["Files parsed as source code", `${n(c.filesParsed)} of ${n(c.filesTotal)}`],
          ["Analyzer version", <Mono key="v">{d.meta.analyzerVersion}</Mono>],
          ["Analysis took", `${(d.meta.durationMs / 1000).toFixed(1)} s`],
          ["Snapshot fingerprint", <Mono key="d">{d.meta.contentDigest.slice(0, 19)}</Mono>],
        ]}
      />
      <DataTable
        rows={c.categories}
        rowKey={(x) => x.id}
        empty="No files."
        columns={[
          { label: "Category", cell: (x) => x.label },
          { label: "Files", cell: (x) => n(x.count), className: "tabular-nums" },
          { label: "Examples", cell: (x) => <Mono className="text-fg-muted">{x.examples.slice(0, 4).join(", ")}{x.count > 4 ? ", ..." : ""}</Mono> },
        ]}
      />
      <p className="text-xs text-fg-muted tabular-nums">Total: {n(c.categories.reduce((s, x) => s + x.count, 0))} of {n(c.filesTotal)} files accounted for.</p>
      <p className="text-sm text-fg-muted">
        Static analysis can miss code that is generated at runtime, loaded dynamically or configured outside the repository. Checks
        confirm behavior by running the project in a sandbox.
      </p>
    </div>
  );
}

export const SECTION_GROUPS: Array<{ label: string; sections: SectionDef[] }> = [
  {
    label: "Overview",
    sections: [
      { id: "summary", label: "Summary", icon: LayoutDashboard, render: Summary },
      { id: "observations", label: "Things to check", icon: ShieldAlert, count: (d) => d.observations.length, render: Observations },
      { id: "questions", label: "Open questions", icon: CircleHelp, count: (d) => d.questions.length, render: Questions },
    ],
  },
  {
    label: "Meaning (AI)",
    sections: [
      { id: "purpose", label: "What it does", icon: Sparkles, render: Purpose },
      { id: "dataflow", label: "Data flow", icon: Workflow, count: (d) => d.ai?.dataFlows.length ?? 0, render: DataFlows },
      { id: "states", label: "State machines", icon: GitBranch, count: (d) => d.ai?.stateMachines.length ?? 0, render: States },
      { id: "sequences", label: "Key flows", icon: ListOrdered, count: (d) => d.ai?.sequences.length ?? 0, render: Sequences },
      { id: "risks", label: "Risks", icon: ShieldAlert, count: (d) => d.ai?.risks.length ?? 0, render: Risks },
      { id: "aisurface", label: "AI surface", icon: Bot, render: AiSurfaceSection },
    ],
  },
  {
    label: "Structure",
    sections: [
      { id: "structure", label: "Code structure", icon: Network, count: (d) => d.modules.length, render: Structure },
      { id: "data", label: "Data structures", icon: Database, count: (d) => d.dataModel.entities.length, render: DataStructures },
      { id: "types", label: "Domain types", icon: Blocks, count: (d) => d.domainTypes.length, render: DomainTypes },
      { id: "apis", label: "API and payloads", icon: Route, count: (d) => d.entryPoints.filter((e) => e.kind !== "page").length, render: Apis },
      { id: "screens", label: "Screens", icon: FileCode2, count: (d) => d.screens.length, render: Screens },
    ],
  },
  {
    label: "Behavior and security",
    sections: [
      { id: "security", label: "Auth and security", icon: KeyRound, render: Security },
      { id: "integrations", label: "Integrations", icon: Plug, count: (d) => d.integrations.length, render: Integrations },
      { id: "ai", label: "AI components", icon: Cpu, count: (d) => d.aiComponents.length, render: AiComponents },
      { id: "background", label: "Background work", icon: Clock, count: (d) => d.background.length, render: Background },
    ],
  },
  {
    label: "Operations",
    sections: [
      { id: "infrastructure", label: "Infrastructure", icon: Server, render: Infrastructure },
      { id: "runtime", label: "Runtime and limits", icon: Gauge, render: Runtime },
      { id: "config", label: "Configuration", icon: Boxes, count: (d) => d.config.envVars.length, render: Configuration },
      { id: "dependencies", label: "Dependencies", icon: Package, count: (d) => d.dependencies.length, render: Dependencies },
      { id: "quality", label: "Quality and tests", icon: FlaskConical, render: Quality },
      { id: "run", label: "How to run", icon: Play, count: (d) => d.runCommands.length, render: HowToRun },
    ],
  },
  {
    label: "About this analysis",
    sections: [
      { id: "coverage", label: "Coverage and limits", icon: Gauge, render: Coverage },
    ],
  },
];

export const SECTIONS: SectionDef[] = SECTION_GROUPS.flatMap((g) => g.sections);
