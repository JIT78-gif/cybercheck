// Screenshots of the Testing live view and its replay, from a saved run (debug helper; needs the web app and
// API running). The run is served through route mocks with synthetic live actions and placeholder screenshots,
// so no sandbox runs, no AI is called and nothing is sent anywhere.
// Usage (repo root): npx tsx apps/web/scripts/live-shots.ts <run.json> <out-dir>
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { latestCode } from "../e2e/helpers";

type Ob = { id: string; layer: string; status: string; asset: { label: string } };
const [file, out = "live-shots"] = process.argv.slice(2);
const saved = JSON.parse(readFileSync(file!, "utf8"));

/** Live actions like the harnesses print, made from the saved run's obligations. */
function actionsFor(run: { obligations: Ob[] }) {
  const events: Array<{ seq: number; type: string; message: string; at: string; data?: unknown }> = [];
  let seq = 0;
  const t = Date.now() - 120_000;
  const push = (message: string, data?: unknown) => events.push({ seq: ++seq, type: data ? "live" : "phase:executing", message, at: new Date(t + seq * 900).toISOString(), ...(data ? { data } : {}) });
  push("Running build checks, the project's tests and the HTTP checks in parallel sandboxes");
  push('Setup "seed": done', { k: "note", text: 'Setup "seed": done (exit 0)' });
  push('Sign-in "admin": done', { k: "note", text: 'Sign-in "admin": done (sign-in answered 200)' });
  for (const o of run.obligations.filter((x) => x.layer === "api").slice(0, 40)) {
    const [method = "GET", path = "/"] = o.asset.label.split(" ");
    const ok = o.status !== "failed";
    push(`${method} ${path}`, { k: "req", method, path: path.replace(/\{[^}]+\}|:\w+/g, "1"), status: ok ? (method === "POST" ? 201 : 200) : 500, ms: 12 + (seq % 40), ok, as: seq % 3 ? "admin" : null, check: o.id });
  }
  const screens = [...new Set(run.obligations.filter((x) => x.layer === "ui" && x.id.endsWith(":renders")).map((x) => x.id.split(":")[1]!))].slice(0, 5);
  screens.forEach((url, i) => {
    for (const vp of [1440, 375]) {
      const marks = i === 1 ? [{ rule: "button-name", help: "Buttons must have discernible text", impact: "critical", box: { x: vp < 500 ? 300 : 1180, y: 22, w: 44, h: 36 } }, { rule: "label", help: "Form elements must have labels", impact: "critical", box: { x: vp < 500 ? 20 : 120, y: 360, w: vp < 500 ? 330 : 520, h: 44 } }] : [];
      push(`Opened ${url}`, { k: "screen", url, path: url.replace(/\[[^\]]+\]|:\w+/g, "1"), vp, status: 200, axe: marks.length, overflow: vp < 500 && i === 2 ? 5 : 0, as: "admin", shot: `s-${i}-${vp}.jpg`, exec: "exec-browser", marks });
    }
  });
  for (let n = 1; n <= 4; n++) push(`step ${n}`, { k: "step", journey: "journey-1", title: "Admin adds a menu item", n, of: 4, action: ["goto", "fill", "click", "expectText"][n - 1], target: [null, "Name", "Add item", "Coffee"][n - 1], ok: true, shot: `j-1-${n}.jpg`, exec: "exec-browser" });
  push("Load stage smoke", { k: "load", stage: "smoke", vus: 1, state: "start", rps: null, p95: null, errors: null });
  push("Load stage smoke done", { k: "load", stage: "smoke", vus: 1, state: "end", rps: 41.2, p95: 18, errors: 0 });
  return events;
}

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  // Placeholder "screenshots": the app's own landing page at both widths.
  const shotPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await shotPage.goto("http://localhost:3000/");
  const desktop = await shotPage.screenshot({ type: "jpeg", quality: 60 });
  await shotPage.setViewportSize({ width: 375, height: 812 });
  const phone = await shotPage.screenshot({ type: "jpeg", quality: 60 });
  await shotPage.close();

  const events = actionsFor(saved);
  const half = Math.floor(saved.obligations.length / 2);
  const runningRun = {
    ...saved,
    status: "running",
    phase: "executing",
    step: "Running build checks, the project's tests and the HTTP checks in parallel sandboxes",
    finishedAt: null,
    startedAt: new Date(Date.now() - 154_000).toISOString(),
    report: null,
    obligations: saved.obligations.map((o: Ob, i: number) => (i < half ? o : { ...o, status: i < half + 4 ? "running" : "planned" })),
    executions: saved.executions.map((e: { outcome: string }, i: number) => (i < 2 ? { ...e, outcome: "running" } : e)),
    counts: { ...saved.counts, terminal: half },
    usage: { ...saved.usage, costUsd: 0.071 },
  };

  for (const [mode, run] of [["live", runningRun], ["replay", saved]] as const) {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ baseURL: "http://localhost:3000", viewport: { width, height: width < 500 ? 812 : 1000 } });
      await page.setExtraHTTPHeaders({ "X-Forwarded-For": `198.18.9.${1 + Math.floor(Math.random() * 250)}` });
      const email = `live-shots-${Date.now()}@example.test`;
      const headers = { Origin: "http://localhost:3000" };
      const t0 = Date.now() - 1000;
      await page.request.post("/api/auth/sign-up/email", { data: { name: "Shots", email, password: "dashboard-test-password-1" }, headers });
      await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });
      await page.route(`**/v1/testing-runs/${run.id}/events**`, (r) => {
        const after = Number(new URL(r.request().url()).searchParams.get("after") ?? 0);
        return r.fulfill({ json: { events: events.filter((e) => e.seq > after) } });
      });
      await page.route(`**/v1/testing-runs/${run.id}/executions/**/artifacts/**`, (r) => r.fulfill({ body: /-375\.jpg/.test(r.request().url()) ? phone : desktop, contentType: "image/jpeg" }));
      await page.route(`**/v1/testing-runs/${run.id}`, (r) => r.fulfill({ json: { run: { ...run, projectSpendUsd: 0.42 } } }));
      await page.goto(`/app/projects/${run.projectId}/testing/${run.id}`);
      await page.getByRole("heading", { name: "Testing run" }).waitFor();
      if (mode === "replay") await page.getByText("Watch the run").click();
      await page.getByText("What the browser sees").first().waitFor();
      await page.waitForTimeout(1200);
      await page.getByRole("tab", { name: /Screens \(/ }).first().waitFor();
      await page.screenshot({ path: join(out, `${mode}-${width}.png`), fullPage: true });
      // The second screen carries the accessibility markers.
      const strip = page.getByRole("list", { name: "Screens opened" }).getByRole("button");
      if ((await strip.count()) > 1) {
        await strip.nth(1).click();
        await page.waitForTimeout(500);
        await page.getByText("What the browser sees").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `${mode}-${width}-markers.png`) });
      }
      await page.getByRole("tab", { name: /Journeys/ }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `${mode}-${width}-journey.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${mode} ${width}px: horizontal overflow ${overflow}px`);
      await page.close();
    }
  }
  await browser.close();
}

void main();
