// cybercheck browser harness. Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node browser.mjs <spec.json> <out-dir>
// Starts the backend app(s) and the built frontend, runs the fixture graph, then opens every screen in
// Chromium (errors, failed requests, axe-core WCAG rules, phone-width overflow), signs in through the UI
// and runs the user journeys, saving a trace and a screenshot for each failure. Writes <out-dir>/browser.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { client, emit, ensureDirs, fill, mask, runGraph, runPrepare, sleep, startApp, stopApp } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const result = { apps: [], fixtures: [], logins: [], screens: [], journeys: [], error: null };
/** A page showing only a signed-out, expired or access-denied state (the same rule the report uses). */
const SIGNED_OUT = /session (has )?expired|(please|you must|need to) (sign|log) ?in|not (signed|logged) in|(sign|log) ?in to continue|re-?scan the qr|no (active )?session|unauthori[sz]ed|access denied|you don't have access/i;
const save = () => writeFileSync(`${outDir}/browser.json`, JSON.stringify(result));
// Screenshots for the live view, bundled in one file (one fetch instead of one per image): name -> base64 JPEG.
const shots = {};
let shotBytes = 0;
const saveShots = () => writeFileSync(`${outDir}/shots.json`, JSON.stringify(shots));
async function shoot(page, name) {
  if (shotBytes > 12_000_000) return null;
  const buf = await page.screenshot({ type: "jpeg", quality: 60, timeout: 8000 }).catch(() => null);
  if (!buf) return null;
  shots[name] = buf.toString("base64");
  shotBytes += buf.length;
  return name;
}
const slugOf = (url) => url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "home";
const handles = [];
const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);

async function main() {
  // ---------------- apps: backends first, then the frontend that calls them
  for (const app of spec.apps) {
    const env = { ...process.env, ...app.env };
    ensureDirs(app.env ?? {});
    const prep = await runPrepare(app, env);
    const bad = prep.find((p) => p.exitCode !== 0);
    if (bad) {
      result.apps.push({ name: app.name, ok: false, reason: `"${bad.command}" failed (exit ${bad.exitCode}): ${bad.tail.slice(-300)}`, ms: null });
      return;
    }
    const h = await startApp(app, env, `${outDir}/${app.name}.log`, spec.bootTimeoutSec ?? 90);
    handles.push(h);
    result.apps.push({ name: app.name, ok: h.boot.ok, reason: h.boot.reason, ms: h.boot.ms });
    if (!h.boot.ok) return;
  }
  const api = handles[0];
  const apiEnv = { ...process.env, ...spec.apps[0].env };
  const graph = await runGraph(spec.graph ?? [], { request: client(api.base, null), env: apiEnv, cwd: spec.apps[0].cwd, base: api.base });
  result.fixtures = graph.results;
  const front = await startApp(spec.frontend, { ...process.env, ...spec.frontend.env }, `${outDir}/frontend.log`, spec.bootTimeoutSec ?? 90);
  handles.push(front);
  result.apps.push({ name: "frontend", ok: front.boot.ok, reason: front.boot.reason, ms: front.boot.ms });
  save();
  if (!front.boot.ok) return;
  // Pages open on "localhost": typical development CORS settings allow http://localhost:PORT, not 127.0.0.1.
  const origin = `http://localhost:${spec.frontend.port}`;
  const ownHosts = new Set([new URL(origin).host, ...handles.map((h) => new URL(h.base).host), "localhost", "127.0.0.1"]);
  const own = (u) => {
    try {
      const x = new URL(u);
      return ownHosts.has(x.host) || x.hostname === "127.0.0.1" || x.hostname === "localhost" || x.hostname === "[::1]";
    } catch {
      return true;
    }
  };

  const { chromium } = await import(`${spec.browserDir}/node_modules/playwright/index.mjs`);
  const axeSource = readFileSync(`${spec.browserDir}/node_modules/axe-core/axe.min.js`, "utf8");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const vars = { ...graph.vars };

  // ---------------- sessions the API setup created, handed to the browser the way the frontend stores them
  // (spec.sessions comes from the frontend's own code: a token or the sign-in answer as JSON, in a cookie,
  // localStorage or sessionStorage). A real sign-in through the UI is always preferred; this is the fallback,
  // and the only way for a guest session that has no login form (a customer check-in).
  const injected = {};
  const entryFor = (who) => (injected[who] ??= { cookies: [], storage: [] });
  for (const s of spec.sessions ?? []) {
    const raw = graph.sessions?.[s.identity];
    if (!raw || graph.ok.get(s.identity) !== true) continue;
    const value = s.form === "json" ? (raw.body && typeof raw.body === "object" ? JSON.stringify(raw.body) : null) : raw.token;
    if (!value) continue;
    const v = s.encode === "uri" ? encodeURIComponent(value) : value;
    if (s.area === "cookie") entryFor(s.identity).cookies.push({ name: s.key, value: v, domain: "localhost", path: "/", sameSite: "Lax" });
    else entryFor(s.identity).storage.push({ area: s.area, key: s.key, value: v });
  }
  // A cookie-based API sign-in: its session cookie works for the frontend on the same host too.
  for (const [who, a] of Object.entries(graph.auths ?? {})) {
    if (graph.ok.get(who) !== true) continue;
    for (const [name, value] of Object.entries(a.cookies ?? {})) entryFor(who).cookies.push({ name, value: String(value), domain: "localhost", path: "/", sameSite: "Lax" });
  }
  result.sessions = Object.entries(injected).map(([identity, x]) => ({ identity, cookies: x.cookies.map((c) => c.name), storage: x.storage.map((e) => `${e.area}:${e.key}`) }));
  /** A browser context signed in as `who`: its UI sign-in when there is one, else the session from the API setup. */
  async function contextFor(who, options) {
    const ui = who ? states[who] : null;
    const ctx = await browser.newContext({ ...options, ...(ui ? { storageState: ui } : {}) });
    const inj = who && !ui ? injected[who] : null;
    if (inj?.cookies.length) await ctx.addCookies(inj.cookies).catch(() => {});
    if (inj?.storage.length)
      await ctx.addInitScript((items) => {
        for (const it of items) {
          try {
            window[it.area].setItem(it.key, it.value);
          } catch {}
        }
      }, inj.storage);
    return ctx;
  }
  const signedIn = (who) => Boolean(states[who] || injected[who]);
  const howSigned = (who) => (!who ? null : states[who] ? "ui" : injected[who] ? "session" : null);
  // One generated value per journey: the step that types it and the step that looks for it must agree.
  let journeyUid = `${Date.now() % 100000000}`;
  const values = (v) => fill(v, { ...vars, $uid: journeyUid }, apiEnv);

  /** Collects what goes wrong on a page: uncaught exceptions, console errors, failed or 5xx requests. */
  const watch = (page) => {
    const w = { pageErrors: [], consoleErrors: [], failedRequests: [], external: 0 };
    page.on("pageerror", (e) => w.pageErrors.push(firstLine(e)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const loc = m.location()?.url ?? "";
      if (loc && !own(loc)) return w.external++;
      const text = m.text().slice(0, 300);
      // Resource load failures are reported as requests below; offline fetches to other hosts are environment noise.
      if (/Failed to load resource|net::ERR_/.test(text)) return;
      w.consoleErrors.push(text);
    });
    page.on("requestfailed", (r) => {
      const why = r.failure()?.errorText ?? "failed";
      // A request the page itself cancelled (navigation, a superseded prefetch) is not a failure.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) return;
      if (own(r.url())) w.failedRequests.push({ url: r.url().replace(origin, ""), status: null, error: why });
      else w.external++;
    });
    page.on("response", (r) => {
      if (r.status() >= 500 && own(r.url())) w.failedRequests.push({ url: r.url().replace(origin, ""), status: r.status(), error: null });
      // A data request the page itself makes, refused with 403 to the signed-in user: the screen shows something its
      // own user may not load (judged only for signed-in screens).
      else if (r.status() === 403 && own(r.url()) && r.request().resourceType() !== "document") w.forbidden = [...(w.forbidden ?? []), `${r.request().method()} ${r.url().replace(origin, "").replace(/^https?:\/\/[^/]+/, "")}`];
    });
    return w;
  };

  // Real pages often break the accessible wiring (a <label> not linked to its input), so each target
  // falls back to the next most specific way a person would find the same element.
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const fieldNear = (page, text) => page.locator(`xpath=//label[normalize-space(.)="${esc(text)}"]/following::*[self::input or self::textarea or self::select][1]`);
  /** Ways to find a target, most specific first. A fallback is used only when nothing more specific matches. */
  const candidates = (page, t) => {
    if (!t) throw new Error("no target");
    if (t.testId) return [page.getByTestId(t.testId)];
    if (t.role) return t.name ? [page.getByRole(t.role, { name: t.name, exact: true }), page.getByRole(t.role, { name: t.name }), page.getByText(t.name, { exact: true })] : [page.getByRole(t.role)];
    if (t.label) {
      const n = String(t.label).toLowerCase();
      return [page.getByLabel(t.label, { exact: true }), page.getByLabel(t.label), fieldNear(page, t.label), page.getByPlaceholder(t.label), page.locator(`input[name="${esc(n)}"], input[type="${esc(n)}"], textarea[name="${esc(n)}"]`)];
    }
    if (t.placeholder) return [page.getByPlaceholder(t.placeholder, { exact: true }), page.getByPlaceholder(t.placeholder), page.getByLabel(t.placeholder)];
    if (t.text) return [page.getByText(t.text, { exact: true }), page.getByText(t.text)];
    if (t.name) return [page.getByText(t.name, { exact: true }), page.getByText(t.name)];
    throw new Error("empty target");
  };
  /** The first candidate that is on the page, waiting up to 10 s for one to appear. */
  async function locate(page, t) {
    const list = candidates(page, t);
    const deadline = Date.now() + 10000;
    for (;;) {
      for (const c of list) if ((await c.count().catch(() => 0)) > 0) return c.first();
      if (Date.now() > deadline) return list[0].first();
      await sleep(250);
    }
  }
  async function runSteps(page, steps, onStep = null) {
    journeyUid = `${Date.now() % 100000000}`;
    for (let i = 0; i < steps.length; i++) {
      const st = values(steps[i]);
      try {
        if (st.action === "goto") {
          await page.goto(`${origin}${st.path}`, { waitUntil: "load", timeout: 20000 });
          // Typing before the framework hydrates leaves text in the DOM that its state never sees
          // (a React form then posts empty fields): wait for the page to settle first.
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await sleep(500);
        }
        else if (st.action === "fill") await (await locate(page, st.target)).fill(String(st.value ?? ""), { timeout: 10000 });
        else if (st.action === "select") await (await locate(page, st.target)).selectOption(String(st.value ?? ""), { timeout: 10000 });
        else if (st.action === "check") await (await locate(page, st.target)).check({ timeout: 10000 });
        else if (st.action === "click") await (await locate(page, st.target)).click({ timeout: 10000 });
        else if (st.action === "press") await (await locate(page, st.target)).press(String(st.value ?? "Enter"), { timeout: 10000 });
        else if (st.action === "waitFor" || st.action === "expectVisible") await (await locate(page, st.target)).waitFor({ state: "visible", timeout: 10000 });
        else if (st.action === "expectText") await (st.target ? (await locate(page, st.target)).filter({ hasText: String(st.value) }) : page.getByText(String(st.value)).first()).waitFor({ state: "visible", timeout: 10000 });
        else if (st.action === "expectUrl") {
          const deadline = Date.now() + 10000;
          while (!page.url().includes(String(st.value)) && Date.now() < deadline) await sleep(200);
          if (!page.url().includes(String(st.value))) throw new Error(`the address is ${page.url().replace(origin, "")}, expected it to contain ${st.value}`);
        }
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        if (onStep) await onStep(i, st, true);
      } catch (e) {
        if (onStep) await onStep(i, st, false);
        return { ok: false, failedStep: i, why: `step ${i + 1} (${st.action}${st.target ? ` ${JSON.stringify(st.target)}` : st.path ? ` ${st.path}` : ""}): ${firstLine(e)}` };
      }
    }
    return { ok: true, failedStep: null, why: null };
  }

  // ---------------- sign in through the UI once per identity; keep the browser state
  const states = {};
  for (const l of spec.logins ?? []) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const w = watch(page);
    const answers = [];
    page.on("response", (res) => {
      if (own(res.url()) && res.request().resourceType() !== "document" && /fetch|xhr/.test(res.request().resourceType())) {
        // The body the page sent (secrets hidden), so a sign-in that posts the wrong fields can be told apart from wrong credentials.
        const sent = res.request().method() === "GET" ? "" : ` sent ${mask(String(res.request().postData() ?? "").slice(0, 200))}`;
        answers.push(`${res.request().method()} ${res.url().replace(origin, "")} ${res.status()}${sent}`);
      }
    });
    const r = await runSteps(page, l.steps);
    if (r.ok) states[l.identity] = await ctx.storageState();
    const text = r.ok ? null : (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
    result.logins.push({ identity: l.identity, ok: r.ok, why: r.ok ? null : `${r.why}${answers.length ? `; the page's requests: ${answers.slice(-4).join(", ")}` : "; the page sent no request"}${text ? `; visible text: ${text.slice(0, 240)}` : ""}`, url: page.url().replace(origin, ""), pageErrors: w.pageErrors.slice(0, 5), failedRequests: w.failedRequests.slice(0, 5) });
    await ctx.close();
  }
  save();

  // ---------------- screens: load, errors, accessibility and phone-width overflow
  // Every plain value in the setup answers (top level, and nested ids as parent_id), for addresses like /c/:cafeId/:tableId.
  const fields = {};
  for (const body of Object.values(graph.bodies ?? {})) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    for (const [k2, v2] of Object.entries(body)) {
      if (v2 != null && typeof v2 !== "object") fields[k2] ??= v2;
      else if (v2 && typeof v2 === "object" && !Array.isArray(v2) && v2.id != null) fields[`${k2}_id`] ??= v2.id;
    }
  }
  const fillParams = (path) => path.replace(/\[\[?\.\.\.(\w+)\]?\]|\[(\w+)\]|:(\w+)|\{(\w+)\}/g, (_m, a, b, c, d) => {
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
    const n = norm(a ?? b ?? c ?? d);
    const k = Object.keys(vars).find((x) => norm(x) === n || norm(x).endsWith(n));
    if (k) return String(vars[k]);
    const f = Object.keys(fields).find((x) => norm(x) === n) ?? Object.keys(fields).find((x) => norm(x).endsWith(n));
    return f ? String(fields[f]) : /id$/.test(n) ? "1" : "sample";
  });
  for (const s of spec.screens ?? []) {
    const path = fillParams(s.url);
    const entry = { url: s.url, path, as: null, viewports: [] };
    for (const vp of spec.viewports) {
      // A role's own screens are opened as that role (/staff/... as "staff"): opened as admin, a staff screen that
      // calls an admin-only endpoint would look fine.
      const segs = path.toLowerCase().split(/[/?#]/).filter(Boolean);
      const mine = (name) => segs.some((g) => g.length > 2 && name.toLowerCase().includes(g.replace(/s$/, "")));
      const attempts = [null, ...[...new Set([...Object.keys(states), ...Object.keys(injected)])].sort((a, b) => Number(mine(b)) - Number(mine(a)))];
      let rec = null;
      let best = null;
      for (const who of attempts) {
        const ctx = await contextFor(who, { viewport: { width: vp, height: vp < 500 ? 812 : 900 } });
        const page = await ctx.newPage();
        const w = watch(page);
        let status = null;
        let error = null;
        try {
          const res = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 20000 });
          status = res?.status() ?? null;
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          await sleep(300);
        } catch (e) {
          error = firstLine(e);
        }
        const finalPath = page.url().replace(origin, "");
        const redirectedToLogin = finalPath.split("?")[0] !== path.split("?")[0] && /login|sign-?in|auth/i.test(finalPath);
        const text = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 500)).catch(() => "");
        rec = { viewport: vp, as: who, how: howSigned(who), status, error, finalPath, redirectedToLogin, ...w, text, axe: null, overflowPx: null, overflowing: [] };
        if (!redirectedToLogin && status != null) {
          // Desktop and phone width: a mobile-only bar or menu is hidden at desktop width, so axe never sees it there.
          if (vp === spec.viewports[0] || vp < 500) {
            try {
              await page.addScriptTag({ content: axeSource });
              rec.axe = await page.evaluate(async () => {
                const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
                return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.slice(0, 5).map((n) => {
                  const el = document.querySelector(n.target[0]);
                  const b = el ? el.getBoundingClientRect() : null;
                  return { target: n.target.join(" "), html: n.html.slice(0, 200), summary: (n.failureSummary ?? "").slice(0, 200), box: b && b.width > 0 ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null };
                }), count: v.nodes.length }));
              });
            } catch (e) {
              rec.axe = { error: firstLine(e) };
            }
          }
          if (vp < 500) {
            const o = await page.evaluate(() => {
              const vw = window.innerWidth;
              const over = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - vw;
              const culprits = [];
              if (over > 2) {
                for (const el of document.querySelectorAll("body *")) {
                  const r = el.getBoundingClientRect();
                  if (r.right > vw + 2 && r.width > 0 && culprits.length < 3) culprits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 2).join(".")}` : ""} (${Math.round(r.right - vw)} px)`);
                }
              }
              return { over, culprits };
            });
            rec.overflowPx = Math.max(0, Math.round(o.over));
            rec.overflowing = o.culprits;
          }
        }
        rec.shot = status != null ? await shoot(page, `s-${slugOf(s.url)}-${vp}-${slugOf(who ?? "anonymous")}.jpg`) : null;
        await ctx.close();
        // Sent elsewhere (a login page, or home when a session is missing), or shown only a signed-out state
        // ("Session expired"): try the next sign-in. The best attempt is what gets reported.
        const sentAway = finalPath.split("?")[0].replace(/\/+$/, "") !== path.split("?")[0].replace(/\/+$/, "");
        if (!sentAway && !(SIGNED_OUT.test(text) && text.length < 300)) {
          best = rec;
          break;
        }
        // A page reached with a session that only redirected onwards (a redirect-only address) beats a later
        // attempt that ended on the login page.
        if (!redirectedToLogin && status != null && !(SIGNED_OUT.test(text) && text.length < 300)) best ??= rec;
      }
      rec = best ?? rec;
      entry.as = entry.as ?? rec.as;
      entry.viewports.push(rec);
      emit({ k: "screen", url: s.url, path, vp, status: rec.status, axe: Array.isArray(rec.axe) ? rec.axe.filter((v) => v.impact === "critical" || v.impact === "serious").length : null, overflow: rec.overflowPx, as: rec.as, shot: rec.shot, marks: Array.isArray(rec.axe) ? rec.axe.filter((v) => v.impact === "critical" || v.impact === "serious").flatMap((v) => v.nodes.filter((n) => n.box).map((n) => ({ rule: v.id, help: String(v.help).slice(0, 120), impact: v.impact ?? null, box: n.box }))).slice(0, 10) : [] });
    }
    result.screens.push(entry);
    save();
    saveShots();
  }

  // ---------------- journeys, each in a fresh context after its identity's UI sign-in
  for (const j of spec.journeys ?? []) {
    if (j.identity && !signedIn(j.identity)) {
      result.journeys.push({ id: j.id, ok: false, blocked: `signing in as ${j.identity} in the browser did not work`, steps: j.steps.length });
      continue;
    }
    const ctx = await contextFor(j.identity, { viewport: { width: 1440, height: 900 } });
    await ctx.tracing.start({ screenshots: true, snapshots: true });
    const page = await ctx.newPage();
    const w = watch(page);
    const t0 = Date.now();
    const r = await runSteps(page, j.steps, async (i, st, ok) => {
      const shot = await shoot(page, `j-${slugOf(j.id)}-${i + 1}.jpg`);
      const target = st.target ? st.target.name ?? st.target.label ?? st.target.text ?? st.target.placeholder ?? st.target.testId ?? null : st.path ?? st.value ?? null;
      emit({ k: "step", journey: j.id, title: j.title ?? j.id, n: i + 1, of: j.steps.length, action: st.action, target: target == null ? null : String(target).slice(0, 80), ok, shot });
    });
    const rec = { id: j.id, ok: r.ok && !w.pageErrors.length, why: r.why ?? (w.pageErrors.length ? `uncaught error in the page: ${w.pageErrors[0]}` : null), failedStep: r.failedStep, ms: Date.now() - t0, url: page.url().replace(origin, ""), pageErrors: w.pageErrors.slice(0, 5), consoleErrors: w.consoleErrors.slice(0, 5), failedRequests: w.failedRequests.slice(0, 5), text: null, trace: null, screenshot: null };
    if (!rec.ok) {
      rec.text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 1500);
      await page.screenshot({ path: `${outDir}/${j.id}.png`, fullPage: true }).catch(() => {});
      await ctx.tracing.stop({ path: `${outDir}/${j.id}.trace.zip` }).catch(() => {});
      rec.screenshot = `${j.id}.png`;
      rec.trace = `${j.id}.trace.zip`;
    } else await ctx.tracing.stop().catch(() => {});
    await ctx.close();
    result.journeys.push(rec);
    save();
    saveShots();
  }
  await browser.close();
}

try {
  await main();
} catch (e) {
  result.error = firstLine(e);
}
for (const h of handles.reverse()) await stopApp(h);
save();
console.log(`browser: apps=${result.apps.map((a) => `${a.name}:${a.ok}`).join(",")} screens=${result.screens.length} journeys=${result.journeys.filter((j) => j.ok).length}/${result.journeys.length}${result.error ? ` error=${result.error}` : ""}`);
process.exit(0);
