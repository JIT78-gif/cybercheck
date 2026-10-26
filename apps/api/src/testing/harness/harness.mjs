// cybercheck boot-and-probe harness. Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node harness.mjs <spec.json> <out-dir>
// Starts the app, runs the fixture graph once (seed, data, sign-in), then each probe. A probe whose
// fixtures or identity failed is not sent at all. Writes <out-dir>/harness.json and server.log.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { client, emit, ensureDirs, fill, judge, logSize, mask, missingText, newUid, retypedBody, runGraph, runPrepare, runScenario, sleep, startApp, startReplay, stopApp, unfilled, usable, pick } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const env = { ...process.env, ...spec.env };
ensureDirs(spec.env ?? {});
const result = { prepare: [], boot: { ok: false, ms: null, reason: null, exitCode: null }, identities: [], fixtures: [], probes: [], latencies: [] };
const save = () => writeFileSync(`${outDir}/harness.json`, JSON.stringify(result));
const logPath = `${outDir}/server.log`;
const app = { cwd: spec.cwd, prepare: spec.prepare, start: spec.start, port: spec.port, readyPath: spec.readyPath };

// A sandbox-local canary for SSRF proofs: it answers on loopback and records which tokens were fetched. If the app
// can be made to fetch http://127.0.0.1:<canaryPort>/c/<token>, that token shows up here, proving the server reached it.
const canaryHits = new Set();
let canaryServer = null;
if (spec.canaryPort) {
  canaryServer = createServer((req, res) => {
    const m = String(req.url ?? "").match(/\/c\/([\w-]+)/);
    if (m) canaryHits.add(m[1]);
    res.writeHead(200, { "content-type": "text/plain" }).end(m ? `cc-canary ${m[1]}` : "cc-canary");
  });
  await new Promise((resolve) => canaryServer.listen(spec.canaryPort, "127.0.0.1", resolve)).catch(() => {});
}

// AI Evaluator: a loopback, OpenAI-compatible replay model the app's provider base URL points at (set by the API in
// spec.env). It must be listening before the app starts, since some apps check their provider at boot.
let replay = null;
if (spec.replay?.port) {
  try {
    replay = await startReplay(spec.replay.port);
  } catch (err) {
    result.replayError = String(err?.code ?? err);
  }
}
result.prepare = await runPrepare(app, env, spec.prepareTimeoutSec ?? 600);
if (result.prepare.some((p) => p.exitCode !== 0)) {
  result.boot.reason = `prepare command failed: ${result.prepare.find((p) => p.exitCode !== 0).command}`;
  save();
  process.exit(0);
}

let h = await startApp(app, env, logPath, spec.bootTimeoutSec ?? 60);
let restarts = 0;
result.boot = h.boot;
const request = client(h.base, result.latencies);
result.restarts = [];

result.scenarios = [];
const isolated = (spec.scenarios ?? []).filter((j) => j.scenario.fixtureScope === "isolated");
const shared = (spec.scenarios ?? []).filter((j) => j.scenario.fixtureScope !== "isolated");

if (h.boot.ok) {
  let graph = await runGraph(spec.graph ?? [], { request, env, cwd: spec.cwd, base: h.base });
  result.fixtures = graph.results;
  result.identities = graph.results.filter((r) => r.kind === "identity").map((r) => ({ name: r.id, kind: "identity", ok: r.ok, note: r.note }));
  save();
  // Stateful scenarios (counts, pages, stock) run first, before other checks add records, each on a fresh run of the
  // setup: its own records, its own sign-ins and new unique values. Then the setup runs once more for the probes.
  for (const job of isolated) await runJob(job, await runGraph(spec.graph ?? [], { request, env, cwd: spec.cwd, base: h.base }));
  if (isolated.length) graph = await runGraph(spec.graph ?? [], { request, env, cwd: spec.cwd, base: h.base });

  for (const probe of spec.probes ?? []) {
    // A check that stopped the app (already recorded as its failure) should not take the remaining checks with it:
    // start the app again, at most twice, on the same database. Captured values and sign-ins are kept.
    if (h.exited && restarts < 2) {
      restarts++;
      const after = result.probes.at(-1)?.id ?? null;
      h = await startApp(app, env, logPath, spec.bootTimeoutSec ?? 60, true);
      result.restarts.push({ after, ok: h.boot.ok, ms: h.boot.ms });
      save();
    }
    // Fixtures (and the identity) this probe needs must have succeeded, or the probe is not sent.
    // An endpoint without a detected guard is sent without credentials when its optional sign-in failed.
    if (probe.optionalIdentity && probe.identity && graph.ok.get(probe.identity) !== true) probe.identity = null;
    const need = [...(probe.needs ?? []), ...(probe.identity ? [probe.identity] : []),...probe.steps.map((s) => s.as).filter(Boolean)].find((n) => graph.ok.get(n) !== true);
    if (need) {
      const r = graph.results.find((x) => x.id === need);
      result.probes.push({ id: probe.id, ok: false, blocked: { node: need, note: r ? r.note : "this setup step is not defined" }, steps: [] });
      continue;
    }
    const vars = { ...graph.vars, $uid: newUid() };
    const steps = [];
    let ok = true;
    for (const raw of probe.steps) {
      const step = fill(raw, vars, env);
      const missing = unfilled(step);
      if (missing) {
        steps.push({ method: step.method, path: step.path, setup: true, status: null, ms: 0, ok: false, why: `setup failed: ${missing.startsWith("ENV:") ? missingText(missing) : `the value {{${missing}}} was not returned by an earlier step`}` });
        ok = false;
        break;
      }
      if (h.exited) {
        steps.push({ method: step.method, path: step.path, status: null, ms: 0, ok: false, why: "the app had already stopped", skipped: true });
        ok = false;
        break;
      }
      const logFrom = logSize(logPath);
      const who = step.as ?? probe.identity;
      let r = await request(step, who ? graph.auths[who] : null);
      // A preparatory step (not the last one, expected to succeed) refused for a field type or a missing field is
      // corrected like a setup step; the step under test is never changed.
      let corrected = null;
      const wantsSuccess = (step.expect?.statusClass ?? []).includes("2xx") || Boolean(step.expect?.status?.length && step.expect.status.every((c) => c >= 200 && c < 300));
      const preparatory = probe.steps.indexOf(raw) < probe.steps.length - 1 && wantsSuccess;
      for (let i = 0; preparatory && i < 2; i++) {
        const fixed = retypedBody(corrected ?? step, r, vars);
        if (!fixed) break;
        corrected = fixed;
        r = await request(fixed, who ? graph.auths[who] : null);
      }
      await sleep(60);
      const logTo = logSize(logPath);
      const verdict = judge(step.expect, r);
      if (step.setup && !verdict.ok) verdict.why = `setup failed: ${step.method} ${step.path} answered ${r.status ?? r.error}`;
      if (step.capture && r.text) {
        try {
          const v = pick(JSON.parse(r.text), step.capture.path);
          if (usable(v)) vars[step.capture.name] = v;
        } catch {}
      }
      // Response headers for security proofs (CORS, security headers), with credential-bearing ones dropped.
      const safeHeaders = {};
      for (const [k, v] of Object.entries(r.headers ?? {})) if (!/^(set-cookie|authorization|cookie|proxy-authorization)$/i.test(k)) safeHeaders[k.toLowerCase()] = v;
      steps.push({ method: step.method, path: step.path, setup: Boolean(step.setup), status: r.status, ms: r.ms, ok: verdict.ok, why: corrected && verdict.why ? `${verdict.why} (body corrected after a 422)` : verdict.why, ...(corrected ? { corrected: JSON.parse(mask(JSON.stringify(corrected.json))) } : {}), contentType: r.contentType ?? null, location: r.location ?? null, headers: safeHeaders, body: mask((r.text ?? "").slice(0, 1200)), error: r.error ?? null, logFrom, logTo, appExited: Boolean(h.exited) });
      emit({ k: "req", method: step.method, path: String(step.path).slice(0, 160), status: r.status ?? null, ms: r.ms ?? null, ok: verdict.ok, as: who ?? null, check: probe.obligationId ?? null });
      if (!verdict.ok) {
        ok = false;
        break;
      }
    }
    result.probes.push({ id: probe.id, ok, steps });
    save();
  }

  for (const job of shared) await runJob(job, graph);

  // AI Evaluator cases: each a short conversation with the AI route. The replay script is armed for each turn (null
  // for earlier turns), the model calls that turn caused are recorded with it, and the app is checked to still answer
  // afterwards. The full reply body is kept (masked), since graders read the reply itself.
  result.aiCases = [];
  // Budget: the whole AI stage has a wall-clock and a model-request budget. Once either is reached no new case is
  // started; completed evidence is kept and the rest are marked blocked.
  const aiStart = Date.now();
  let aiModelReqs = 0;
  result.aiBudget = { modelRequests: 0, overBudget: false };
  for (const c of spec.aiCases ?? []) {
    const overTime = spec.aiDeadlineMs && Date.now() - aiStart > spec.aiDeadlineMs;
    const overReqs = spec.aiMaxModelRequests && aiModelReqs >= spec.aiMaxModelRequests;
    if (overTime || overReqs) {
      result.aiBudget.overBudget = true;
      result.aiCases.push({ id: c.id, blocked: { node: "budget", note: overTime ? "the time budget was reached" : "the model-request budget was reached" }, turns: [], alive: null, appExited: Boolean(h.exited) });
      save();
      continue;
    }
    if (h.exited && restarts < 2) {
      restarts++;
      h = await startApp(app, env, logPath, spec.bootTimeoutSec ?? 60, true);
      result.restarts.push({ after: c.id, ok: h.boot.ok, ms: h.boot.ms });
    }
    const need = (c.needs ?? []).find((n) => graph.ok.get(n) !== true);
    if (need || h.exited) {
      const r = graph.results.find((x) => x.id === need);
      result.aiCases.push({ id: c.id, blocked: { node: need ?? "app", note: h.exited ? "the app had stopped" : r ? r.note : "this sign-in is not defined" }, turns: [], alive: null, appExited: Boolean(h.exited) });
      save();
      continue;
    }
    const vars = { ...graph.vars, $uid: newUid() };
    const turns = [];
    for (let turnIndex = 0; turnIndex < c.turns.length; turnIndex++) {
      const raw = c.turns[turnIndex];
      // A bounded parallel group is used only by deterministic concurrency campaigns. All requests are prepared from
      // the same fixture state and released together; model replay and captures remain sequential-only.
      if (raw.parallelGroup && raw.replay == null && !raw.capture) {
        const group = [];
        for (let j = turnIndex; j < c.turns.length && c.turns[j].parallelGroup === raw.parallelGroup; j++) group.push(c.turns[j]);
        const prepared = group.map((item) => ({ raw: item, step: fill({ method: item.method, path: item.path, json: item.json, timeoutMs: item.timeoutMs }, vars, env) }));
        const missing = prepared.map((x) => unfilled(x.step)).find(Boolean);
        if (missing) {
          for (const _ of group) turns.push({ status: null, ms: 0, body: "", contentType: null, error: `not sent: {{${missing}}} was not returned by an earlier turn`, model: [] });
          break;
        }
        const logFrom = logSize(logPath);
        const answers = await Promise.all(prepared.map((x) => request(x.step, x.raw.as ? graph.auths[x.raw.as] : null)));
        await sleep(60);
        for (let k = 0; k < prepared.length; k++) {
          const item = prepared[k];
          const r = answers[k];
          turns.push({ status: r.status, ms: r.ms, body: mask((r.text ?? "").slice(0, 20000)), contentType: r.contentType ?? null, error: r.error ?? null, model: [], logFrom, logTo: logSize(logPath) });
          emit({ k: "req", method: item.step.method, path: String(item.step.path).slice(0, 160), status: r.status ?? null, ms: r.ms ?? null, ok: r.status != null && r.status < 500, as: item.raw.as ?? null, check: c.id });
        }
        turnIndex += group.length - 1;
        continue;
      }
      const step = fill({ method: raw.method, path: raw.path, json: raw.json, timeoutMs: raw.timeoutMs }, vars, env);
      const missing = unfilled(step);
      if (missing) {
        turns.push({ status: null, ms: 0, body: "", contentType: null, error: `not sent: {{${missing}}} was not returned by an earlier turn`, model: [] });
        break;
      }
      replay?.setScript(raw.replay ?? null);
      const from = replay?.count ?? 0;
      const logFrom = logSize(logPath);
      const r = await request(step, raw.as ? graph.auths[raw.as] : null);
      replay?.release();
      await sleep(60);
      if (raw.capture && r.text) {
        try {
          const v = pick(JSON.parse(r.text), raw.capture.path);
          if (usable(v)) vars[raw.capture.name] = v;
        } catch {}
      }
      const model = replay
        ? (replay.since(from) ?? []).map((m) => ({ path: m.path, body: mask(m.body), served: m.served }))
        : [];
      turns.push({ status: r.status, ms: r.ms, body: mask((r.text ?? "").slice(0, 20000)), contentType: r.contentType ?? null, error: r.error ?? null, model, logFrom, logTo: logSize(logPath) });
      emit({ k: "req", method: step.method, path: String(step.path).slice(0, 160), status: r.status ?? null, ms: r.ms ?? null, ok: r.status != null && r.status < 500, as: raw.as ?? null, check: c.id });
      if (r.status == null && h.exited) break;
    }
    // Still answering? Any response (even 404) counts; no response or an exited process does not.
    const ping = h.exited ? null : await request({ method: "GET", path: c.alivePath ?? "/", timeoutMs: 5000 }, null);
    aiModelReqs += turns.reduce((n, t) => n + (t.model?.length ?? 0), 0);
    result.aiBudget.modelRequests = aiModelReqs;
    result.aiCases.push({ id: c.id, turns, alive: ping ? ping.status != null : false, appExited: Boolean(h.exited) });
    save();
  }
}

/**
 * One compiled scenario (typed requests, fixture symbols, semantic assertions; checked by the API before sending)
 * against a setup graph run `graph`.
 */
async function runJob(job, graph) {
  {
    const s = job.scenario;
    if (h.exited && restarts < 2) {
      restarts++;
      h = await startApp(app, env, logPath, spec.bootTimeoutSec ?? 60, true);
      result.restarts.push({ after: s.id, ok: h.boot.ok, ms: h.boot.ms });
    }
    // Every fixture and identity it draws on must have worked, or it is not sent.
    const nodes = [...new Set([...s.bindings.filter((b) => b.producer.kind === "fixture").map((b) => b.producer.nodeId), ...s.requests.map((r) => r.as).filter(Boolean)])];
    const need = nodes.find((n) => graph.ok.get(n) !== true);
    if (need || h.exited) {
      const r = graph.results.find((x) => x.id === need);
      result.scenarios.push({ scenarioId: s.id, status: "inconclusive", reason: h.exited ? "The app had stopped before this scenario ran." : `Not sent: cybercheck's own setup step "${need}" did not work (${r ? r.note : "it is not defined"}).`, targetReached: false, proofs: [], blockedBy: need ? "fixture" : "prerequisite" });
      save();
      return;
    }
    const symbols = {};
    for (const b of s.bindings) {
      const p = b.producer;
      if (p.kind === "fixture") {
        const field = p.jsonPath.replace(/^\$\.?/, "").split(/[.[]/)[0];
        // A value of that node first (a sign-in's own id), then the capture of that name.
        const v = graph.vars[`${p.nodeId}.${field}`] ?? graph.vars[field] ?? graph.vars[b.symbol.split(".").pop()];
        if (usable(v)) symbols[b.symbol] = v;
      } else if (p.kind === "setting" && env[p.name] != null) symbols[b.symbol] = env[p.name];
      // Settings are text: a value declared as a number or a boolean is sent as one.
      const v = symbols[b.symbol];
      if (b.type === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) symbols[b.symbol] = Number(v);
      if (b.type === "boolean" && (v === "true" || v === "false")) symbols[b.symbol] = v === "true";
    }
    const logFrom = logSize(logPath);
    const out = await runScenario(s, { request, auths: graph.auths, symbols });
    await sleep(60);
    result.scenarios.push({ ...out, logFrom, logTo: logSize(logPath), appExited: Boolean(h.exited), isolated: s.fixtureScope === "isolated" });
    save();
  }
}

result.canaryHits = [...canaryHits];
if (canaryServer) canaryServer.close();
if (replay) replay.close();
result.shutdown = { graceful: await stopApp(h) };
save();
console.log(`harness: scenarios=${(result.scenarios ?? []).length} boot=${result.boot.ok} fixtures=${result.fixtures.filter((f) => f.ok).length}/${result.fixtures.length} probes=${result.probes.length} failed=${result.probes.filter((p) => !p.ok && !p.blocked).length} not-sent=${result.probes.filter((p) => p.blocked).length}`);
process.exit(0);
