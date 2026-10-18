// cybercheck AI output-rendering canary. Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node ai-canary.mjs <spec.json> <out-dir>
// Boots the app, signs the browser in the way the app's own code stores a session, opens each candidate page in
// Chromium, sends a message carrying a unique executable payload through the real input, and checks whether the
// payload's side effect actually fired in the page (real cross-site scripting) or only landed inert in the DOM.
// Writes <out-dir>/ai-canary.json: { ran, executed, page, detail, attempts }.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { client, ensureDirs, runGraph, runPrepare, sleep, startApp, stopApp } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const nonce = String(spec.canary.nonce);
// An <img>/<svg> whose handler runs real JavaScript (an injected <script> tag does not execute via innerHTML, these do).
const PAYLOAD = `<img src=x onerror="window.__ccxss='${nonce}'"><svg onload="window.__ccxss='${nonce}'"></svg> CCPLAIN-${nonce}`;
const result = { ran: false, executed: false, reflected: false, signedIn: false, page: null, detail: "The canary did not run.", attempts: [] };
const save = () => writeFileSync(`${outDir}/ai-canary.json`, JSON.stringify(result));
const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);
const handles = [];

async function main() {
  for (const app of spec.apps) {
    const env = { ...process.env, ...app.env };
    ensureDirs(app.env ?? {});
    const prep = await runPrepare(app, env);
    const bad = prep.find((p) => p.exitCode !== 0);
    if (bad) {
      result.detail = `${app.name} prepare "${bad.command}" failed (exit ${bad.exitCode}).`;
      return;
    }
    const h = await startApp(app, env, `${outDir}/${app.name}.log`, spec.bootTimeoutSec ?? 90);
    handles.push(h);
    if (!h.boot.ok) {
      result.detail = `${app.name} did not start: ${h.boot.reason}.`;
      return;
    }
  }
  const api = handles[0];
  const apiEnv = { ...process.env, ...spec.apps[0].env };
  const graph = await runGraph(spec.graph ?? [], { request: client(api.base, null), env: apiEnv, cwd: spec.apps[0].cwd, base: api.base });
  const front = spec.frontend.served ? api : await startApp(spec.frontend, { ...process.env, ...spec.frontend.env }, `${outDir}/frontend.log`, spec.bootTimeoutSec ?? 90);
  if (!spec.frontend.served) handles.push(front);
  if (!front.boot.ok) {
    result.detail = `the frontend did not start: ${front.boot.reason}.`;
    return;
  }
  const origin = `http://localhost:${spec.frontend.port}`;

  // Sign the browser in the way the app stores a session: the token or sign-in body from the API setup, placed in the
  // cookie, localStorage or sessionStorage the frontend's own code reads (spec.sessions), plus any cookie sign-in.
  const injected = { cookies: [], storage: [] };
  for (const s of spec.sessions ?? []) {
    const raw = graph.sessions?.[s.identity];
    if (!raw || graph.ok?.get?.(s.identity) !== true) continue;
    const value = s.form === "json" ? (raw.body && typeof raw.body === "object" ? JSON.stringify(raw.body) : null) : raw.token;
    if (!value) continue;
    const v = s.encode === "uri" ? encodeURIComponent(value) : value;
    if (s.area === "cookie") injected.cookies.push({ name: s.key, value: v, domain: "localhost", path: "/", sameSite: "Lax" });
    else injected.storage.push({ area: s.area, key: s.key, value: v });
  }
  for (const a of Object.values(graph.auths ?? {})) for (const [name, value] of Object.entries(a.cookies ?? {})) injected.cookies.push({ name, value: String(value), domain: "localhost", path: "/", sameSite: "Lax" });
  result.signedIn = injected.cookies.length + injected.storage.length > 0;
  result.sessionDetail = `cookies=[${injected.cookies.map((c) => c.name).join(",")}] storage=[${injected.storage.map((s) => `${s.area}:${s.key}`).join(",")}] specSessions=${(spec.sessions ?? []).length} graphIds=${Object.keys(graph.sessions ?? {}).length}`;
  save();

  const { chromium } = await import(`${spec.browserDir}/node_modules/playwright/index.mjs`);
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  for (const path of spec.canary.pages) {
    const attempt = { page: path, opened: false, submitted: false, executed: false, inert: false, why: null };
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    if (injected.cookies.length) await ctx.addCookies(injected.cookies).catch(() => {});
    if (injected.storage.length)
      await ctx.addInitScript((items) => {
        for (const it of items) {
          try {
            window[it.area].setItem(it.key, it.value);
          } catch {}
        }
      }, injected.storage);
    const page = await ctx.newPage();
    // The payload's handler sets window.__ccxss to the nonce; a dialog or a pageerror naming the nonce also counts.
    let executed = false;
    page.on("dialog", (d) => ((executed = executed || d.message().includes(nonce)), d.dismiss().catch(() => {})));
    page.on("pageerror", (e) => (executed = executed || firstLine(e).includes(nonce)));
    try {
      await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await sleep(400);
      attempt.opened = true;
      // Find a free-text input, type the payload, and submit it the way a person would.
      const input = page.locator("textarea, input[type=text], input[type=search], input:not([type]):not([type=hidden]):not([type=password]):not([type=submit]):not([type=checkbox]):not([type=radio])").first();
      if (!(await input.count().catch(() => 0))) {
        attempt.why = "no free-text input on the page";
      } else {
        await input.fill(PAYLOAD, { timeout: 8000 });
        const button = page.getByRole("button", { name: /send|ask|submit|chat|message|go|run/i }).first();
        if (await button.count().catch(() => 0)) await button.click({ timeout: 8000 }).catch(() => {});
        else await input.press("Enter").catch(() => {});
        attempt.submitted = true;
        // The reply returns and is rendered: poll for the side effect (and whether the payload reached the DOM inert).
        for (let i = 0; i < 24 && !executed; i++) {
          executed = await page.evaluate((n) => (window).__ccxss === n, nonce).catch(() => false);
          if (executed) break;
          await sleep(300);
        }
        attempt.inert = await page.evaluate((n) => document.body?.innerHTML?.includes(`CCPLAIN-${n}`) ?? false, nonce).catch(() => false);
      }
    } catch (e) {
      attempt.why = firstLine(e);
    }
    attempt.executed = executed;
    result.attempts.push(attempt);
    await ctx.close();
    if (attempt.submitted) result.ran = true;
    if (attempt.inert) result.reflected = true;
    if (executed) {
      result.executed = true;
      result.page = path;
      result.detail = `A message carrying an executable payload was reflected into the page at ${path} and its script ran in the browser (confirmed cross-site scripting).`;
      break;
    }
    save();
  }
  await browser.close();
  if (!result.executed) {
    const sent = result.attempts.find((a) => a.submitted);
    result.detail = !result.ran
      ? `The canary could not drive any assistant page (${result.attempts.map((a) => `${a.page}: ${a.why ?? (a.opened ? "no submit control" : "did not open")}`).join("; ") || "no candidate page"}).`
      : sent?.inert
        ? "The payload was reflected into the page but did not execute (it appears escaped); no script ran."
        : "A message was sent but the payload did not execute and was not seen reflected into the page.";
  }
}

try {
  await main();
} catch (e) {
  result.detail = `The canary failed: ${firstLine(e)}`;
}
for (const h of handles.reverse()) await stopApp(h);
save();
console.log(`ai-canary: ran=${result.ran} executed=${result.executed} reflected=${result.reflected} signedIn=${result.signedIn}${result.page ? ` page=${result.page}` : ""} - ${result.detail}`);
process.exit(0);
