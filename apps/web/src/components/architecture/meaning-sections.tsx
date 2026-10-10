"use client";

import { Sparkles } from "lucide-react";
import type { AiInsights, Evidence, ProjectDossier } from "@cybercheck/contracts";
import { Spinner } from "@/components/ui/form";
import { CHECK_INFO } from "@/lib/checks";
import { EvidenceLink } from "./code-viewer";
import { MermaidDiagram } from "./mermaid-diagram";
import { Badge, DataTable, Empty, Facts, List, Mono, SectionHeader, SubTitle } from "./parts";

type D = ProjectDossier;

function Evidences({ items, max = 3 }: { items: Evidence[]; max?: number }) {
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

const VERIFY: Record<AiInsights["components"][number]["verification"], { label: string; tone: "good" | "info" | "warn" }> = {
  verified: { label: "Checked against code", tone: "good" },
  relocated: { label: "Checked (line corrected)", tone: "info" },
  unverified: { label: "Not confirmed in code", tone: "warn" },
};
const Verified = ({ v }: { v: keyof typeof VERIFY }) => <Badge tone={VERIFY[v].tone}>{VERIFY[v].label}</Badge>;

/** Wrapper for every AI section: explains when the AI step is missing, running or failed. */
function WithAi({ d, title, intro, children }: { d: D; title: string; intro: string; children: (ai: AiInsights) => React.ReactNode }) {
  const ai = d.ai;
  return (
    <div className="space-y-6">
      <SectionHeader title={title} intro={intro} />
      {!ai ? (
        <Empty>The AI step is not set up for this workspace, so this section is not available. Everything else on this page comes from the code itself.</Empty>
      ) : ai.status === "running" ? (
        <div className="flex items-start gap-3 rounded-xl border border-border p-4 text-sm" role="status">
          <Spinner className="mt-0.5 text-accent" />
          <div>
            <p className="font-medium text-fg">The AI step is reading the code</p>
            <p className="mt-1 text-fg-muted">This takes a few minutes. Every claim it makes is checked against the code before it appears here.</p>
          </div>
        </div>
      ) : ai.status === "failed" ? (
        <Empty>{ai.error ?? "The AI step did not finish."}</Empty>
      ) : (
        <>
          {ai.status === "partial" && <p className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-fg">{ai.error ?? "The AI step stopped early; this section may be incomplete."}</p>}
          {children(ai)}
        </>
      )}
    </div>
  );
}

export function Purpose(d: D) {
  return (
    <WithAi d={d} title="What it does" intro="A plain-language explanation of the product, its users and its parts, written by AI from the verified facts. Each part links to the code it describes.">
      {(ai) => (
        <div className="space-y-8">
          {ai.purpose && (
            <div className="space-y-3">
              <p className="max-w-3xl text-base leading-relaxed text-fg">{ai.purpose.summary}</p>
              <Facts
                items={[
                  ["Who uses it", ai.purpose.users.map((u) => `${u.name}: ${u.description}`).join(" · ") || "Not stated"],
                  ["Main features", <List key="f" values={ai.purpose.mainFeatures} none="Not stated" />],
                ]}
              />
            </div>
          )}
          {d.diagrams.context && <MermaidDiagram code={d.diagrams.context} label="System context" />}
          <div className="space-y-3">
            <SubTitle>Components</SubTitle>
            <DataTable
              rows={ai.components}
              rowKey={(c) => c.id}
              empty="No components were described."
              columns={[
                { label: "Component", cell: (c) => <span className="font-medium">{c.name}</span> },
                { label: "Responsibility", cell: (c) => <span className="text-sm">{c.responsibility}</span> },
                { label: "Data it handles", cell: (c) => <span className="text-xs text-fg-muted">{c.dataHandled.join(", ") || "n/a"}</span> },
                { label: "Evidence", cell: (c) => <span className="flex flex-col items-start gap-1"><Verified v={c.verification} /><Evidences items={c.evidence} max={2} /></span> },
              ]}
            />
          </div>
          {ai.designNotes.length > 0 && (
            <div className="space-y-3">
              <SubTitle>Design notes</SubTitle>
              <ul className="space-y-2">
                {ai.designNotes.map((n) => (
                  <li key={n.id} className="rounded-xl border border-border px-4 py-3 text-sm">
                    <p className="font-medium text-fg">{n.title}</p>
                    <p className="mt-1 text-fg-muted">{n.note}</p>
                    <div className="mt-2"><Evidences items={n.evidence} max={2} /></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AiFootnote ai={ai} />
        </div>
      )}
    </WithAi>
  );
}

export function DataFlows(d: D) {
  return (
    <WithAi d={d} title="Data flow and trust boundaries" intro="Where data enters, where it goes and which boundaries it crosses. Red lines carry secrets, amber lines carry personal data.">
      {(ai) => (
        <div className="space-y-8">
          {d.diagrams.data_flow && <MermaidDiagram code={d.diagrams.data_flow} label="Data flow" />}
          <DataTable
            rows={ai.dataFlows}
            rowKey={(f) => f.id}
            searchText={(f) => `${f.from} ${f.to} ${f.data.join(" ")} ${f.boundary ?? ""}`}
            searchLabel="Search flows"
            filters={[
              { id: "personal", label: "Personal data", test: (f) => f.sensitivity === "personal" },
              { id: "secret", label: "Secrets", test: (f) => f.sensitivity === "secret" },
              { id: "boundary", label: "Crosses a boundary", test: (f) => Boolean(f.boundary) },
            ]}
            empty="No data flows were described."
            columns={[
              { label: "From", cell: (f) => f.from },
              { label: "To", cell: (f) => f.to },
              { label: "Data", cell: (f) => <span className="flex flex-col items-start gap-1">{f.sensitivity !== "none" && <Badge tone={f.sensitivity === "secret" ? "bad" : "warn"}>{f.sensitivity}</Badge>}<span className="text-xs text-fg-muted">{f.data.join(", ")}</span></span> },
              { label: "Boundary", cell: (f) => f.boundary ?? <span className="text-fg-muted">none</span> },
              { label: "Evidence", cell: (f) => <Evidences items={f.evidence} max={2} /> },
            ]}
          />
          {ai.trustBoundaries.length > 0 && (
            <div className="space-y-3">
              <SubTitle>Trust boundaries</SubTitle>
              <ul className="grid gap-3 sm:grid-cols-2">
                {ai.trustBoundaries.map((b) => (
                  <li key={b.id} className="rounded-xl border border-border px-4 py-3 text-sm">
                    <p className="font-medium text-fg">{b.name}</p>
                    <p className="mt-1 text-fg-muted">{b.description}</p>
                    <div className="mt-2"><Evidences items={b.evidence} max={2} /></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </WithAi>
  );
}

export function States(d: D) {
  return (
    <WithAi d={d} title="State machines" intro="How status fields change, and what triggers each change. The Testing check uses these to test invalid transitions.">
      {(ai) =>
        ai.stateMachines.length ? (
          <div className="space-y-8">
            {ai.stateMachines.map((m) => (
              <div key={m.id} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SubTitle>
                    {m.entity}.{m.field}
                  </SubTitle>
                  <Verified v={m.verification} />
                  <Evidences items={m.evidence} max={2} />
                </div>
                {d.diagrams[`state:${m.id}`] && <MermaidDiagram code={d.diagrams[`state:${m.id}`]!} label={`${m.entity}.${m.field} states`} />}
              </div>
            ))}
          </div>
        ) : (
          <Empty>No state fields with transitions were found.</Empty>
        )
      }
    </WithAi>
  );
}

export function Sequences(d: D) {
  return (
    <WithAi d={d} title="Key flows" intro="Step by step, what happens in the most important user and system flows.">
      {(ai) =>
        ai.sequences.length ? (
          <div className="space-y-8">
            {ai.sequences.map((s) => (
              <div key={s.id} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SubTitle>{s.name}</SubTitle>
                  <Verified v={s.verification} />
                </div>
                {d.diagrams[`sequence:${s.id}`] && <MermaidDiagram code={d.diagrams[`sequence:${s.id}`]!} label={s.name} />}
                <Evidences items={s.evidence} max={3} />
              </div>
            ))}
          </div>
        ) : (
          <Empty>No flows were described.</Empty>
        )
      }
    </WithAi>
  );
}

const IMPACT = { high: "bad", medium: "warn", low: "info" } as const;

export function Risks(d: D) {
  return (
    <WithAi d={d} title="Risks" intro="Specific ways this project could be attacked or fail, each tied to the code, reviewed by a second AI model, and assigned to the check that tests it.">
      {(ai) => (
        <div className="space-y-4">
          {ai.risks.length === 0 ? (
            <Empty>No risks were confirmed.</Empty>
          ) : (
            <ul className="space-y-3">
              {ai.risks.map((r) => {
                const check = CHECK_INFO[r.testedBy];
                return (
                  <li key={r.id} className="rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={IMPACT[r.impact]}>{r.impact} impact</Badge>
                      <Badge tone="muted">{r.category.replace(/_/g, " ")}</Badge>
                      <p className="min-w-0 font-medium text-fg">{r.title}</p>
                    </div>
                    <p className="mt-2 text-sm text-fg-muted">{r.description}</p>
                    {r.affected.length > 0 && <p className="mt-2 text-xs text-fg-muted">Affects: {r.affected.join(", ")}</p>}
                    <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                      <Evidences items={r.evidence} max={3} />
                      <span className="flex flex-col items-end gap-1 text-xs text-fg-muted">
                        <span className="inline-flex items-center gap-1.5"><check.icon className="size-3.5 text-accent" aria-hidden="true" /> Tested by the {check.name} check</span>
                        <span>Second review: {r.critic.verdict === "supported" ? "confirmed" : r.critic.verdict === "partly_supported" ? "partly confirmed" : "not reviewed"}{r.critic.note ? `. ${r.critic.note}` : ""}</span>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {ai.verification.droppedByCritic > 0 && <p className="text-xs text-fg-muted">{ai.verification.droppedByCritic} more risks were suggested but removed because the second review found the code does not support them.</p>}
        </div>
      )}
    </WithAi>
  );
}

export function AiSurfaceSection(d: D) {
  return (
    <WithAi d={d} title="AI surface" intro="Which AI providers the project calls, what goes into its prompts (including personal data), and how failures and model output are handled. The AI Evaluator check starts from this.">
      {(ai) =>
        ai.aiSurface ? (
          <div className="space-y-6">
            <Facts
              items={[
                ["Providers", ai.aiSurface.providers.map((p) => `${p.name}: ${p.role}`).join(" · ") || "None"],
                ["When a provider fails", ai.aiSurface.fallbacks ?? "Not described"],
                ["How output is used", ai.aiSurface.outputHandling ?? "Not described"],
              ]}
            />
            <DataTable
              rows={ai.aiSurface.prompts}
              rowKey={(p) => p.name}
              empty="No prompts were described."
              columns={[
                { label: "Prompt", cell: (p) => <span className="font-medium">{p.name}</span> },
                { label: "Purpose", cell: (p) => <span className="text-sm">{p.purpose}</span> },
                { label: "Inputs", cell: (p) => <span className="text-xs text-fg-muted">{p.inputs.join(", ")}</span> },
                { label: "Personal data", cell: (p) => (p.personalData.length ? <span className="text-xs text-warning">{p.personalData.join(", ")}</span> : <span className="text-fg-muted">none</span>) },
                { label: "Where", cell: (p) => <Evidences items={p.evidence} max={2} /> },
              ]}
            />
          </div>
        ) : (
          <Empty>No AI features were described. If the project has none, the AI Evaluator check does not apply.</Empty>
        )
      }
    </WithAi>
  );
}

function AiFootnote({ ai }: { ai: AiInsights }) {
  const v = ai.verification;
  return (
    <p className="flex items-start gap-2 text-xs text-fg-muted">
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" />
      Written by {ai.models.fast.split("/").at(-1)} and {ai.models.strong.split("/").at(-1)}, reviewed by {ai.models.critic.split("/").at(-1)}. {v.verified + v.relocated} of {v.claims} claims were confirmed in the code{v.unverified ? `, ${v.unverified} could not be confirmed and are marked` : ""}. Cost ${ai.usage.costUsd.toFixed(2)}.
    </p>
  );
}

/* --------------------------------------------------------------- Runtime facts (from code) */

export function Runtime(d: D) {
  const r = d.runtime;
  return (
    <div className="space-y-8">
      <SectionHeader title="Runtime and limits" intro="Behaviour that is set in code and configuration: uploads, sessions, size limits, outgoing calls, the proxy in front, and how the project is built and published." />
      {r.uploads.length > 0 && (
        <div className="space-y-3">
          <SubTitle>File uploads</SubTitle>
          <DataTable
            rows={r.uploads}
            rowKey={(u) => u.endpoint ?? u.library}
            empty=""
            columns={[
              { label: "Endpoint", cell: (u) => <Mono>{u.endpoint ?? "any"}</Mono> },
              { label: "Limits", cell: (u) => <span className="text-xs">{Object.entries(u.limits).map(([k, v]) => `${k}: ${v}`).join(", ") || "none found"}</span> },
              { label: "Stored in", cell: (u) => <Mono className="text-fg-muted">{u.storage ?? "unknown"}</Mono> },
              { label: "Content type", cell: (u) => (u.contentTypeFromClient ? <Badge tone="warn">Chosen by the uploader</Badge> : u.contentTypeFromClient === false ? <span className="text-fg-muted">Set by the server</span> : <span className="text-fg-muted">Unknown</span>) },
              { label: "Where", cell: (u) => <Evidences items={u.evidence} max={2} /> },
            ]}
          />
        </div>
      )}
      <Facts
        items={[
          ["Session", r.session ? `${r.session.library}, ${r.session.storage === "cookie" ? "kept entirely in an encrypted cookie (cannot be revoked on the server)" : r.session.storage === "server" ? "stored on the server" : "storage unknown"}; stores ${r.session.keys.join(", ") || "nothing recognised"}` : "No session found"],
          ["Session cookie", r.session ? Object.entries(r.session.cookie).map(([k, v]) => `${k}=${v}`).join(", ") : "n/a"],
          ["Request limits", r.limits.map((l) => `${l.name}: ${l.value}`).join(" · ") || "None found"],
          ["Global error handler", r.errorHandling.globalHandler ? "Yes" : "Not found (framework default)"],
          ["Reverse proxy", r.reverseProxy ? `${r.reverseProxy.file}: ${r.reverseProxy.sites.join(", ")} to ${r.reverseProxy.upstreams.join(", ")}${r.reverseProxy.directives.length ? ` (directives: ${r.reverseProxy.directives.join(", ")})` : ""}` : "None in the repository"],
          ["Frontend", r.frontend ? `${r.frontend.basename ? `served under ${r.frontend.basename}; ` : ""}${r.frontend.apiClient ? `API client ${r.frontend.apiClient.file} sends cookies${r.frontend.apiClient.on401 ? ` and ${r.frontend.apiClient.on401} on 401` : ""}` : "no shared API client found"}${r.frontend.thirdPartyAssets.length ? `; loads ${r.frontend.thirdPartyAssets.map((a) => a.host).join(", ")}` : ""}` : "No separate frontend"],
        ]}
      />
      <div className="space-y-3">
        <SubTitle>Outgoing HTTP calls</SubTitle>
        <DataTable
          rows={r.outboundCalls}
          rowKey={(c) => `${c.evidence.path}:${c.evidence.line}`}
          filters={[{ id: "no-timeout", label: "No timeout", test: (c) => !c.timeout }]}
          empty="No outgoing HTTP calls were found."
          columns={[
            { label: "Target", cell: (c) => <Mono>{c.target}</Mono> },
            { label: "Timeout", cell: (c) => (c.timeout ? <Badge tone="good">Set</Badge> : <Badge tone="warn">None</Badge>) },
            { label: "Where", cell: (c) => <EvidenceLink evidence={c.evidence} /> },
          ]}
        />
      </div>
      <div className="space-y-3">
        <SubTitle>Build and publishing</SubTitle>
        <Facts
          items={[
            ["Container images", r.supplyChain.images.map((i) => `${i.image}${i.pinned ? "" : " (not pinned)"}`).join(", ") || "None"],
            ["Install commands", r.supplyChain.installs.map((i) => `${i.command}${i.locked ? "" : " (does not enforce the lockfile)"}`).join(", ") || "None in Dockerfiles"],
            ["CI", r.supplyChain.ci.map((c) => `${c.path}: ${[c.runsTests ? "tests" : null, c.runsTypecheck ? "type check" : null, c.runsLint ? "lint" : null].filter(Boolean).join(", ") || "no tests, type check or lint"}${c.publishes ? `; publishes to ${c.publishes}` : ""}`).join(" · ") || "None"],
            ["Instructions for AI coding agents", r.agentInstructionFiles.length ? `${r.agentInstructionFiles.length} files (treated as untrusted data)` : "None"],
          ]}
        />
      </div>
    </div>
  );
}
