import { readFileSync } from "node:fs";
import type { AiApplicability, Evidence, ProjectDossier } from "@cybercheck/contracts";
import { buildIdentities, prepareApp } from "../security/proofs/run.ts";
import { OUT, planWorkspaces, wsPath } from "../testing/adapters.ts";
import { planBoot } from "../testing/agents.ts";
import { seededAccounts } from "../testing/fixtures.ts";
import { appEnv, HARNESS_LIB } from "../testing/probes.ts";
import { BROWSER_DIR, CI_ENV, execute, POLICY, type Ctx } from "../testing/runtime.ts";
import { browserSessions } from "../testing/sessions.ts";
import type { SnapshotSource } from "../understanding/source.ts";

// The output-rendering browser canary (engine step 2b). When source analysis finds a page that injects the assistant's
// reply as HTML, this opens that page in Chromium inside the sandbox, sends a message carrying a unique executable
// payload through the real input, and checks whether the payload's script actually ran. Only a real execution upgrades
// the finding from suspected to confirmed; if the canary cannot drive the page, the finding stays suspected.

const CANARY_MJS = readFileSync(new URL("../testing/harness/ai-canary.mjs", import.meta.url));
// The hardened sandbox runs with every Linux capability dropped, so apt (which Playwright's --with-deps uses to install
// Chromium's system libraries) cannot run: it can neither drop to the _apt user nor, as root, write its archives. So the
// canary prepares on Microsoft's Playwright image, which already ships Chromium and its system libraries, and only needs
// the matching Playwright node module. The browser binary is verified, so the canary never runs without it.
// Node 22.18 here matches the main run's node:22-bookworm closely enough that an app which boots there boots here too
// (older Playwright images shipped a Node too old for recent builtins such as node:sqlite). The Playwright npm version
// is pinned to the image so the preinstalled browsers match.
const CANARY_IMAGE = "mcr.microsoft.com/playwright:v1.55.0-noble";
const BROWSER_INSTALL = `mkdir -p ${BROWSER_DIR} && cd ${BROWSER_DIR} && echo '{"private":true}' > package.json && npm install playwright@1.55.0 --no-audit --no-fund && node -e "require('fs').accessSync(require('playwright').chromium.executablePath())" && echo cc-browser-ready`;

export type CanaryResult = { ran: boolean; executed: boolean; reflected: boolean; page: string | null; detail: string; executionId: string | null };

/** Browser storage keys the client reads or writes for an auth token (so the canary can inject the captured session
 *  the way the app's own code expects). browserSessions covers framework stores; this also catches plain static pages
 *  that do localStorage.getItem("token"). */
function detectAuthStorage(src: SnapshotSource): Array<{ area: "localStorage" | "sessionStorage"; key: string }> {
  const out = new Map<string, { area: "localStorage" | "sessionStorage"; key: string }>();
  const re = /(localStorage|sessionStorage)\s*\.\s*(?:get|set)Item\s*\(\s*['"`]([^'"`]{1,40})['"`]/g;
  for (const [path, file] of src.files) {
    if (!/\.(html?|[cm]?jsx?|tsx|vue|svelte|astro)$/i.test(path) || /node_modules|\.next\/|dist\/|build\//.test(path)) continue;
    const text = file.text;
    const authy = /authorization|bearer/i.test(text);
    for (const m of text.matchAll(re)) {
      const area = m[1] === "sessionStorage" ? "sessionStorage" : "localStorage";
      const key = m[2]!;
      if (/token|auth|jwt|session|bearer|access/i.test(key) || authy) out.set(`${area}:${key}`, { area, key });
    }
  }
  return [...out.values()].slice(0, 4);
}

/** Candidate served URLs for a client file that holds a render sink (a static page, and a few path variants). */
function pagesFor(sinks: Evidence[]): string[] {
  const urls = new Set<string>();
  for (const e of sinks) {
    const m = e.path.match(/(?:^|\/)(?:public|static|www|dist|build|out)\/(.+)$/);
    const rel = (m ? m[1]! : e.path.split("/").slice(1).join("/")).replace(/^\/+/, "");
    urls.add(`/${rel}`);
    urls.add(`/${rel.replace(/\.html?$/i, "")}`);
    const name = rel.split("/").pop()!.replace(/\.[^.]+$/, "");
    if (name && name !== "index") urls.add(`/${name}`);
  }
  urls.add("/"); // a single-page app may mount the assistant at the root
  return [...urls].filter((u) => u.length > 0).slice(0, 6);
}

export async function runRenderCanary(ctx: Ctx, input: { d: ProjectDossier; src: SnapshotSource; archive: Buffer; applicability: AiApplicability; sinks: Evidence[]; nonce: string }): Promise<CanaryResult> {
  const { d, src } = input;
  const no = (detail: string, executionId: string | null = null): CanaryResult => ({ ran: false, executed: false, reflected: false, page: null, detail, executionId });
  const pages = pagesFor(input.sinks);
  if (!pages.length) return no("No servable page was found for the detected render sink(s).");

  const workspaces = planWorkspaces(d, src);
  const boot = await planBoot(null, d, src, workspaces);
  const app = boot.apps[0];
  if (!app) return no("No startable app was found for the rendering canary.");
  const ws = workspaces.find((w) => w.dir === app.workspace);
  const image0 = await prepareApp(ctx, input.archive, app.prepare.length || ws?.install ? { dir: app.workspace, command: ws?.install?.command ?? "npm install" } : null, CANARY_IMAGE);
  if (!image0) return no("The app could not be prepared for the rendering canary.");

  // Install Chromium on top of the prepared image (network on, kept). This runs only because a render sink was found.
  const inst = await execute(ctx, { kind: "ai_eval_canary", label: "Install the browser (Chromium) for the output-rendering canary", workspace: null }, { image: image0, command: `${BROWSER_INSTALL} </dev/null`, network: true, keep: true, timeoutSec: POLICY.installTimeoutSec, env: CI_ENV });
  if (inst.exec.outcome !== "ok" || !inst.result.resultImage) return no("Chromium could not be installed in the sandbox, so the rendering canary could not run.", inst.exec.id);
  const image = inst.result.resultImage;

  // Sign-in graph through the project's own login route and seeded accounts, so a page behind auth can be reached.
  const loginEp = d.entryPoints.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  const accounts = seededAccounts(src);
  const login = loginEp && accounts.length ? { method: loginEp.method, path: loginEp.path, accountField: accounts[0]!.accountField, passwordField: accounts[0]!.passwordField } : null;
  const { nodes: idNodes } = login ? buildIdentities(src, login, d) : { nodes: [] };

  const apps = boot.apps.map((a) => ({ name: `app-${a.workspace === "." ? "root" : a.workspace.replace(/[^\w-]+/g, "-")}`, cwd: wsPath(a.workspace), prepare: a.prepare, start: a.start, port: a.port, readyPath: a.readyPath, env: appEnv(ctx, a, {}, idNodes) }));
  const first = apps[0]!;
  // The assistant page is almost always served by the backend itself (a static file or a route), so the frontend is
  // that same app; a separate frontend build is out of scope for this canary.
  const spec = {
    apps,
    frontend: { name: "frontend", served: true, cwd: first.cwd, start: first.start, port: first.port, readyPath: first.readyPath, env: first.env },
    graph: idNodes.map((n) => ({ id: n.id, kind: n.kind, dependsOn: n.dependsOn, command: n.command, exports: n.exports, identity: n.identity ?? null, steps: n.steps, auth: n.auth, verify: n.verify ?? null })),
    sessions: (() => {
      const firstId = idNodes.find((n) => n.kind === "identity")?.id ?? null;
      const detected = firstId ? detectAuthStorage(src).map((s) => ({ identity: firstId, area: s.area, key: s.key, form: "token" as const, encode: undefined })) : [];
      const framework = browserSessions(src, app.workspace, idNodes);
      const seen = new Set(framework.map((s) => `${s.identity}:${s.area}:${s.key}`));
      return [...framework, ...detected.filter((s) => !seen.has(`${s.identity}:${s.area}:${s.key}`))];
    })(),
    browserDir: BROWSER_DIR,
    bootTimeoutSec: POLICY.bootTimeoutSec,
    canary: { pages, nonce: input.nonce },
  };
  const [libId, mjsId, specId] = await Promise.all([ctx.provider.upload(HARNESS_LIB), ctx.provider.upload(CANARY_MJS), ctx.provider.upload(Buffer.from(JSON.stringify(spec)))]);
  const r = await execute(ctx, { kind: "ai_eval_canary", label: "Open the assistant page in Chromium and test unsafe output rendering", workspace: null, fetch: [`${OUT}/ai-canary.json`, `${OUT}/${first.name}.log`, `${OUT}/frontend.log`] }, {
    image,
    command: `mkdir -p ${OUT} && node /cc/ai-canary.mjs /cc/cspec.json ${OUT}`,
    network: false,
    keep: true,
    timeoutSec: 600,
    env: { ...CI_ENV, NO_COLOR: "1" },
    files: [
      { path: "/cc/lib.mjs", fileId: libId },
      { path: "/cc/ai-canary.mjs", fileId: mjsId },
      { path: "/cc/cspec.json", fileId: specId },
    ],
  });
  const raw = r.files.get(`${OUT}/ai-canary.json`);
  const out = raw ? (JSON.parse(raw.toString("utf8")) as { ran: boolean; executed: boolean; reflected?: boolean; page: string | null; detail: string; signedIn?: boolean; attempts?: Array<{ page: string; opened: boolean; submitted: boolean; inert: boolean; why: string | null }> }) : null;
  if (!out) return no(`The rendering canary produced no result (${r.exec.outcome}).`, r.exec.id);
  if (!out.executed && out.attempts) {
    const att = out.attempts.map((a) => `${a.page}[open=${a.opened} sent=${a.submitted} inert=${a.inert}${a.why ? ` ${a.why}` : ""}]`).join(" ");
    out.detail = `${out.detail} signedIn=${out.signedIn ?? false}; attempts: ${att}`;
  }
  // When the app did not boot, the boot reason alone is opaque; include the tail of its log for diagnosis.
  const appLog = (r.files.get(`${OUT}/${first.name}.log`) ?? r.files.get(`${OUT}/frontend.log`))?.toString("utf8") ?? "";
  const detail = !out.ran && /did not start|exited/.test(out.detail) && appLog ? `${out.detail} App log: ${appLog.replace(/\s+/g, " ").slice(-400)}` : out.detail;
  return { ran: out.ran, executed: out.executed, reflected: Boolean(out.reflected), page: out.page, detail, executionId: r.exec.id };
}
