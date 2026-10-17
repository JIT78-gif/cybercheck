import type { BrowserScreen, DatabaseStrategy, InventoryAsset, Obligation, ProjectDossier, TestingReport, TestRequirement } from "@cybercheck/contracts";
import { isDecisive, statusOnlyBusiness } from "./assurance.ts";

// The behaviour-first report sections (the 9+/10 plan, section 6): what was discovered and what was really
// executed, the requirements and their sources, how strong the proof is, and how screens and data were reached.

/** Everything discovered in the project, and whether a check with a verdict reached it. */
export function inventoryOf(d: ProjectDossier, obs: Obligation[], screensFound: BrowserScreen[] = []): InventoryAsset[] {
  const decisiveRefs = new Set(obs.filter(isDecisive).map((o) => o.asset.ref));
  const decisiveLabels = new Set(obs.filter(isDecisive).map((o) => o.asset.label));
  const executed = (...keys: string[]) => keys.some((k) => decisiveRefs.has(k) || decisiveLabels.has(k));
  const out: InventoryAsset[] = [];
  for (const e of d.entryPoints.filter((x) => x.kind === "http" || x.kind === "webhook")) {
    out.push({ id: `endpoint:${e.method} ${e.path}`, kind: "endpoint", label: `${e.method} ${e.path}`, location: e.handler, discoveredBy: `${e.framework} route`, executed: executed(e.id, `${e.method} ${e.path}`) });
  }
  for (const s of d.screens) {
    const found = screensFound.find((f) => f.path === s.url);
    out.push({ id: `screen:${s.url}`, kind: "screen", label: s.url, location: found?.location ?? { path: s.file, line: 1 }, discoveredBy: found ? `served by the backend (${found.source.replace("_", " ")})` : `${s.framework} page`, executed: executed(s.route, s.url) });
  }
  for (const en of d.dataModel.entities) {
    out.push({ id: `entity:${en.table ?? en.name}`, kind: "entity", label: en.table ?? en.name, location: en.evidence, discoveredBy: en.source, executed: executed(en.id, en.table ?? en.name) });
    for (const r of en.relations) out.push({ id: `relationship:${en.table ?? en.name}->${r.to}`, kind: "relationship", label: `${en.table ?? en.name} -> ${r.to}${r.field ? ` (${r.field})` : ""}`, location: en.evidence, discoveredBy: en.source, executed: obs.some((o) => isDecisive(o) && o.layer === "data" && (o.asset.ref === en.id || o.asset.label === (en.table ?? en.name))) });
  }
  for (const j of d.background) out.push({ id: `job:${j.name}`, kind: "job", label: j.name, location: j.evidence, discoveredBy: j.kind, executed: executed(j.id, j.name) });
  for (const i of d.integrations) out.push({ id: `integration:${i.name}`, kind: "integration", label: i.name, location: i.usedIn[0] ?? null, discoveredBy: i.category, executed: executed(i.id, i.name) });
  return out;
}

/** How business behaviour was proven: strong (state read back, or the response checked), or by a status code only. */
export function proofSummaryOf(obs: Obligation[]): NonNullable<TestingReport["proofSummary"]> {
  const business = obs.filter((o) => (o.proofClass === "business_behavior" || o.proofClass === "state_change") && isDecisive(o));
  return {
    business: business.length,
    state: business.filter((o) => o.proofLevel === "state" || (o.proofClass === "state_change" && o.stateVerified)).length,
    response: business.filter((o) => o.proofLevel === "response").length,
    statusOnly: business.filter(statusOnlyBusiness).length,
    legacy: business.filter((o) => !o.proofLevel).length,
  };
}

export function behaviourSections(input: { d: ProjectDossier; obligations: Obligation[]; requirements?: TestRequirement[]; screensFound?: BrowserScreen[]; databaseStrategy?: DatabaseStrategy }): Pick<TestingReport, "requirements" | "inventory" | "browserTarget" | "screens" | "databaseStrategy" | "proofSummary"> {
  const served = input.screensFound ?? [];
  return {
    requirements: input.requirements ?? [],
    inventory: inventoryOf(input.d, input.obligations, served),
    browserTarget: served.length ? { kind: "backend_served", appWorkspace: ".", port: 0 } : null,
    screens: served,
    ...(input.databaseStrategy ? { databaseStrategy: input.databaseStrategy } : {}),
    proofSummary: proofSummaryOf(input.obligations),
  };
}
