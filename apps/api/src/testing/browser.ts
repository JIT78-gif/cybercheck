import { readFileSync } from "node:fs";
import type { Screen, TestExecution } from "@cybercheck/contracts";
import { redactSecrets } from "../understanding/source.ts";
import { OUT, wsPath } from "./adapters.ts";
import { excerpt, syntheticValue, type BootApp, type FrontendApp, type Journey, type UiLogin } from "./agents.ts";
import type { FixtureNode } from "./plan.ts";
import { HARNESS_LIB, appEnv } from "./probes.ts";
import { startServices } from "./services.ts";
import { browserSessions } from "./sessions.ts";
import type { Candidate } from "./triage.ts";
import { BROWSER_DIR, CI_ENV, POLICY, PROFILES, addFinding, execute, setOb, shq, tail, toProjectPaths, type Ctx } from "./runtime.ts";

// The browser worker: the real frontend, built with network and served for real, opened in Chromium.
// Screens are checked for errors, accessibility (axe-core, WCAG 2.2 A/AA) and phone-width overflow;
// user journeys written by the journey author run with a trace. Failures are repeated before triage.

const BROWSER = readFileSync(new URL("./harness/browser.mjs", import.meta.url));

export type BrowserJourney = Journey & { id: string; obligationId: string };
export type BrowserPlan = { frontend: FrontendApp; apps: BootApp[]; graph: FixtureNode[]; logins: UiLogin[]; journeys: BrowserJourney[] };

type ScreenRec = { viewport: number; as: string | null; how?: "ui" | "session" | null; status: number | null; error: string | null; finalPath: string; redirectedToLogin: boolean; pageErrors: string[]; consoleErrors: string[]; forbidden?: string[]; text?: string; failedRequests: Array<{ url: string; status: number | null; error: string | null }>; external: number; axe: Array<{ id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: string; html: string; summary: string }>; count: number }> | { error: string } | null; overflowPx: number | null; overflowing: string[] };
type JourneyRec = { id: string; ok: boolean; blocked?: string; why?: string | null; failedStep?: number | null; url?: string; pageErrors?: string[]; consoleErrors?: string[]; failedRequests?: Array<{ url: string; status: number | null; error: string | null }>; text?: string | null; trace?: string | null; screenshot?: string | null };
type BrowserOut = { apps: Array<{ name: string; ok: boolean; reason: string | null }>; fixtures: Array<{ id: string; ok: boolean; note: string }>; logins: Array<{ identity: string; ok: boolean; why: string | null; url: string }>; screens: Array<{ url: string; path: string; as: string | null; viewports: ScreenRec[] }>; journeys: JourneyRec[]; error: string | null };

/** Browser-side settings: the planner's wiring first; URL-like settings without a value point at the first backend. */
export function frontendEnv(ctx: Ctx, f: FrontendApp, apps: BootApp[]) {
  const env: Record<string, string> = {};
  const backend = apps[0] ? `http://localhost:${apps[0].port}` : "http://127.0.0.1:9";
  for (const e of ctx.d.config.envVars.filter((x) => x.side === "browser")) {
    if (e.hasDefault && e.required !== true) continue;
    env[e.name] = /WS_URL|WEBSOCKET|SOCKET_URL/.test(e.name) ? backend.replace(/^http/, "ws") : /(URL|URI|HOST|ENDPOINT|BASE|API|BACKEND|SERVER)/.test(e.name) ? backend : /PORT$/.test(e.name) ? String(apps[0]?.port ?? 3000) : syntheticValue(e.name, ctx.runId);
  }
  for (const c of f.config) env[c.name] = c.value;
  env.PORT = String(f.port);
  env.HOSTNAME ??= "0.0.0.0";
  return env;
}

/** Builds the frontend with network on (fonts and similar downloads work) and keeps the image for the browser runs. */
export async function buildFrontend(ctx: Ctx, image: string, plan: BrowserPlan): Promise<{ image: string | null; exec: TestExecution; reason: string | null }> {
  const f = plan.frontend;
  const r = await execute(ctx, { kind: "prepare", label: `Build the frontend for the browser (${f.workspace})`, workspace: f.workspace }, {
    image,
    command: `cd ${shq(wsPath(f.workspace))} && ${f.build.length ? f.build.join(" && ") : "true"} </dev/null`,
    network: true,
    keep: true,
    timeoutSec: POLICY.commandTimeoutSec,
    env: { ...CI_ENV, ...frontendEnv(ctx, f, plan.apps) },
  });
  const ok = r.exec.outcome === "ok" && r.result.resultImage;
  return { image: ok ? r.result.resultImage : null, exec: r.exec, reason: ok ? null : `${f.build.join(" && ")} exited with code ${r.exec.exitCode ?? r.exec.outcome}: ${tail(r.exec.outputTail, 600)}` };
}

async function runBrowser(ctx: Ctx, image: string, plan: BrowserPlan, screens: Screen[], journeys: BrowserJourney[], label: string, retryOf: string | null) {
  // Pages open on http://localhost:<port>; a backend origin setting written for 127.0.0.1 would refuse them (CORS).
  const sameOrigin = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.split(`127.0.0.1:${plan.frontend.port}`).join(`localhost:${plan.frontend.port}`)]));
  // Settings the browser sign-ins and journeys type (an admin email, a password) get the same synthetic values the app and seed see.
  const typed = Object.fromEntries([...JSON.stringify([plan.logins, journeys]).matchAll(/\$\{ENV:([A-Z0-9_]+)\}/g)].map((m) => [m[1]!, syntheticValue(m[1]!, ctx.runId)]));
  const apps = plan.apps.map((a) => {
    const base = appEnv(ctx, a, {}, plan.graph);
    return { name: `app-${a.workspace === "." ? "root" : a.workspace.replace(/[^\w-]+/g, "-")}`, cwd: wsPath(a.workspace), prepare: a.prepare, start: a.start, port: a.port, readyPath: a.readyPath, env: sameOrigin({ ...typed, ...base }) };
  });
  const spec = {
    apps,
    frontend: { name: "frontend", served: Boolean(plan.frontend.served), cwd: wsPath(plan.frontend.workspace), start: plan.frontend.start, port: plan.frontend.port, readyPath: plan.frontend.readyPath, env: frontendEnv(ctx, plan.frontend, plan.apps) },
    graph: plan.graph.map((n) => ({ id: n.id, kind: n.kind, dependsOn: n.dependsOn, command: n.command, exports: n.exports, identity: n.identity ?? null, steps: n.steps, auth: n.auth, verify: n.verify ?? null })),
    screens: screens.map((s) => ({ url: s.url })),
    viewports: PROFILES[ctx.profile].viewports,
    logins: plan.logins,
    // How the frontend stores each sign-in (from its own code), so pages get the session the API setup created.
    sessions: browserSessions(ctx.src, plan.frontend.workspace, plan.graph),
    journeys: journeys.map((j) => ({ id: j.id, identity: j.identity, steps: j.steps })),
    browserDir: BROWSER_DIR,
    bootTimeoutSec: POLICY.bootTimeoutSec,
  };
  const [libId, harnessId, specId] = await Promise.all([ctx.provider.upload(HARNESS_LIB), ctx.provider.upload(BROWSER), ctx.provider.upload(Buffer.from(JSON.stringify(spec)))]);
  const fetch = [`${OUT}/browser.json`, `${OUT}/frontend.log`, ...apps.map((a) => `${OUT}/${a.name}.log`), ...journeys.flatMap((j) => [`${OUT}/${j.id}.png`, `${OUT}/${j.id}.trace.zip`])];
  const r = await execute(ctx, { kind: "browser", label, workspace: plan.frontend.workspace, retryOf, fetch, bundle: `${OUT}/shots.json` }, {
    image,
    command: `${startServices(ctx.services)}mkdir -p ${OUT} && node /cc/browser.mjs /cc/bspec.json ${OUT}`,
    network: false,
    keep: true,
    timeoutSec: 1200,
    env: { ...CI_ENV, NO_COLOR: "1" },
    files: [
      { path: "/cc/lib.mjs", fileId: libId },
      { path: "/cc/browser.mjs", fileId: harnessId },
      { path: "/cc/bspec.json", fileId: specId },
    ],
  });
  const raw = r.files.get(`${OUT}/browser.json`);
  const out: BrowserOut | null = raw ? JSON.parse(raw.toString("utf8")) : null;
  const logs = [`${OUT}/frontend.log`, ...apps.map((a) => `${OUT}/${a.name}.log`)].map((p) => redactSecrets(toProjectPaths(r.files.get(p)?.toString("utf8") ?? "")).text);
  return { exec: r.exec, out, logs };
}

/** Text of a page that shows nothing but a signed-out, expired or access-denied state. */
export const NO_SESSION = /session (has )?expired|(please|you must|need to) (sign|log) ?in|not (signed|logged) in|(sign|log) ?in to continue|re-?scan the qr|no (active )?session|unauthori[sz]ed|access denied|you don't have access/i;

const screenProblems = (rec: ScreenRec) => [
  ...rec.pageErrors.map((e) => `uncaught error: ${e}`),
  ...rec.failedRequests.map((f) => `${f.url} ${f.status ? `answered ${f.status}` : `failed (${f.error})`}`),
  ...rec.consoleErrors.map((e) => `console error: ${e}`),
  // Signed in as the screen's own role, the screen asked for data that role is refused.
  ...(rec.as ? (rec.forbidden ?? []).slice(0, 3).map((f) => `${f} was refused with 403 for "${rec.as}"`) : []),
];

/**
 * A browser sign-in types the same credentials as the identity's API sign-in (which the setup verified):
 * fields named like an email or user name and like a password take those values, never an author's guess.
 */
export function alignLogins(logins: UiLogin[], graph: FixtureNode[]): UiLogin[] {
  return logins.map((l) => {
    const json = graph.find((n) => n.id === l.identity)?.auth?.request?.json;
    if (!json || typeof json !== "object") return l;
    const fields = json as Record<string, unknown>;
    const key = (re: RegExp) => Object.keys(fields).find((k) => re.test(k) && typeof fields[k] === "string");
    const userKey = key(/email|user|login|phone|name/i);
    const passKey = key(/pass|pwd|secret/i);
    return {
      ...l,
      steps: l.steps.map((st) => {
        if (st.action !== "fill") return st;
        const name = `${st.target?.label ?? ""} ${st.target?.placeholder ?? ""} ${st.target?.name ?? ""} ${st.target?.testId ?? ""}`.toLowerCase();
        if (passKey && /pass|pwd/.test(name)) return { ...st, value: String(fields[passKey]) };
        if (userKey && /mail|user|login|phone/.test(name)) return { ...st, value: String(fields[userKey]) };
        return st;
      }),
    };
  });
}

/** Opens every screen and runs the journeys; failures are repeated once in a fresh sandbox, then go to triage. */
/**
 * The source line that renders an element axe or the overflow check named, from its HTML (`<button class="a b">`)
 * or selector (`div#id.a.b`): searched in the screen's file first, then the other frontend files of its workspace.
 */
export function sourceOf(ctx: Pick<Ctx, "src">, screenFile: string, element: string, shared = false): { path: string; line: number } | null {
  const attr = (n: string) => element.match(new RegExp(`${n}="([^"]{3,120})"`))?.[1];
  const classes = (attr("class") ?? element.match(/^[a-z0-9-]+(?:#[\w-]+)?((?:\.[^.\s(]+)+)/i)?.[1]?.split(".").filter(Boolean).join(" ") ?? "").trim();
  const text = element.match(/>([^<>]{3,60})</)?.[1]?.trim();
  const needles = [
    attr("id") && `id="${attr("id")}"`,
    element.match(/#([\w-]{3,})/)?.[1] && `"${element.match(/#([\w-]{3,})/)![1]}"`,
    attr("aria-label"),
    attr("placeholder"),
    attr("name") && `name="${attr("name")}"`,
    classes.length >= 6 && classes,
    ...classes.split(" ").filter((c) => c.length >= 8).sort((a, b) => b.length - a.length),
    text,
    attr("alt") === undefined && attr("src") && `src="${attr("src")}"`,
    // Last resort for an element with nothing distinctive (an <img> with a computed src): its tag in the screen file.
    /^<(img|input|select|textarea|button|iframe|video|svg)\b/i.test(element) && `<${element.match(/^<(\w+)/)![1]}`,
  ].filter((x): x is string => Boolean(x));
  const ws = screenFile.split("/")[0]!;
  const others = [...ctx.src.files.keys()].filter((p) => p !== screenFile && p.startsWith(`${ws}/`) && /\.(tsx|jsx|vue|svelte|html)$/.test(p) && !/node_modules|\.next\//.test(p));
  // An element seen on several screens lives in a shared component (a layout, a nav bar): look there first.
  const files = shared ? [...others.filter((p) => !/(^|\/)(app|pages)\/(.*\/)?(page|index)\.[jt]sx?$/.test(p)), screenFile] : [screenFile, ...others];
  for (const needle of needles) {
    for (const file of files) {
      const i = ctx.src.files.get(file)?.text.split("\n").findIndex((l) => l.includes(needle)) ?? -1;
      if (i >= 0) return { path: file, line: i + 1 };
    }
  }
  return null;
}

export async function judgeBrowser(ctx: Ctx, image: string, all: BrowserPlan, candidates: Candidate[]) {
  // Only screens and journeys that still need a verdict (a targeted rerun carries the rest over).
  const open = (id: string) => ctx.obligations.get(id)?.status === "planned";
  const screens = ctx.d.screens.filter((s) => open(`ui:${s.url}:renders`) || open(`a11y:${s.url}:wcag`) || open(`ui:${s.url}:responsive`));
  const plan = { ...all, logins: alignLogins(all.logins, all.graph), journeys: all.journeys.filter((j) => open(j.obligationId)) };
  if (!screens.length && !plan.journeys.length) return;
  const uiObs = [...ctx.obligations.values()].filter((o) => (o.layer === "ui" || o.layer === "accessibility") && o.status === "planned");
  const blockAll = async (reason: string, blockedBy: "prerequisite" | "fixture", execIds: string[]) => {
    for (const o of uiObs) if (ctx.obligations.get(o.id)!.status === "planned") await setOb(ctx, o.id, { status: "blocked", blockedBy, reason, executionIds: execIds });
  };
  const first = await runBrowser(ctx, image, plan, screens, plan.journeys, `Open ${screens.length} screen(s) and run ${plan.journeys.length} journey(s) in Chromium`, null);
  const out = first.out;
  const failedApp = out?.apps.find((a) => !a.ok);
  if (!out || failedApp || out.error && !out.screens.length) {
    const why = !out ? `the browser run produced no result (${first.exec.outcome})` : failedApp ? `${failedApp.name} did not start: ${failedApp.reason}` : `the browser failed: ${out.error}`;
    await blockAll(`Not run: ${why}.`, "prerequisite", [first.exec.id]);
    if (!out || (out.error && !failedApp)) {
      await addFinding(ctx, { kind: "tool_failure", status: "confirmed", severity: "low", confidence: "high", title: "The browser worker could not run", expected: "Chromium opens the screens", actual: why, reproduction: "Internal to cybercheck", rootCause: null, location: null, obligationIds: uiObs.map((o) => o.id).slice(0, 50), executionIds: [first.exec.id], validation: "The browser harness reported no result.", limitation: null, layer: "ui", nextAction: "Rerun the browser checks; if it repeats, report it to cybercheck." });
    }
    return;
  }

  const loginFailed = new Map(out.logins.filter((l) => !l.ok).map((l) => [l.identity, l.why ?? "failed"]));
  if (loginFailed.size) {
    // Signing in through the UI is cybercheck's setup, not a product check: a failure here is a testing-system problem.
    await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `cybercheck could not sign in through the browser as ${[...loginFailed.keys()].join(", ")}`, expected: "The browser signs in with the same credentials the API sign-in used", actual: [...loginFailed].map(([k, v]) => `${k}: ${v.slice(0, 400)}`).join("\n"), reproduction: "Internal to cybercheck: the sign-in steps and the page's answers are in the browser evidence.", rootCause: null, location: null, obligationIds: [], executionIds: [first.exec.id], validation: "Recorded by the browser harness.", limitation: null, layer: "ui", nextAction: "Rerun the checks without a verdict; the screens behind sign-in were not judged." });
  }
  const execIds = [first.exec.id];
  const a11yRules = new Map<string, { help: string; helpUrl: string; impact: string; screens: Array<{ url: string; file: string; as: string | null; nodes: Array<{ target: string; html: string }> }>; obligationIds: string[] }>();
  const overflows: Array<{ url: string; px: number; culprits: string[]; obligationId: string }> = [];
  const retryScreens: Screen[] = [];
  for (const s of out.screens) {
    const screen = screens.find((x) => x.url === s.url);
    if (!screen) continue;
    const renderId = `ui:${s.url}:renders`;
    const a11yId = `a11y:${s.url}:wcag`;
    const respId = `ui:${s.url}:responsive`;
    const main = s.viewports[0]!;
    const phone = s.viewports.find((v) => v.viewport < 500);
    if (main.redirectedToLogin) {
      const reason = `The screen sent the browser to the sign-in page${plan.logins.length ? ` and no browser sign-in worked${loginFailed.size ? ` (${[...loginFailed].map(([k, v]) => `${k}: ${v}`).join("; ").slice(0, 200)})` : ""}` : " and no way to sign in through the UI was found"}.`;
      for (const id of [renderId, a11yId, respId]) if (ctx.obligations.get(id)?.status === "planned") await setOb(ctx, id, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason, executionIds: execIds });
      continue;
    }
    const madeUpParam = /[:[{]/.test(s.url) && s.path !== s.url;
    // A screen that sends the browser elsewhere (no session, a missing record) was not shown: nothing about it is proven.
    const landed = main.finalPath.split("?")[0]!.replace(/\/+$/, "") || "/";
    const asked = s.path.split("?")[0]!.replace(/\/+$/, "") || "/";
    if (main.status != null && main.status < 400 && landed !== asked) {
      // A screen whose code is only a redirect (Next's redirect("/admin/menu"), <Navigate to=...>) has nothing of
      // its own to check; the screen it leads to is checked separately.
      const code = ctx.src.files.get(screen.file)?.text ?? "";
      // Server redirects, and short client components whose only job is router.replace/push (a legacy address).
      const pureRedirect = code.split("\n").length <= 25 && /\bredirect\(|<Navigate\b|permanentRedirect\(|router\.(replace|push)\(/.test(code) && !/<form|<input|<button|fetch\(|\bapi\(|useState/i.test(code);
      if (pureRedirect) {
        for (const id of [renderId, a11yId, respId]) if (ctx.obligations.get(id)?.status === "planned") await setOb(ctx, id, { status: "not_applicable", reachedTarget: false, reason: `${s.url} only redirects to ${landed} (${screen.file}); that screen is checked on its own.`, executionIds: execIds });
        continue;
      }
      for (const id of [renderId, a11yId, respId]) if (ctx.obligations.get(id)?.status === "planned") await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `Opening ${s.path} sent the browser to ${landed}, so this screen itself was not shown${madeUpParam ? " (its address needs real record ids)" : " (it may need a session or data first)"}.`, executionIds: execIds });
      continue;
    }
    // A screen that only shows a signed-out or expired state ("Session expired. Please re-scan the QR") was not
    // really shown: like a redirect, nothing about it is proven.
    if (main.status != null && main.status < 400 && NO_SESSION.test(main.text ?? "") && (main.text ?? "").length < 300) {
      for (const id of [renderId, a11yId, respId]) if (ctx.obligations.get(id)?.status === "planned") await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `${s.url} only showed a signed-out state ("${(main.text ?? "").slice(0, 120)}"${main.as ? `, opened as ${main.as}` : ", opened without a session"}); it needs a session cybercheck could not give it.`, executionIds: execIds });
      continue;
    }
    const problems = screenProblems(main);
    if (main.status == null || main.status >= 400) {
      if (madeUpParam && main.status === 404) await setOb(ctx, renderId, { status: "inconclusive", reachedTarget: false, reason: `The screen needs a real record in its address (${s.url}); none could be created, so it answered 404.`, executionIds: execIds });
      else retryScreens.push(screen);
    } else if (problems.length) retryScreens.push(screen);
    else await setOb(ctx, renderId, { status: "passed", reachedTarget: true, reason: `Loaded with ${main.status}${s.as ? ` (signed in as ${s.as}${main.how === "session" ? ", with the session the API setup created" : ""})` : ""}; no uncaught error, console error or failed request.${main.external ? ` ${main.external} request(s) to other hosts failed offline and were ignored.` : ""}`, executionIds: execIds });

    // Accessibility: deterministic rule results from axe-core.
    if (ctx.obligations.get(a11yId)?.status === "planned") {
      if (!main.axe || "error" in main.axe) await setOb(ctx, a11yId, { status: "inconclusive", reason: `axe-core could not run on this page${main.axe && "error" in main.axe ? ` (${main.axe.error})` : main.status == null || main.status >= 400 ? " because it did not load" : ""}.`, executionIds: execIds });
      else {
        // Rules that only fail at phone width (a mobile-only bar) join the desktop results, marked as such.
        const phoneOnly = phone && phone !== main && phone.axe && !("error" in phone.axe) ? phone.axe.filter((v) => !(main.axe as Array<{ id: string }>).some((m) => m.id === v.id)).map((v) => ({ ...v, help: `${v.help} (at ${phone.viewport} px)` })) : [];
        const all = [...main.axe, ...phoneOnly];
        const serious = all.filter((v) => v.impact === "critical" || v.impact === "serious");
        const minor = all.length - serious.length;
        for (const v of serious) {
          const rule = a11yRules.get(v.id) ?? { help: v.help, helpUrl: v.helpUrl, impact: v.impact ?? "serious", screens: [], obligationIds: [] };
          rule.screens.push({ url: s.url, file: screen.file, as: main.as, nodes: v.nodes.map((n) => ({ target: n.target, html: n.html })) });
          rule.obligationIds.push(a11yId);
          if (v.impact === "critical") rule.impact = "critical";
          a11yRules.set(v.id, rule);
        }
        await setOb(ctx, a11yId, serious.length ? { status: "failed", reachedTarget: true, reason: `${serious.length} critical or serious WCAG rule violation(s): ${serious.map((v) => `${v.id} (${v.impact}, ${v.count} element(s))`).join(", ")}${minor ? `; ${minor} moderate or minor` : ""}.`, executionIds: execIds } : { status: "passed", reachedTarget: true, reason: minor ? `No serious violation; ${minor} moderate or minor rule(s): ${all.filter((v) => v.impact !== "critical" && v.impact !== "serious").map((v) => v.id).join(", ")}.` : "No WCAG 2.2 A/AA violation found by axe-core.", executionIds: execIds });
      }
    }
    if (phone && ctx.obligations.get(respId)?.status === "planned") {
      if (phone.overflowPx == null) await setOb(ctx, respId, { status: "inconclusive", reason: "The page did not load at phone width.", executionIds: execIds });
      else if (phone.overflowPx > 2) {
        overflows.push({ url: s.url, px: phone.overflowPx, culprits: phone.overflowing, obligationId: respId });
        await setOb(ctx, respId, { status: "failed", reachedTarget: true, reason: `At 375 px the page is ${phone.overflowPx} px wider than the screen${phone.overflowing.length ? ` (${phone.overflowing.join(", ")})` : ""}.`, executionIds: execIds });
      } else await setOb(ctx, respId, { status: "passed", reachedTarget: true, reason: "No horizontal overflow at 375 px.", executionIds: execIds });
    }
  }

  const ruleFinding = new Map<string, { findingId: string; urls: string[] }>();
  for (const [id, rule] of a11yRules) {
    const first = rule.screens[0]!;
    const where = rule.screens.flatMap((s) => s.nodes.map((n) => sourceOf(ctx, s.file, n.html, rule.screens.length > 1 && rule.screens.every((x) => x.nodes.some((m) => m.html === n.html))))).find(Boolean) ?? { path: first.file, line: 1 };
    const af = await addFinding(ctx, {
      kind: "product_defect",
      status: "confirmed",
      severity: rule.impact === "critical" ? "high" : "medium",
      confidence: "high",
      title: `Accessibility: ${rule.help} (${rule.screens.length} screen${rule.screens.length === 1 ? "" : "s"})`,
      expected: `WCAG 2.2 A/AA rule "${id}" passes`,
      actual: rule.screens.slice(0, 4).map((s) => `${s.url}: ${s.nodes.slice(0, 2).map((n) => `${n.target} ${n.html}`).join("; ")}`).join("\n"),
      reproduction: `${first.as ? `Sign in as ${first.as} (the sign-in steps are under Fixtures in this report), then open` : "Open"} ${first.url} in a browser and run axe-core 4.10 with the WCAG 2.2 A/AA rules; rule "${id}" fails on ${first.nodes[0]?.target ?? "the page"}.`,
      rootCause: `axe-core rule ${id}: ${rule.help}.`,
      location: where,
      obligationIds: rule.obligationIds,
      executionIds: execIds,
      validation: "Deterministic automated rule check (axe-core) on the rendered page.",
      limitation: "Automated rules find about a third of accessibility issues; keyboard and screen-reader use still need a human check.",
      layer: "accessibility",
      nextAction: `See ${rule.helpUrl}`,
    });
    ruleFinding.set(id, { findingId: af.id, urls: rule.screens.map((x) => x.url) });
  }
  /** "div.flex.items-center (5 px)" without the measured width, so the same element on two screens compares equal. */
  const bare = (culprit: string) => culprit.replace(/ \(\d+ px\)$/, "");
  if (overflows.length) {
    await addFinding(ctx, {
      kind: "product_defect",
      status: "confirmed",
      severity: "low",
      confidence: "high",
      title: `${overflows.length} screen${overflows.length === 1 ? " is" : "s are"} wider than a phone (375 px)`,
      expected: "No horizontal scrolling at 375 px",
      actual: overflows.slice(0, 6).map((o) => `${o.url}: ${o.px} px too wide${o.culprits.length ? ` (${o.culprits.join(", ")})` : ""}`).join("\n"),
      reproduction: `Open ${overflows[0]!.url} at 375 px width and scroll sideways.`,
      rootCause: overflows[0]!.culprits[0] ? `The widest element is ${overflows[0]!.culprits[0]}.` : null,
      location: overflows.flatMap((o) => o.culprits.map((c) => sourceOf(ctx, screens.find((s) => s.url === o.url)!.file, bare(c), overflows.filter((x) => x.culprits.some((y) => bare(y) === bare(c))).length > 1))).find(Boolean) ?? { path: screens.find((s) => s.url === overflows[0]!.url)!.file, line: 1 },
      obligationIds: overflows.map((o) => o.obligationId),
      executionIds: execIds,
      validation: "Measured in Chromium at 375 px (page width compared with the viewport).",
      limitation: null,
      layer: "ui",
      nextAction: "Let wide content wrap or scroll inside its own container.",
    });
  }

  // Journeys.
  const retryJourneys: BrowserJourney[] = [];
  for (const j of plan.journeys) {
    const rec = out.journeys.find((x) => x.id === j.id);
    if (!rec) await setOb(ctx, j.obligationId, { status: "blocked", blockedBy: "prerequisite", reason: "Not reached: the browser run stopped early.", executionIds: execIds });
    else if (rec.blocked) await setOb(ctx, j.obligationId, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason: `Not run: ${rec.blocked}${loginFailed.get(j.identity ?? "") ? ` (${loginFailed.get(j.identity ?? "")})` : ""}.`, executionIds: execIds, fixtureRefs: j.identity ? [j.identity] : [] });
    else if (rec.ok) await setOb(ctx, j.obligationId, { status: "passed", reachedTarget: true, reason: `Completed all ${j.steps.length} steps in Chromium${j.identity ? ` as ${j.identity}` : ""}.`, executionIds: execIds });
    else {
      // A step that could not find a control by its name, on a screen where axe found controls without an
      // accessible name: the journey fails because of that accessibility defect (assistive technology cannot find
      // the control either), not because the journey is wrong.
      const st = rec.failedStep != null ? j.steps[rec.failedStep] : undefined;
      const named = st && ["fill", "click", "select"].includes(st.action) && (st.target?.label || st.target?.name);
      const onScreen = (pattern: string) => Boolean(rec.url) && new RegExp(`^${pattern.replace(/[.*+?^$()|\\]/g, "\\$&").replace(/\/(:\w+|\[[^\]]+\]|\{\w+\})/g, "/[^/]+")}/?(\\?.*)?$`).test((rec.url ?? "").replace(/^https?:\/\/[^/]+/, ""));
      const cause = named ? ["label", "button-name", "select-name", "link-name", "input-button-name"].map((r) => ruleFinding.get(r)).find((f) => f && f.urls.some(onScreen)) : undefined;
      if (cause) {
        await setOb(ctx, j.obligationId, { status: "failed", reachedTarget: true, reason: `Step ${rec.failedStep! + 1} could not find "${named}" by its accessible name: that control has none (see the accessibility finding), so this flow cannot be completed with assistive technology.`, executionIds: execIds, findingIds: [cause.findingId] });
        const f = ctx.findings.find((x) => x.id === cause.findingId);
        if (f && !f.obligationIds.includes(j.obligationId)) {
          f.obligationIds = [...f.obligationIds, j.obligationId];
          await ctx.store.putFinding(f);
        }
      } else retryJourneys.push(j);
    }
  }

  if (!retryScreens.length && !retryJourneys.length) return;
  await ctx.store.event("executing", `Repeating ${retryScreens.length} screen(s) and ${retryJourneys.length} journey(s) that failed, in a fresh sandbox`);
  const second = await runBrowser(ctx, image, plan, retryScreens, retryJourneys, `Reproduce ${retryScreens.length + retryJourneys.length} browser failure(s)`, first.exec.id);
  const both = [first.exec.id, second.exec.id];
  // What cybercheck itself set for the frontend: a wrong value here is the test setup at fault, not the product.
  const wiring = `Browser-side settings cybercheck set for this run (not the project's own configuration; if a failure comes from one of these values, it is a test_defect): ${Object.entries(frontendEnv(ctx, plan.frontend, plan.apps)).map(([k, v]) => `${k}=${v}`).join(", ")}.`;
  const logTail = (logs: string[]) => logs.map((l) => tail(l, 1200)).filter(Boolean).join("\n---\n");
  for (const screen of retryScreens) {
    const id = `ui:${screen.url}:renders`;
    const a = out.screens.find((x) => x.url === screen.url)!.viewports[0]!;
    const b = second.out?.screens.find((x) => x.url === screen.url)?.viewports[0];
    const bad = (r: ScreenRec | undefined) => !r || r.status == null || r.status >= 400 || screenProblems(r).length > 0;
    if (b && !bad(b)) {
      await setOb(ctx, id, { status: "inconclusive", reachedTarget: true, reason: `Failed once (${screenProblems(a)[0] ?? `status ${a.status}`}) but loaded cleanly when repeated.`, executionIds: both });
      continue;
    }
    const issues = [...(a.status == null ? [`did not load: ${a.error}`] : a.status >= 400 ? [`answered ${a.status}`] : []), ...screenProblems(a)];
    await setOb(ctx, id, { status: "failed", reachedTarget: true, reason: `${issues.slice(0, 3).join("; ")}.`, executionIds: both });
    candidates.push({
      source: "browser",
      label: `Screen ${screen.url}: ${issues[0] ?? "fails"}`,
      obligationIds: [id],
      executionIds: both,
      reproduced: b ? 2 : 1,
      of: 2,
      reproduction: `Start the backend and the built frontend (${plan.frontend.start}), then open ${screen.url} in a browser${a.as ? ` signed in as ${a.as}` : ""} and watch the console and network panels.`,
      context: [
        wiring,
        `A screen of the app was opened in Chromium (sandbox, no internet, synthetic settings, database filled only by the setup steps). Expected: it loads without uncaught errors, console errors or failed requests to the app.`,
        `Screen ${screen.url} (${screen.file})${a.as ? `, signed in as ${a.as}` : ""}. Observed: ${issues.join("; ")}.`,
        ...(a.as && a.forbidden?.length
          ? [
              `The screen was opened as "${a.as}", and a request it makes itself was refused with 403. If "${a.as}" is meant to open this screen (its navigation entry or route lists that role), the screen is broken for that role: a product defect. If the screen is not for "${a.as}", this is a test defect. Decide from the links to this screen and their role lists, never from variable names:`,
              [...ctx.src.files].flatMap(([p, f]) => f.text.split("\n").flatMap((l, i) => (l.includes(`"${screen.url}"`) || l.includes(`'${screen.url}'`) ? [`${p}:${i + 1}: ${l.trim().slice(0, 200)}`] : []))).slice(0, 4).join("\n") || "(no link to this screen found)",
            ]
          : []),
        `Reproduced in a second fresh sandbox: ${b ? "yes" : "not available"}.`,
        `Server and frontend log (end):\n${logTail(first.logs)}`,
        excerpt(ctx.src, screen.file, 1, 0, 120) ?? "",
      ].filter(Boolean).join("\n\n"),
      locations: [{ path: screen.file, line: 1 }],
      workspace: plan.frontend.workspace,
    });
  }
  for (const j of retryJourneys) {
    const a = out.journeys.find((x) => x.id === j.id)!;
    const b = second.out?.journeys.find((x) => x.id === j.id);
    if (b?.ok) {
      await setOb(ctx, j.obligationId, { status: "inconclusive", reachedTarget: true, reason: `Failed once (${a.why}) but passed when repeated in a fresh sandbox.`, executionIds: both });
      continue;
    }
    await setOb(ctx, j.obligationId, { status: "failed", reachedTarget: true, reason: `${a.why ?? "failed"}. A trace and a screenshot were saved.`, executionIds: both });
    const failing = a.failedStep != null ? j.steps[a.failedStep] : undefined;
    candidates.push({
      source: "browser",
      label: `Journey: ${j.title}`,
      obligationIds: [j.obligationId],
      executionIds: both,
      reproduced: b ? 2 : 1,
      of: 2,
      reproduction: [`Start the backend and the built frontend (${plan.frontend.start}) on an empty database${plan.graph.length ? `, run the setup steps (${plan.graph.map((n) => n.label).join("; ")})` : ""}, then in a browser${j.identity ? ` signed in as ${j.identity}` : ""}:`, ...j.steps.map((s, i) => `${i + 1}. ${s.action}${s.path ? ` ${s.path}` : ""}${s.target ? ` ${JSON.stringify(s.target)}` : ""}${s.value ? ` "${s.value}"` : ""}`), "Values like ${ENV:NAME} are cybercheck's synthetic settings."].join("\n"),
      context: [
        wiring,
        "A browser journey written by cybercheck's journey author (not by the project) failed in Chromium, twice in fresh sandboxes. The author may have misread the screens (a label or button that is named differently, a step in the wrong order): judge the journey against the screen code before blaming the product.",
        `Journey: ${j.title}. Expected result: ${j.oracle}.`,
        `Steps: ${JSON.stringify(j.steps)}`,
        `Failed at: ${a.why}${failing ? ` (step ${JSON.stringify(failing)})` : ""}. Address at failure: ${a.url}.`,
        `Page errors: ${(a.pageErrors ?? []).join("; ") || "none"}. Console errors: ${(a.consoleErrors ?? []).join("; ") || "none"}. Failed requests: ${(a.failedRequests ?? []).map((f) => `${f.url} ${f.status ?? f.error}`).join("; ") || "none"}.`,
        `Visible page text at failure:\n${(a.text ?? "").slice(0, 1200)}`,
        `Server and frontend log (end):\n${logTail(first.logs)}`,
        ...j.evidence.map((e) => excerpt(ctx.src, e.path, e.line, 20, 40)).filter(Boolean),
      ].join("\n\n"),
      locations: j.evidence,
      workspace: plan.frontend.workspace,
    });
  }
}
