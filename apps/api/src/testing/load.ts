import { readFileSync } from "node:fs";
import type { LoadStage, TestingReport } from "@cybercheck/contracts";
import { OUT, wsPath } from "./adapters.ts";
import { identityFor, type BootApp } from "./agents.ts";
import { withRecord } from "./fixtures.ts";
import { appFor, concretePath, paramNames, type FixtureNode } from "./plan.ts";
import { HARNESS_LIB, appEnv } from "./probes.ts";
import { startServices } from "./services.ts";
import { redactSecrets } from "../understanding/source.ts";
import { stackLocations } from "./triage.ts";
import { CI_ENV, K6, POLICY, addFinding, execute, setOb, tail, toProjectPaths, type Ctx, type LoadStageName } from "./runtime.ts";

// Devast: load and capacity checks against the app inside the sandbox only, never an external host.
// Smoke must be clean. Average load is pass or fail only against thresholds the user set; without them
// it is a measurement. Stress and spike are measured, and the app must keep answering. The breakpoint raises the
// request rate until the app gives way and reports that rate: a measurement, never a pass or fail of the app.

const LOAD = readFileSync(new URL("./harness/load.mjs", import.meta.url));

type StageOut = Omit<LoadStage, "verdict"> & { status4xx: number; status429: number; status5xx: number; appAlive: boolean; output: string | null; endpoints?: Array<{ path: string; p95Ms: number | null; maxMs: number | null; errorRatePct: number }> };
type LoadOut = { boot: { ok: boolean; reason: string | null } | null; requests: Array<{ method: string; path: string; identity: string | null }>; excluded: Array<{ path: string; why: string }>; stages: StageOut[]; recovery: { ok: boolean; status: number | null; ms: number; appExited: boolean } | null; error: string | null };

/** Read endpoints a normal user hits: GETs without parameters, or with an id a setup step created. */
export function loadRequests(ctx: Ctx, app: BootApp, graph: FixtureNode[], appDirs: string[]) {
  const ok = new Set(graph.map((n) => n.id));
  const out: Array<{ method: string; path: string; identity: string | null }> = [];
  for (const e of ctx.d.entryPoints) {
    if (e.kind !== "http" || e.method !== "GET" || appFor(e, appDirs) !== app.workspace) continue;
    if (/logout|signout|export|download|stream|events|sse|ws|callback|oauth|webhook|metrics/i.test(e.path)) continue;
    const identity = e.control.kind === "public_intentional" ? null : identityFor(app, e.control.kind, e.path);
    if (identity && !ok.has(identity)) continue;
    if (!identity && !["public_intentional", "none_found", "unknown"].includes(e.control.kind)) continue;
    const path = paramNames(e.path).length ? withRecord(e.path, graph)?.path : concretePath(e.path);
    if (!path) continue;
    out.push({ method: "GET", path, identity });
  }
  return out.slice(0, 30);
}

/** The endpoints that failed or timed out most, named so the finding is actionable. */
const worst = (s: StageOut) => (s.endpoints ?? []).filter((e) => e.errorRatePct > 0 || (e.maxMs ?? 0) >= 9999).slice(0, 3).map((e) => `${e.path} (${e.errorRatePct}% failed${(e.maxMs ?? 0) >= 9999 ? ", some requests timed out after 10 s" : ""})`).join("; ");
/** What the breakpoint found, in words. */
export function breakpointText(s: Pick<LoadStage, "limitRps" | "brokeBy" | "series">) {
  const top = Math.max(0, ...(s.series ?? []).map((p) => p.rps));
  const at = s.limitRps != null ? `about ${Math.round(s.limitRps)} requests per second` : null;
  switch (s.brokeBy) {
    case "errors":
      return at ? `Handled up to ${at}; above that, more than 5% of requests failed.` : "More than 5% of requests failed from the first seconds of the ramp.";
    case "latency":
      return at ? `Handled up to ${at}; above that, the slowest 5% of answers took over 2 s.` : "The slowest 5% of answers took over 2 s from the first seconds of the ramp.";
    case "crash":
      return `The app process stopped${at ? ` after handling up to ${at}` : ""}.`;
    case "generator":
      return `Handled at least ${at ?? `${top} requests per second`}; the load generator, which shares the sandbox, reached its own limit first.`;
    default:
      return `Handled the whole ramp, up to ${Math.round(top)} requests per second, without giving way.`;
  }
}

const fmt = (s: StageOut) => `${s.requests} requests at ${s.rps}/s with ${s.vus} virtual users: p50 ${s.p50Ms ?? "?"} ms, p95 ${s.p95Ms ?? "?"} ms, max ${s.maxMs ?? "?"} ms, server errors or timeouts ${s.errorRatePct}%${s.status429 ? `, ${s.status429} rate-limited (429)` : ""}${worst(s) ? `. Worst: ${worst(s)}` : ""}`;

export async function judgeLoad(ctx: Ctx, image: string, app: BootApp, graph: FixtureNode[], appDirs: string[], stages: LoadStageName[]): Promise<TestingReport["load"]> {
  const obs = [...ctx.obligations.values()].filter((o) => (o.layer === "performance" || o.id === "reliability:recovery-after-load") && o.status === "planned");
  if (!stages.length || !obs.length) return null;
  const requests = loadRequests(ctx, app, graph, appDirs);
  if (!requests.length) {
    for (const o of obs) await setOb(ctx, o.id, { status: "blocked", blockedBy: "prerequisite", reason: "No read endpoint could be called without parameters or with data the setup created.", executionIds: [] });
    return null;
  }
  const spec = { app: { cwd: wsPath(app.workspace), start: app.start, port: app.port, readyPath: app.readyPath }, env: appEnv(ctx, app, {}, graph), graph: graph.map((n) => ({ id: n.id, kind: n.kind, dependsOn: n.dependsOn, command: n.command, exports: n.exports, identity: n.identity ?? null, steps: n.steps, auth: n.auth, verify: n.verify ?? null })), requests, stages, k6: K6, bootTimeoutSec: POLICY.bootTimeoutSec };
  const [libId, loadId, specId] = await Promise.all([ctx.provider.upload(HARNESS_LIB), ctx.provider.upload(LOAD), ctx.provider.upload(Buffer.from(JSON.stringify(spec)))]);
  const prepare = app.prepare.length ? `(cd '${wsPath(app.workspace)}' && ${app.prepare.join(" && ")}) </dev/null && ` : "";
  const r = await execute(ctx, { kind: "load", label: `Load test: ${stages.join(", ")} (${requests.length} endpoint(s), this sandbox only)`, workspace: app.workspace, fetch: [`${OUT}/load.json`, `${OUT}/server.log`, ...stages.map((n) => `${OUT}/k6-${n}.html`)] }, {
    image,
    command: `${startServices(ctx.services)}mkdir -p ${OUT} && ${prepare}node /cc/load.mjs /cc/loadspec.json ${OUT}`,
    network: false,
    keep: true,
    timeoutSec: 900,
    env: { ...CI_ENV, ...spec.env },
    files: [
      { path: "/cc/lib.mjs", fileId: libId },
      { path: "/cc/load.mjs", fileId: loadId },
      { path: "/cc/loadspec.json", fileId: specId },
    ],
  });
  const raw = r.files.get(`${OUT}/load.json`);
  const out: LoadOut | null = raw ? JSON.parse(raw.toString("utf8")) : null;
  const execIds = [r.exec.id];
  if (!out?.boot?.ok || !out.stages.length) {
    const why = !out ? `the load run produced no result (${r.exec.outcome})` : !out.boot?.ok ? `the app did not start (${out.boot?.reason})` : out.requests.length ? `k6 did not run${out.error ? ` (${out.error})` : ""}` : `no endpoint answered without an error before the test (${out.excluded.slice(0, 3).map((x) => `${x.path}: ${x.why}`).join("; ")})`;
    for (const o of obs) await setOb(ctx, o.id, { status: "blocked", blockedBy: "prerequisite", reason: `Not run: ${why}.`, executionIds: execIds });
    return null;
  }
  const t = ctx.thresholds;
  const hasThresholds = Boolean(t && (t.p95Ms || t.errorRatePct != null));
  const within = (s: StageOut) => (!t?.p95Ms || (s.p95Ms ?? Infinity) <= t.p95Ms) && (t?.errorRatePct == null || s.errorRatePct <= t.errorRatePct);
  const result: LoadStage[] = [];
  // The local Postgres stand-in (PGlite) is not built for heavy concurrency: an app that stops under load on it says
  // nothing certain about the app on a real Postgres server, so those results are inconclusive, not failures.
  // Why the app stopped, from its own log: a database-protocol error from the stand-in is the environment;
  // an unhandled error in the app's own code is a suspected product defect (it would crash on a real server too).
  const serverLog = redactSecrets(toProjectPaths(r.files.get(`${OUT}/server.log`)?.toString("utf8") ?? "")).text;
  const died = out.stages.some((s) => !s.appAlive) || Boolean(out.recovery?.appExited);
  // The breakpoint pushes past what the app can take on purpose: stopping there is reported on its own, more mildly.
  const diedBefore = out.stages.some((s) => s.name !== "breakpoint" && !s.appAlive);
  const bpCrash = !diedBefore && out.stages.some((s) => s.name === "breakpoint" && !s.appAlive);
  // Under concurrency the stand-in can mix up the parameters of parallel queries: a type error on a value that
  // the same requests sent without trouble one at a time is that mix-up, not the app's SQL.
  const crossTalk = /invalid input syntax for type|bind message supplies|prepared statement "[^"]*" does not exist|portal "[^"]*" does not exist/i.test(serverLog);
  const protocolError = crossTalk || /unexpected commandComplete|Connection terminated|too many clients|ECONNRESET.*543[0-9]|pglite/i.test(serverLog);
  const standIn = ctx.services.includes("postgres") && (protocolError || !serverLog.trim());
  // Even then, one database error stopping the whole process is the app's own weakness (an async handler
  // without error handling): reported at medium, since the error that triggered it came from the stand-in.
  const unhandled = died && standIn && serverLog.trim() && /node:internal\/process|unhandledRejection|UnhandledPromiseRejection|processTicksAndRejections/i.test(serverLog);
  if (unhandled) {
    const locs = stackLocations(ctx.src, app.workspace, serverLog);
    const crash = serverLog.split("\n").filter((l) => /Error|Unhandled|at .+:\d+/i.test(l)).slice(-10).join("\n");
    await addFinding(ctx, { kind: "product_defect", status: "suspected", severity: "medium", confidence: "medium", title: "One database error stops the whole server", expected: "A failing database query returns an error response for that request; the server keeps running", actual: `A database error raised inside a request handler was not caught, and the process exited.\nLast errors in its log:\n${tail(crash, 1200)}`, reproduction: `Start the app and make any database query in a request handler fail (for example stop the database), then send: ${out.requests.slice(0, 3).map((x) => `${x.method} ${x.path}`).join(", ")}`, rootCause: "An async request handler or middleware awaits a query without try/catch or an error-forwarding wrapper, so the rejection is unhandled and Node ends the process.", location: locs[0] ?? null, obligationIds: obs.map((o) => o.id), executionIds: execIds, validation: "Observed in the load sandbox; the stack trace in the app's log shows the rejection escaping the handler.", limitation: "The database error itself came from cybercheck's Postgres stand-in under concurrency (a real server would likely not raise it); the missing error handling is in your code either way.", layer: "reliability", nextAction: "Catch errors in async handlers (try/catch, an async wrapper, or Express 5) and add an error middleware so one failing query returns a 500 instead of stopping the server." });
  }
  if (bpCrash && !standIn && !unhandled) {
    const bp = out.stages.find((s) => s.name === "breakpoint")!;
    const crash = serverLog.split("\n").filter((l) => /Error|Unhandled|Traceback|exception|killed|memory|at .+:\d+/i.test(l)).slice(-12).join("\n");
    await addFinding(ctx, { kind: "product_defect", status: "suspected", severity: "low", confidence: "low", title: "The app process stops under overload instead of slowing down", expected: "Under more requests than it can handle, the app answers slowly or refuses some (429 or 503) but keeps running", actual: `${breakpointText(bp)}${crash ? `\nLast lines of its log:\n${tail(crash, 1200)}` : " Its log shows no error before it stopped."}`, reproduction: `Raise the request rate step by step (k6 ramping-arrival-rate over 2 minutes, up to twice the rate the earlier stages reached) against: ${out.requests.slice(0, 5).map((x) => `${x.method} ${x.path}`).join(", ")}`, rootCause: null, location: stackLocations(ctx.src, app.workspace, serverLog)[0] ?? null, obligationIds: ["perf:breakpoint"], executionIds: execIds, validation: "Observed once in the load sandbox, past the rate at which the app was still healthy.", limitation: "The load generator and the app share one 4 vCPU sandbox with limited memory; the rate at which a real server stops differs.", layer: "reliability", nextAction: "Limit concurrency (a request queue, a connection pool size, or rate limiting) so overload slows the app down instead of stopping it." });
  }
  if (diedBefore && !standIn) {
    const crash = serverLog.split("\n").filter((l) => /Error|Unhandled|Traceback|exception|at .+:\d+/i.test(l)).slice(-12).join("\n");
    const locs = stackLocations(ctx.src, app.workspace, serverLog);
    await addFinding(ctx, { kind: "product_defect", status: "suspected", severity: "high", confidence: "medium", title: "The app process stops under concurrent load", expected: "The app keeps answering (possibly slowly) under 20 concurrent users", actual: `The process exited during the load test.${crash ? `\nLast errors in its log:\n${tail(crash, 1500)}` : " Its log shows no error before it stopped."}`, reproduction: `Start the app and send these requests from 20 parallel clients for a minute: ${out.requests.slice(0, 5).map((x) => `${x.method} ${x.path}`).join(", ")}`, rootCause: crash ? "An error the app does not handle ends the process (for example a rejected promise in an async route handler)." : null, location: locs[0] ?? null, obligationIds: obs.map((o) => o.id), executionIds: execIds, validation: "Observed once in the load sandbox; the app's own log is the evidence.", limitation: ctx.services.includes("postgres") ? "The app used cybercheck's local Postgres stand-in (PGlite); its log shows no stand-in protocol error, so the crash is attributed to the app." : null, layer: "reliability", nextAction: "Handle errors in request handlers (and process-level unhandled rejections) so one failing request cannot stop the server." });
  }
  // A stage during which the app stopped measured refused connections, not the app: no latency or throughput shown.
  // The breakpoint keeps its series and limit even when the app stopped: where it stopped is the result.
  const extra = (s: StageOut) => ({ series: s.appAlive || s.name === "breakpoint" ? (s.series ?? []) : [], limitRps: s.limitRps ?? null, brokeBy: s.brokeBy ?? null, reportName: s.reportName && r.files.has(`${OUT}/${s.reportName}`) ? s.reportName : null });
  const row = (s: StageOut, verdict: LoadStage["verdict"]): LoadStage =>
    s.appAlive
      ? { name: s.name, vus: s.vus, durationSec: s.durationSec, requests: s.requests, rps: s.rps, errorRatePct: s.errorRatePct, p50Ms: s.p50Ms, p95Ms: s.p95Ms, maxMs: s.maxMs, verdict, ...extra(s) }
      : { name: s.name, vus: s.vus, durationSec: s.durationSec, requests: s.requests, rps: 0, errorRatePct: s.errorRatePct, p50Ms: null, p95Ms: null, maxMs: null, verdict: s.name === "breakpoint" ? "measured" : "invalid", ...extra(s) };
  const STAND_IN ="The app stopped during the load while using cybercheck's local Postgres stand-in (PGlite), which does not handle heavy concurrency like a real Postgres server; this may be the stand-in, not your code.";
  for (const s of out.stages) {
    const id = `perf:${s.name}`;
    let verdict: LoadStage["verdict"] = "measured";
    if (s.name === "breakpoint") {
      // A measurement: it passes when it found the limit (or showed there was none up to the top of the ramp).
      await setOb(ctx, id, { status: standIn && !s.appAlive ? "inconclusive" : "passed", ...(standIn && !s.appAlive ? { blockedBy: "environment" as const } : {}), reachedTarget: true, reason: `${breakpointText(s)} ${standIn && !s.appAlive ? STAND_IN : `Peak: ${Math.round(Math.max(0, ...(s.series ?? []).map((p) => p.rps)))} requests per second with up to ${s.vus} virtual users.`}`, executionIds: execIds });
      result.push(row(s, "measured"));
      continue;
    }
    if (standIn && !s.appAlive) {
      await setOb(ctx, id, { status: "inconclusive", blockedBy: "environment", reachedTarget: true, reason: `${STAND_IN} ${fmt(s)}.`, executionIds: execIds });
      result.push(row(s, verdict));
      continue;
    }
    if (s.name === "smoke") {
      verdict = s.errorRatePct === 0 && s.requests > 0 ? "passed" : "failed";
      await setOb(ctx, id, { status: verdict, reachedTarget: true, reason: `${fmt(s)}.`, executionIds: execIds });
      if (verdict === "failed") {
        await addFinding(ctx, { kind: "product_defect", status: "suspected", severity: "medium", confidence: "medium", title: "Server errors under a single steady user", expected: "No server error or timeout from 1 virtual user over 20 s", actual: fmt(s), reproduction: `Send these requests in a loop for 20 s: ${out.requests.slice(0, 5).map((x) => `${x.method} ${x.path}`).join(", ")}`, rootCause: null, location: null, obligationIds: [id], executionIds: execIds, validation: "Measured once with k6 in the sandbox.", limitation: "The load generator and the app share one 4 vCPU sandbox.", layer: "performance", nextAction: "Check the server log for the failing requests." });
      }
    } else if (s.name === "average") {
      if (hasThresholds) {
        verdict = within(s) ? "passed" : "failed";
        await setOb(ctx, id, { status: verdict, reachedTarget: true, reason: `${fmt(s)}. Thresholds: ${t?.p95Ms ? `p95 at most ${t.p95Ms} ms` : ""}${t?.p95Ms && t?.errorRatePct != null ? ", " : ""}${t?.errorRatePct != null ? `errors at most ${t.errorRatePct}%` : ""}.`, executionIds: execIds });
        if (verdict === "failed") {
          await addFinding(ctx, { kind: "product_defect", status: "confirmed", severity: "medium", confidence: "medium", title: "Average load exceeds your thresholds", expected: `${t?.p95Ms ? `p95 at most ${t.p95Ms} ms` : ""}${t?.errorRatePct != null ? ` and errors at most ${t.errorRatePct}%` : ""} at 20 virtual users`, actual: fmt(s), reproduction: "Run the same k6 stage (20 virtual users for 60 s) against these endpoints: " + out.requests.slice(0, 6).map((x) => `${x.method} ${x.path}`).join(", "), rootCause: null, location: null, obligationIds: [id], executionIds: execIds, validation: "Measured with k6 against the thresholds you set.", limitation: "The load generator and the app share one 4 vCPU sandbox; production hardware differs.", layer: "performance", nextAction: "Profile the slowest endpoints, or revisit the thresholds." });
        }
      } else {
        await setOb(ctx, id, { status: "inconclusive", reachedTarget: true, reason: `Measured, no threshold set: ${fmt(s)}. Set a p95 or error-rate threshold to get a pass or fail.`, executionIds: execIds });
      }
    } else {
      // Stress and spike are measurements; the check is that the app survived.
      await setOb(ctx, id, { status: s.appAlive ? "passed" : "failed", reachedTarget: true, reason: `${s.appAlive ? "The app kept answering" : "The app stopped"}: ${fmt(s)}.`, executionIds: execIds });
    }
    result.push(row(s, verdict));
  }
  if (ctx.obligations.get("reliability:recovery-after-load")?.status === "planned") {
    const rec = out.recovery;
    if (standIn && rec?.appExited) await setOb(ctx, "reliability:recovery-after-load", { status: "inconclusive", blockedBy: "environment", reason: STAND_IN, executionIds: execIds });
    else if (bpCrash) await setOb(ctx, "reliability:recovery-after-load", { status: "inconclusive", reason: "The app stopped under the breakpoint's deliberate overload, so recovery after normal load could not be observed. Run without the breakpoint stage to judge recovery.", executionIds: execIds });
    else await setOb(ctx, "reliability:recovery-after-load", rec ? { status: rec.ok ? "passed" : "failed", reachedTarget: true, reason: rec.ok ? `Answered ${rec.status} ${Math.round(rec.ms / 100) / 10}s after the last load stage.` : rec.appExited ? "The app had exited during the load." : `Did not answer normally within 10 s after the load (last status ${rec.status ?? "none"}).`, executionIds: execIds } : { status: "inconclusive", reason: "Recovery was not measured.", executionIds: execIds });
  }
  for (const o of obs) if (ctx.obligations.get(o.id)!.status === "planned") await setOb(ctx, o.id, { status: "skipped", reason: "The load run stopped before this stage (the app had exited).", executionIds: execIds });
  return {
    note: `Measured with k6 against the app inside one 4 vCPU sandbox, with the load generator on the same machine: compare runs, not production capacity.${out.excluded.length ? ` ${out.excluded.length} endpoint(s) left out (${out.excluded.slice(0, 3).map((x) => `${x.path}: ${x.why}`).join("; ")}).` : ""}`,
    stages: result,
    thresholds: hasThresholds ? (t ?? null) : null,
    executionId: r.exec.id,
  };
}
