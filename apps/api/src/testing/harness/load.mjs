// cybercheck load harness (Devast). Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node load.mjs <spec.json> <out-dir>
// Starts the app, signs in through the fixture graph, keeps only requests that answer without a server
// error, then runs k6 stages (smoke, average, stress, spike, breakpoint) against the app on this machine only
// and checks that the app still answers afterwards. Writes <out-dir>/load.json, plus k6's own HTML report of
// each stage (<out-dir>/k6-<stage>.html).
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { breakpointOf, client, emit, ensureDirs, fill, loadSeries, run, runGraph, sleep, startApp, stopApp, unfilled } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const env = { ...process.env, ...spec.env };
ensureDirs(spec.env ?? {});
const result = { boot: null, requests: [], excluded: [], stages: [], recovery: null, error: null };
const save = () => writeFileSync(`${outDir}/load.json`, JSON.stringify(result));

const users = (vus, stages) => ({ vus, scenario: { executor: "ramping-vus", startVUs: 1, stages, gracefulRampDown: "5s" } });
const STAGES = {
  smoke: users(1, [{ duration: "20s", target: 1 }]),
  average: users(20, [{ duration: "15s", target: 20 }, { duration: "45s", target: 20 }]),
  stress: users(50, [{ duration: "15s", target: 50 }, { duration: "45s", target: 50 }]),
  spike: users(100, [{ duration: "10s", target: 100 }, { duration: "20s", target: 100 }, { duration: "5s", target: 0 }]),
  // A rising request rate over 2 minutes; k6 stops early once the app stays unhealthy. The top rate is set when it
  // runs, from what the earlier stages reached (see breakpointStage), so a fast app is pushed past its pace.
  breakpoint: { vus: 300, abort: true, scenario: { executor: "ramping-arrival-rate", startRate: 5, timeUnit: "1s", preAllocatedVUs: 50, maxVUs: 300, stages: [{ duration: "120s", target: 400 }] } },
};

/** The breakpoint ramp: up to twice the best rate an earlier stage reached (at least 400, at most 5000 per second). */
function breakpointStage(earlierRps) {
  const target = Math.min(5000, Math.max(400, Math.round((Math.max(0, ...earlierRps) * 2) / 50) * 50));
  const maxVUs = Math.min(1000, Math.max(300, Math.round(target / 4)));
  return { ...STAGES.breakpoint, vus: maxVUs, scenario: { ...STAGES.breakpoint.scenario, preAllocatedVUs: Math.min(100, maxVUs), maxVUs, stages: [{ duration: "120s", target }] } };
}

/** The per-second series of one stage from k6's gzipped CSV, read line by line; the file is removed after. */
async function seriesOf(path) {
  if (!existsSync(path)) return [];
  const series = loadSeries();
  try {
    const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const l of lines) series.line(l);
  } catch {
    // a file cut short (k6 stopped) still gives the seconds before the cut
  }
  rmSync(path, { force: true });
  return series.points();
}

const SCRIPT = `import http from "k6/http";
import { Counter } from "k6/metrics";
const reqs = JSON.parse(open("/cc/load-reqs.json"));
const s4 = new Counter("status_4xx");
const s429 = new Counter("status_429");
const s5 = new Counter("status_5xx");
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));
// Always-true thresholds per endpoint make k6 report each endpoint's latency and failures separately.
const perEndpoint = {};
for (const r of reqs) {
  perEndpoint["http_req_duration{name:" + r.path + "}"] = ["max>=0"];
  perEndpoint["http_req_failed{name:" + r.path + "}"] = ["rate>=0"];
}
// The breakpoint stage stops once the app is unhealthy for a while: over 5% failures or a p95 over 2 s.
const abort = __ENV.ABORT === "1" ? { http_req_failed: [{ threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "10s" }], http_req_duration: [{ threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "10s" }] } : {};
export const options = { scenarios: { main: JSON.parse(__ENV.SCENARIO) }, thresholds: { ...perEndpoint, ...abort }, summaryTrendStats: ["p(50)", "p(95)", "max"], discardResponseBodies: true };
export default function () {
  const r = reqs[Math.floor(Math.random() * reqs.length)];
  const res = http.request(r.method, __ENV.BASE + r.path, r.body ?? null, { headers: r.headers, timeout: "10s", tags: { name: r.path } });
  if (res.status >= 500 || res.status === 0) s5.add(1);
  else if (res.status === 429) s429.add(1);
  else if (res.status >= 400) s4.add(1);
}
`;

const h = await startApp(spec.app, env, `${outDir}/server.log`, spec.bootTimeoutSec ?? 90);
result.boot = h.boot;
try {
  if (h.boot.ok) {
    const request = client(h.base, null);
    const graph = await runGraph(spec.graph ?? [], { request, env, cwd: spec.app.cwd, base: h.base });
    // Requests whose identity worked, filled in, and answering without a server error once.
    for (const r of spec.requests) {
      if (r.identity && graph.ok.get(r.identity) !== true) {
        result.excluded.push({ path: r.path, why: `sign-in as ${r.identity} did not work` });
        continue;
      }
      const step = fill({ method: r.method, path: r.path }, { ...graph.vars, $uid: "1" }, env);
      if (unfilled(step)) {
        result.excluded.push({ path: r.path, why: "needs data the setup did not create" });
        continue;
      }
      const auth = r.identity ? graph.auths[r.identity] : null;
      const headers = { ...(auth?.headers ?? {}) };
      if (auth?.cookies && Object.keys(auth.cookies).length) headers.cookie = Object.entries(auth.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await request({ method: step.method, path: step.path }, auth);
      if (res.status == null || res.status >= 500 || res.status === 401 || res.status === 403) {
        result.excluded.push({ path: step.path, why: `answered ${res.status ?? res.error} before the load test` });
        continue;
      }
      // A single request this slow is a stream or long poll, not a normal read: load numbers would only measure the wait.
      if (res.ms > 3000) {
        result.excluded.push({ path: step.path, why: `a single request took ${(res.ms / 1000).toFixed(1)} s (a stream or long poll)` });
        continue;
      }
      result.requests.push({ method: step.method, path: step.path, headers, identity: r.identity ?? null });
    }
    save();
    if (result.requests.length) {
      writeFileSync("/cc/load-reqs.json", JSON.stringify(result.requests));
      writeFileSync("/cc/load.js", SCRIPT);
      for (const name of spec.stages) {
        const st = name === "breakpoint" ? breakpointStage(result.stages.filter((s) => s.appAlive).map((s) => s.rps)) : STAGES[name];
        emit({ k: "load", stage: name, vus: st.vus, state: "start", rps: null, p95: null, errors: null });
        const t0 = Date.now();
        const csv = `/tmp/cc-k6-${name}.csv.gz`;
        const html = `${outDir}/k6-${name}.html`;
        const k6 = (extras) =>
          run(spec.k6, ["run", "--quiet", "--no-color", `--summary-export=${outDir}/k6-${name}.json`, ...(extras ? [`--out=csv=${csv}`] : []), "/cc/load.js"], {
            // k6's built-in web dashboard, listening on this machine only, exports its HTML report when the stage ends.
            env: { ...process.env, BASE: h.base, SCENARIO: JSON.stringify(st.scenario), ABORT: st.abort ? "1" : "", ...(extras ? { K6_WEB_DASHBOARD: "true", K6_WEB_DASHBOARD_HOST: "127.0.0.1", K6_WEB_DASHBOARD_PORT: "5665", K6_WEB_DASHBOARD_PERIOD: "2s", K6_WEB_DASHBOARD_EXPORT: html } : {}) },
            timeoutMs: 240000,
            stopWhen: () => Boolean(h.exited),
          });
        const metrics = () => {
          try {
            return JSON.parse(readFileSync(`${outDir}/k6-${name}.json`, "utf8")).metrics;
          } catch {
            return null;
          }
        };
        let r = await k6(true);
        let m = metrics();
        // Without a summary, the extras (CSV, dashboard) may be what failed: the stage itself is worth one plain retry.
        if (!m && !h.exited) {
          r = await k6(false);
          m = metrics();
        }
        const series = await seriesOf(csv);
        const bp = st.abort ? breakpointOf(series, { appExited: Boolean(h.exited), droppedIterations: m?.dropped_iterations?.count ?? 0 }) : null;
        const count = (k) => m?.[k]?.count ?? 0;
        const total = m?.http_reqs?.count ?? 0;
        result.stages.push({
          name,
          vus: st.abort ? Math.max(1, ...series.map((p) => p.vus ?? 0)) : st.vus,
          series,
          limitRps: bp?.limitRps ?? null,
          brokeBy: bp?.brokeBy ?? null,
          reportName: existsSync(html) ? `k6-${name}.html` : null,
          durationSec: Math.round((Date.now() - t0) / 1000),
          requests: total,
          rps: Math.round((m?.http_reqs?.rate ?? 0) * 10) / 10,
          errorRatePct: total ? Math.round(((m?.http_req_failed?.value ?? m?.http_req_failed?.rate ?? 0) * 100) * 100) / 100 : 100,
          p50Ms: m?.http_req_duration?.["p(50)"] != null ? Math.round(m.http_req_duration["p(50)"] * 10) / 10 : null,
          p95Ms: m?.http_req_duration?.["p(95)"] != null ? Math.round(m.http_req_duration["p(95)"] * 10) / 10 : null,
          maxMs: m?.http_req_duration?.max != null ? Math.round(m.http_req_duration.max) : null,
          status4xx: count("status_4xx"),
          status429: count("status_429"),
          status5xx: count("status_5xx"),
          appAlive: !h.exited,
          k6Exit: r.status,
          // The slowest and most failing endpoints, so a finding can name them.
          endpoints: result.requests
            .map((q) => ({ path: q.path, p95Ms: m?.[`http_req_duration{name:${q.path}}`]?.["p(95)"] ?? null, maxMs: m?.[`http_req_duration{name:${q.path}}`]?.max ?? null, errorRatePct: Math.round(((m?.[`http_req_failed{name:${q.path}}`]?.value ?? 0) * 100) * 100) / 100 }))
            .sort((a, b) => b.errorRatePct - a.errorRatePct || (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
            .slice(0, 5),
          output: m ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-600),
        });
        save();
        { const last = result.stages.at(-1); emit({ k: "load", stage: name, vus: st.vus, state: "end", rps: last.rps, p95: last.p95Ms, errors: last.errorRatePct }); }
        if (h.exited) break;
        await sleep(2000);
      }
      // Recovery: the app answers normally right after the load.
      const t = Date.now();
      let ok = false;
      let status = null;
      while (Date.now() - t < 10000 && !h.exited) {
        const r = await request({ method: "GET", path: spec.app.readyPath ?? "/" }, null);
        status = r.status;
        if (r.status != null && r.status < 500) {
          ok = true;
          break;
        }
        await sleep(500);
      }
      result.recovery = { ok, status, ms: Date.now() - t, appExited: Boolean(h.exited) };
    }
  }
} catch (e) {
  result.error = String(e?.message ?? e).slice(0, 400);
}
await stopApp(h);
save();
console.log(`load: boot=${h.boot.ok} requests=${result.requests.length} stages=${result.stages.map((s) => `${s.name}:${s.requests}req/p95=${s.p95Ms}ms/err=${s.errorRatePct}%`).join(" ")}${result.error ? ` error=${result.error}` : ""}`);
process.exit(0);
