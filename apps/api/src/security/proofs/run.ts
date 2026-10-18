import { buffer } from "node:stream/consumers";
import type { ProjectDossier, SecurityObligation, SecurityProof } from "@cybercheck/contracts";
import { APP_ROOT, planWorkspaces, slug, wsPath } from "../../testing/adapters.ts";
import { bootGraph, planBoot, type BootApp } from "../../testing/agents.ts";
import { seededAccounts, verifyTarget } from "../../testing/fixtures.ts";
import type { FixtureNode, Probe } from "../../testing/plan.ts";
import { runHarness } from "../../testing/probes.ts";
import { CI_ENV, execute, POLICY, shq, type Ctx } from "../../testing/runtime.ts";
import type { SnapshotSource } from "../../understanding/source.ts";
import { buildCatalog, CANARY, type Hypothesis, type Identity } from "./catalog.ts";
import { ANONYMOUS, compilePlan, type CompiledProof } from "./compiler.ts";
import { readProof, type StepResult } from "./verdict.ts";

// Runs the compiled proof catalogue against the project's own app, booted inside the sandbox with the Testing
// runtime (the single execution authority). No AI. The app is booted once; every proof is a bounded probe sequence;
// the network is off the moment the app is running. Proofs that need a browser or a loopback canary are not executed
// here yet and stay inconclusive with a clear reason.

export type ProofRunResult = {
  proofs: SecurityProof[];
  appBooted: boolean;
  bootNote: string;
  identities: Identity[];
  /** Runtime obligations no proof could exercise, with the reason (the orchestrator marks them not_applicable). */
  notApplicable: Array<{ obligationId: string; reason: string }>;
};

/** Deterministic identities from the accounts the project seeds: two of the first role (for IDOR) plus an admin. */
export function buildIdentities(src: SnapshotSource, login: { method: string; path: string; accountField: string; passwordField: string }, d: ProjectDossier): { identities: Identity[]; nodes: FixtureNode[] } {
  const accounts = seededAccounts(src);
  if (!accounts.length) return { identities: [], nodes: [] };
  const admins = accounts.filter((a) => /admin|superuser|root|owner|staff/i.test(a.role ?? ""));
  const members = accounts.filter((a) => !admins.includes(a));
  const chosen = [...members.slice(0, 2), ...admins.slice(0, 1)];
  const nameOf = (role: string | null, i: number, memberIdx: number) => (admins.some((a) => a.role === role) && role ? "admin" : memberIdx === 0 ? "customer" : `customer-${memberIdx + 1}`);
  const verify = verifyTarget(d, ["session_required"]) ?? verifyTarget(d, []);
  const identities: Identity[] = [];
  const nodes: FixtureNode[] = [];
  let memberIdx = 0;
  for (const a of chosen) {
    const isAdmin = admins.includes(a);
    const name = isAdmin ? "admin" : memberIdx === 0 ? "customer" : `customer-${memberIdx + 1}`;
    if (!isAdmin) memberIdx++;
    void nameOf;
    identities.push({ name, role: a.role, idSymbol: `${name}.id` });
    nodes.push({
      id: name,
      label: `Sign in as ${name}`,
      kind: "identity",
      dependsOn: [],
      auth: { kind: "login", request: { method: login.method, path: login.path, json: { [login.accountField]: a.account, [login.passwordField]: a.password } }, tokenPath: "token" },
      verify,
      appliesTo: ["session_required"],
      // A member identity also yields a tampered-token variant for the forged-token proof.
      ...(isAdmin ? {} : { forge: { role: "admin" } }),
      origin: "plan",
    });
  }
  return { identities, nodes };
}

/** Convert a compiled proof into a harness probe: each step keeps its own identity; anonymous steps send no auth. */
/** A proof changes stored state if any step is a write to something other than the sign-in route (a login attempt,
 * even repeated, does not alter seeded accounts). Such proofs are the ones that can corrupt a later read proof. */
function mutatesState(p: CompiledProof, loginPath: string | undefined): boolean {
  return p.steps.some((s) => {
    const method = s.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    if (method === "POST" && loginPath && s.path.split("?")[0] === loginPath) return false;
    return true;
  });
}

/** Stable partition in place: read-only proofs first, then state-mutating ones, each group in its original order. */
function orderProofs(compiled: CompiledProof[], loginPath: string | undefined): void {
  const reads = compiled.filter((p) => !mutatesState(p, loginPath));
  const writes = compiled.filter((p) => mutatesState(p, loginPath));
  compiled.length = 0;
  compiled.push(...reads, ...writes);
}

function toProbe(p: CompiledProof, i: number): Probe {
  return {
    id: `proof-${i + 1}`,
    obligationId: p.obligationIds[0] ?? "",
    app: ".",
    identity: null,
    needs: [...new Set(p.identities)],
    steps: p.steps.map((s) => ({ method: s.method, path: s.path, headers: s.headers, json: s.json, form: s.form, raw: s.raw, as: s.as === ANONYMOUS ? undefined : s.as, capture: s.capture, expect: (s.expect as Probe["steps"][number]["expect"]) ?? {} })),
  };
}

/** Last step's harness output as a StepResult the verdict reader understands. */
function stepResults(outSteps: Array<{ method: string; path: string; status: number | null; body?: string; location?: string | null; headers?: Record<string, string>; error?: string | null }> | undefined, steps: CompiledProof["steps"]): StepResult[] {
  return (outSteps ?? []).map((o, i) => ({ as: steps[i]?.as ?? ANONYMOUS, method: o.method, path: o.path, status: o.status, text: o.body ?? "", location: o.location ?? null, headers: o.headers ?? {}, error: o.error ?? null }));
}

/** Boot the app in a fresh image with its dependencies installed (no Testing obligations written). */
export async function prepareApp(ctx: Ctx, archive: Buffer, install: { dir: string; command: string } | null, baseImage: string = POLICY.image): Promise<string | null> {
  const base = await ctx.provider.image(baseImage);
  const fileId = await ctx.provider.upload(archive);
  // Plant a synthetic secret file just outside the app directory, so a path-traversal proof can read it (and nothing real).
  const canaryFile = `/work/${CANARY.traversalFile}`;
  const unpack = await execute(ctx, { kind: "security_app", label: "Unpack the app for proving", workspace: null }, { image: base, command: `mkdir -p ${APP_ROOT} && tar xzf /in/snapshot.tgz -C ${APP_ROOT} --no-same-owner && find ${APP_ROOT} -name '*.sh' -exec chmod +x {} + ; printf '%s' '${CANARY.traversalMarker} (synthetic file outside the app directory; do not serve)' > ${canaryFile} ; node --version`, network: false, keep: true, timeoutSec: 300, files: [{ path: "/in/snapshot.tgz", fileId }] });
  let image = unpack.result.resultImage;
  if (!image || unpack.exec.outcome !== "ok") return null;
  if (install) {
    const r = await execute(ctx, { kind: "security_app", label: `Install dependencies (${install.dir})`, workspace: install.dir }, { image, command: `cd ${shq(wsPath(install.dir))} && ${install.command} </dev/null`, network: true, keep: true, timeoutSec: POLICY.installTimeoutSec, env: CI_ENV });
    if (r.exec.outcome === "ok" && r.result.resultImage) image = r.result.resultImage;
    else return null;
  }
  return image;
}

export async function runProofs(ctx: Ctx, d: ProjectDossier, src: SnapshotSource, archive: Buffer, hypotheses: Hypothesis[], obligations: SecurityObligation[], onEvent: (msg: string) => Promise<void>): Promise<ProofRunResult> {
  const workspaces = planWorkspaces(d, src);
  const boot = await planBoot(null, d, src, workspaces);
  const app = boot.apps[0];
  if (!app) return { proofs: [], appBooted: false, bootNote: "No startable app was found to prove against.", identities: [], notApplicable: [] };

  const loginEp = d.entryPoints.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  const accounts = seededAccounts(src);
  const login = loginEp && accounts.length ? { method: loginEp.method, path: loginEp.path, accountField: accounts[0]!.accountField, passwordField: accounts[0]!.passwordField } : null;
  const { identities, nodes: idNodes } = login ? buildIdentities(src, login, d) : { identities: [], nodes: [] };

  const cookieSession = d.securityModel.authMechanisms.some((m) => m.kind === "session") || Boolean(d.runtime.session);
  const catalog = buildCatalog({ dossier: d, identities, sensitiveFields: sensitiveFieldsOf(d), hypotheses, canaryBase: `http://127.0.0.1:${CANARY.port}`, obligations, cookieSession, login: login && accounts[0] ? { ...login, knownEmail: accounts[0].account } : undefined });
  const { proofs: compiled, rejected } = compilePlan(catalog.proofs, d, identities.map((i) => i.name));
  if (rejected.length) await onEvent(`${rejected.length} proof(s) were not run (safety gate): ${rejected.slice(0, 2).map((r) => r.reasons[0]).join("; ")}`);
  if (!compiled.length) return { proofs: [], appBooted: false, bootNote: "No runnable proofs were compiled for this project.", identities, notApplicable: catalog.notApplicable };
  // The harness runs every proof against one shared app with no reset between them, so a proof that changes stored
  // state (e.g. a mass-assignment or CSRF proof that rewrites a seeded account) can invalidate a later read proof
  // that relies on the clean seed, such as account enumeration checking a known email. Run the proofs that only
  // read state (or just sign in) before the ones that change it; the order within each group is left untouched.
  orderProofs(compiled, login?.path);

  const image = await prepareApp(ctx, archive, app.prepare.length || workspaces.find((w) => w.dir === app.workspace)?.install ? { dir: app.workspace, command: workspaces.find((w) => w.dir === app.workspace)?.install?.command ?? "npm install" } : null);
  if (!image) return { proofs: [], appBooted: false, bootNote: "The app could not be prepared in the sandbox.", identities, notApplicable: catalog.notApplicable };

  const graph: FixtureNode[] = [...bootGraph(app, (applies) => verifyTarget(d, applies)), ...idNodes];
  const probes = compiled.map(toProbe);
  await onEvent(`Booting the app and running ${probes.length} runtime proof(s) as ${identities.length} signed-in identit${identities.length === 1 ? "y" : "ies"} (network off)`);
  const r = await runHarness(ctx, image, app, graph, probes, `Prove ${probes.length} security check(s) against the running app`, null, {}, [], CANARY.port);

  const signedIn = new Set((r.out?.identities ?? []).filter((x) => x.ok).map((x) => x.name));
  const canaryHits = new Set(r.out?.canaryHits ?? []);
  const redact = (s: string) => s.replace(/Bearer\s+[\w.-]+/gi, "Bearer [hidden]").slice(0, 200);
  const proofs: SecurityProof[] = [];
  compiled.forEach((p, i) => {
    const probeOut = r.out?.probes.find((x) => x.id === `proof-${i + 1}`);
    const missingId = p.identities.filter((n) => !signedIn.has(n));
    const steps = stepResults(probeOut?.steps, p.steps);
    const ctxP = {
      executionIds: [r.exec.id],
      sensitiveFields: sensitiveFieldsOf(d),
      redactExcerpt: redact,
      traversalMarker: CANARY.traversalMarker,
      canaryHit: p.type === "outbound_request_canary" ? (p.canary ? canaryHits.has(p.canary.token) : false) : undefined,
      // Reflected XSS: the marker comes back inside an unescaped <script> in an HTML response.
      browserMarkerSet: p.type === "browser_script_canary" ? steps.some((s) => /text\/html/i.test(s.headers["content-type"] ?? "") && s.text.includes(`<script>${CANARY.xssMarker}`)) : undefined,
      // Credential logging: the marker sent in the login request later appears in the captured server log.
      loggedCredential: p.type === "log_disclosure" ? r.log.includes(CANARY.logMarker) : undefined,
      commandMarker: p.type === "command_injection" ? CANARY.commandMarker : undefined,
      codeMarker: p.type === "code_injection" ? CANARY.codeMarker : undefined,
    };
    if (probeOut?.blocked || (missingId.length && p.identities.length)) proofs.push(readProof(p, [], ctxP, `P${i + 1}`));
    else proofs.push(readProof(p, steps, ctxP, `P${i + 1}`));
  });
  return { proofs, appBooted: Boolean(r.out), bootNote: r.out ? `Signed in: ${[...signedIn].join(", ") || "none"}.` : "The app did not boot.", identities, notApplicable: catalog.notApplicable };
}

/** Field names that mark one account's own data, from the entities' personal/secret fields. */
function sensitiveFieldsOf(d: ProjectDossier): string[] {
  const names = new Set<string>(["email", "password", "passwordHash", "ssn", "token", "apiKey"]);
  for (const e of d.dataModel.entities) for (const f of e.fields) if (f.sensitivity) names.add(f.name);
  return [...names];
}
