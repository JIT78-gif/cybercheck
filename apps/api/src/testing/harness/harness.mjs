// cybercheck boot-and-probe harness. Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node harness.mjs <spec.json> <out-dir>
// Starts the app, runs the fixture graph once (seed, data, sign-in), then each probe. A probe whose
// fixtures or identity failed is not sent at all. Writes <out-dir>/harness.json and server.log.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { client, emit, ensureDirs, fill, judge, logSize, mask, missingText, newUid, retypedBody, runGraph, runPrepare, sleep, startApp, stopApp, unfilled, usable, pick } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const env = { ...process.env, ...spec.env };
ensureDirs(spec.env ?? {});
const result = { prepare: [], boot: { ok: false, ms: null, reason: null, exitCode: null }, identities: [], fixtures: [], probes: [], latencies: [] };
const save = () => writeFileSync(`${outDir}/harness.json`, JSON.stringify(result));
const logPath = `${outDir}/server.log`;
const app = { cwd: spec.cwd, prepare: spec.prepare, start: spec.start, port: spec.port, readyPath: spec.readyPath };

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

if (h.boot.ok) {
  const graph = await runGraph(spec.graph ?? [], { request, env, cwd: spec.cwd, base: h.base });
  result.fixtures = graph.results;
  result.identities = graph.results.filter((r) => r.kind === "identity").map((r) => ({ name: r.id, kind: "identity", ok: r.ok, note: r.note }));
  save();

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
      steps.push({ method: step.method, path: step.path, setup: Boolean(step.setup), status: r.status, ms: r.ms, ok: verdict.ok, why: corrected && verdict.why ? `${verdict.why} (body corrected after a 422)` : verdict.why, ...(corrected ? { corrected: JSON.parse(mask(JSON.stringify(corrected.json))) } : {}), contentType: r.contentType ?? null, location: r.location ?? null, body: mask((r.text ?? "").slice(0, 1200)), error: r.error ?? null, logFrom, logTo, appExited: Boolean(h.exited) });
      emit({ k: "req", method: step.method, path: String(step.path).slice(0, 160), status: r.status ?? null, ms: r.ms ?? null, ok: verdict.ok, as: who ?? null, check: probe.obligationId ?? null });
      if (!verdict.ok) {
        ok = false;
        break;
      }
    }
    result.probes.push({ id: probe.id, ok, steps });
    save();
  }
}

result.shutdown = { graceful: await stopApp(h) };
save();
console.log(`harness: boot=${result.boot.ok} fixtures=${result.fixtures.filter((f) => f.ok).length}/${result.fixtures.length} probes=${result.probes.length} failed=${result.probes.filter((p) => !p.ok && !p.blocked).length} not-sent=${result.probes.filter((p) => p.blocked).length}`);
process.exit(0);
