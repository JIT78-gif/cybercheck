// cybercheck harness library. Runs INSIDE the sandbox (network disabled), never on the host.
// Shared by the probe, browser, database and load harnesses: start and stop apps, send requests,
// and run the fixture graph (seed commands, data creation, sign-in) once, in dependency order.
// No dependencies: Node 18+ only. Captured tokens and ids stay in memory; they are never written to logs.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A login shell resets PATH; CC_PATH (the project's virtualenv and node_modules/.bin) is put back in front. */
const withPath = (cmd) => `[ -n "$CC_PATH" ] && export PATH="$CC_PATH:$PATH"; ${cmd}`;

/** Directories for path-like settings exist, so an app writing /tmp/cybercheck/x.db can create it. */
export function ensureDirs(env) {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || !v.startsWith("/tmp/")) continue;
    try {
      mkdirSync(/(PATH|_FILE|_DB)$/.test(k) || /\.\w{1,8}$/.test(v) ? dirname(v) : v, { recursive: true });
    } catch {}
  }
}

/**
 * Runs a command without blocking the event loop. Never use spawnSync while an app is running: the app's
 * log pipe is read by this process, and a blocked loop lets the pipe fill until the app itself stalls.
 */
export function run(file, args, { cwd, env, timeoutMs = 120000, stopWhen = null } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const cap = (s, d) => (s.length > 4 * 1024 * 1024 ? s : s + d);
    child.stdout.on("data", (d) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    // Stopped early (SIGINT, so the tool still writes its summary) once the condition holds, e.g. the target died.
    let stopped = false;
    const poll = stopWhen
      ? setInterval(() => {
          if (!stopped && stopWhen()) {
            stopped = true;
            child.kill("SIGINT");
          }
        }, 500)
      : null;
    const done = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
    child.on("error", (error) => {
      done();
      resolve({ status: null, stdout, stderr, error, stopped });
    });
    child.on("close", (status) => {
      done();
      resolve({ status, stdout, stderr, error: null, stopped });
    });
  });
}

/** Runs prepare commands (e.g. a build) in the app's directory. Returns the first failure, if any. */
export async function runPrepare(app, env, timeoutSec = 600) {
  const out = [];
  for (const cmd of app.prepare ?? []) {
    const t0 = Date.now();
    const r = await run("bash", ["-lc", withPath(cmd)], { cwd: app.cwd, env, timeoutMs: timeoutSec * 1000 });
    out.push({ command: cmd, exitCode: r.status, ms: Date.now() - t0, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000) });
    if (r.status !== 0) break;
  }
  return out;
}

/** Starts an app in its own process group, logging to <logPath>, and waits until its port answers. */
export async function startApp(app, env, logPath, bootTimeoutSec = 60, append = false) {
  const log = createWriteStream(logPath, { flags: append ? "a" : "w" });
  const t0 = Date.now();
  const child = spawn("bash", ["-lc", withPath(`exec ${app.start}`)], { cwd: app.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const h = { child, log, logPath, exited: null, base: `http://127.0.0.1:${app.port}`, boot: { ok: false, ms: null, reason: null, exitCode: null } };
  child.on("exit", (code, signal) => (h.exited = { code, signal }));
  const deadline = Date.now() + bootTimeoutSec * 1000;
  // A server told to listen on "localhost" may bind only the IPv6 loopback (::1): try both, keep the one that answers.
  const bases = [`http://127.0.0.1:${app.port}`, `http://[::1]:${app.port}`];
  while (Date.now() < deadline && !h.exited && !h.boot.ok) {
    for (const base of bases) {
      try {
        await fetch(`${base}${app.readyPath ?? "/"}`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
        h.base = base;
        h.boot = { ok: true, ms: Date.now() - t0, reason: null, exitCode: null };
        break;
      } catch {}
    }
    if (!h.boot.ok) await sleep(500);
  }
  if (!h.boot.ok) h.boot = { ok: false, ms: Date.now() - t0, reason: h.exited ? `the app exited (code ${h.exited.code}${h.exited.signal ? `, signal ${h.exited.signal}` : ""}) before listening on port ${app.port}` : `nothing answered on port ${app.port} within ${bootTimeoutSec}s`, exitCode: h.exited?.code ?? null };
  return h;
}

/** Stops the whole process group: SIGTERM, a short grace period, then SIGKILL. Returns whether it stopped gracefully. */
export async function stopApp(h) {
  try {
    process.kill(-h.child.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20 && !h.exited; i++) await sleep(150);
  const graceful = Boolean(h.exited);
  try {
    process.kill(-h.child.pid, "SIGKILL");
  } catch {}
  h.log.end();
  return graceful;
}

export const logSize = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

// ---------------------------------------------------------------- values

/** ${ENV:NAME} becomes the synthetic setting's value; an unknown one stays as written so the request counts as unfilled. */
export const subEnv = (v, env) => (typeof v === "string" ? v.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (m, n) => env[n] ?? m) : v);
/** For shell commands only: a setting cybercheck did not provide becomes empty, as the shell would expand it. */
const stripEnv = (v) => (typeof v === "string" ? v.replace(/\$\{ENV:[A-Z0-9_]+\}/g, "") : v);
/** A captured value is usable only if it is a plain value (an object in a URL becomes "[object Object]"). */
export const usable = (x) => x != null && (typeof x === "string" || typeof x === "number" || typeof x === "boolean");
let uidCounter = 0;
/** Digits only: they fit upper-case, lower-case and numeric formats alike (e.g. an SKU pattern like ^[A-Z0-9-]+$). */
// Six digits: unique within a run, and short enough for fields with tight length limits (a table number of 10 characters).
export const newUid = () => `${(Date.now() % 1000) * 1000 + (++uidCounter % 1000)}`.padStart(6, "1");

/** Fills {{name}}, {{$uid}} and ${ENV:NAME}. "{{id}}" on its own keeps the captured value's type. */
export function fill(v, vars, env) {
  if (typeof v === "string") {
    const whole = v.match(/^\{\{(\w+)\}\}$/);
    if (whole && usable(vars[whole[1]])) return vars[whole[1]];
    return subEnv(v, env).replace(/\{\{(\$?\w+)\}\}/g, (_m, n) => (n === "$uid" ? vars.$uid : usable(vars[n]) ? String(vars[n]) : `{{${n}}}`));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars, env));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars, env)]));
  return v;
}

/** The first placeholder still unfilled in a request, if any (such a request is never sent). */
/**
 * One live action for the user's live view, printed as a "@@cc {json}" line that cybercheck reads while the
 * sandbox runs. Short fields only (never bodies), and masked like every other output.
 */
export function emit(action) {
  try {
    process.stdout.write(`@@cc ${mask(JSON.stringify(action))}\n`);
  } catch {}
}

/** Why a request with an unfilled value was not sent. */
export const missingText = (missing) => (missing.startsWith("ENV:") ? `the setting ${missing.slice(4)} was not provided by cybercheck` : `the value {{${missing}}} was not available`);

export const unfilled = (step) => {
  const text = JSON.stringify([step.path, step.json ?? null, step.form ?? null, step.headers ?? null, step.raw ?? null]);
  const env = text.match(/\$\{ENV:([A-Z0-9_]+)\}/);
  return text.match(/\{\{(\$?\w+)\}\}/)?.[1] ?? (env ? `ENV:${env[1]}` : null);
};

const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|_KEY)$/i;
const masked = new Set();
/** Values that must never be written to results: secret-like settings and captured tokens and cookies. */
export function maskValues(env) {
  for (const [k, v] of Object.entries(env ?? {})) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 6) masked.add(v);
}
export const keepSecret = (v) => {
  if (typeof v === "string" && v.length >= 6) masked.add(v.replace(/^Bearer\s+/i, ""));
};
export function mask(text) {
  let out = String(text ?? "");
  for (const v of masked) if (out.includes(v)) out = out.split(v).join("[hidden]");
  return out;
}

/** Paths like "items.0.id", "items[0].id" or "$.data.id". */
export const pick = (obj, path) => path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ---------------------------------------------------------------- requests

export function client(base, latencies) {
  return async function request(step, auth) {
    // Header names are case-insensitive: a step's own "X-Session" replaces the identity's "x-session" instead of
    // being sent twice (two values merged into one invalid header).
    const headers = {};
    for (const [k, v] of [...Object.entries(auth?.headers ?? {}), ...Object.entries(step.headers ?? {})]) headers[k.toLowerCase()] = v;
    if (auth?.cookies && Object.keys(auth.cookies).length) headers.cookie = Object.entries(auth.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (step.json !== undefined) {
      body = JSON.stringify(step.json);
      headers["content-type"] ??= "application/json";
    } else if (step.form !== undefined) {
      body = new URLSearchParams(step.form).toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    } else if (step.raw !== undefined) {
      body = step.raw;
      headers["content-type"] ??= step.contentType ?? "application/json";
    }
    const t = Date.now();
    try {
      const res = await fetch(`${base}${step.path}`, { method: step.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      const ms = Date.now() - t;
      latencies?.push(ms);
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      return { status: res.status, ms, text, contentType: res.headers.get("content-type"), location: res.headers.get("location"), setCookies };
    } catch (err) {
      return { status: null, ms: Date.now() - t, text: "", error: String(err?.cause?.code ?? err?.name ?? err) };
    }
  };
}

export function judge(expect, r) {
  if (r.status == null) return { ok: false, why: `no response (${r.error})` };
  if (expect?.status?.length && !expect.status.includes(r.status)) return { ok: false, why: `expected status ${expect.status.join(" or ")}, got ${r.status}` };
  if (expect?.statusClass?.length && !expect.statusClass.includes(`${String(r.status)[0]}xx`)) return { ok: false, why: `expected ${expect.statusClass.join(" or ")}, got ${r.status}` };
  if (expect?.not5xx !== false && r.status >= 500) return { ok: false, why: `server error ${r.status}` };
  if (expect?.bodyIncludes && !r.text.includes(expect.bodyIncludes)) return { ok: false, why: `response did not include "${expect.bodyIncludes}"` };
  if (expect?.json?.length) {
    let body;
    try {
      body = JSON.parse(r.text);
    } catch {
      return { ok: false, why: "expected a JSON response" };
    }
    for (const c of expect.json) {
      const v = pick(body, c.path);
      if ("equals" in c && JSON.stringify(v) !== JSON.stringify(c.equals)) return { ok: false, why: `${c.path} was ${JSON.stringify(v)}, expected ${JSON.stringify(c.equals)}` };
      if (c.exists === true && v === undefined) return { ok: false, why: `${c.path} is missing from the response` };
      if (c.exists === false && v !== undefined) return { ok: false, why: `${c.path} should not be in the response` };
      if (typeof c.min === "number" && !(typeof v === "number" && v >= c.min)) return { ok: false, why: `${c.path} was ${JSON.stringify(v)}, expected at least ${c.min}` };
    }
  }
  return { ok: true, why: null };
}

/**
 * Stores a captured value. For setup steps (lenient), a path the response does not have falls back to the one
 * top-level key that clearly matches the capture's name (a planner writing "token" where the API answers "session").
 * Returns the key actually used when it differs.
 */
function capture(step, r, vars, lenient = false) {
  if (!step.capture || !r.text) return null;
  try {
    const body = JSON.parse(r.text);
    const v = pick(body, step.capture.path);
    if (usable(v)) {
      vars[step.capture.name] = v;
      return null;
    }
    if (!lenient || !body || typeof body !== "object" || Array.isArray(body)) return null;
    const want = `${step.capture.name} ${step.capture.path}`.toLowerCase();
    const keys = Object.keys(body).filter((k) => usable(body[k]) && k.length > 1 && want.includes(k.toLowerCase().replace(/_/g, "")));
    if (keys.length === 1) {
      vars[step.capture.name] = body[keys[0]];
      return keys[0];
    }
    // A sign-in value asked for under one name ("token") and returned under another ("session", "jwt").
    const TOKENISH = /token|session|jwt|sid|secret|key/i;
    if (TOKENISH.test(want)) {
      const alt = Object.keys(body).filter((k) => typeof body[k] === "string" && body[k].length >= 8 && TOKENISH.test(k));
      if (alt.length === 1) {
        vars[step.capture.name] = body[alt[0]];
        return alt[0];
      }
    }
  } catch {}
  return null;
}

/**
 * Pydantic-style 422 answers say which body field has the wrong type ("Input should be a valid string").
 * For setup steps only, the field is converted once and the request retried; checks are never changed.
 */
/** A plausible value for a required field the planner left out (setup only): a captured id of the same name, else by name. */
function valueFor(field, vars) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const captured = Object.keys(vars).find((k) => k !== "$uid" && (norm(k) === norm(field) || norm(k).endsWith(norm(field))));
  if (captured) return vars[captured];
  const f = field.toLowerCase();
  if (/phone|mobile/.test(f)) return "5550100123";
  if (/email/.test(f)) return `setup-${newUid()}@example.com`;
  if (/password/.test(f)) return `Cc-setup-${newUid()}-7x`;
  if (/name|title|label/.test(f)) return `Test ${field} ${newUid()}`;
  if (/(^|_)(qty|quantity|count|number)$/.test(f)) return 1;
  // A reference nothing captured: the first row, which a seed script usually creates (setup only).
  if (/(^|_)id$|Id$/.test(field)) return 1;
  return undefined;
}

export function retypedBody(step, r, vars = {}) {
  if (r.status !== 422 || !step.json || typeof step.json !== "object") return null;
  let detail;
  try {
    detail = JSON.parse(r.text).detail;
  } catch {
    return null;
  }
  if (!Array.isArray(detail)) return null;
  const json = structuredClone(step.json);
  let changed = false;
  for (const d of detail) {
    const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body") : [];
    if (!loc.length) continue;
    let parent = json;
    for (const k of loc.slice(0, -1)) parent = parent?.[k];
    const key = loc.at(-1);
    if (!parent || typeof parent !== "object") continue;
    // A required field the planner left out ("Field required").
    if (d.type === "missing" && !(key in parent)) {
      const v = valueFor(String(key), vars);
      if (v === undefined) continue;
      parent[key] = v;
      changed = true;
      continue;
    }
    if (!(key in parent)) continue;
    const value = parent[key];
    if (/string_type/.test(d.type) && (typeof value === "number" || typeof value === "boolean")) parent[key] = String(value);
    else if (/int_(type|parsing)|float_(type|parsing)|number/.test(d.type) && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) parent[key] = Number(value);
    else continue;
    changed = true;
  }
  return changed ? { ...step, json } : null;
}

/** Collects cookies from Set-Cookie headers into an auth object. */
function keepCookies(a, setCookies) {
  for (const c of setCookies ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) keepSecret((a.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()));
  }
}

// ---------------------------------------------------------------- the fixture graph

/**
 * Runs every node once, in the given (topological) order. A node whose dependency failed is not run.
 * command: a shell command after the app is up (e.g. a seed script) · request: steps that create data,
 * capturing ids · identity: a way to sign in (bearer, header, basic or a login request), verified by a
 * protected request when one is given. Returns the signed-in auths, captured values and one result per node.
 */
export async function runGraph(nodes, ctx) {
  const { request, env, cwd, base } = ctx;
  maskValues(env);
  const auths = {};
  // In memory only, never written out: each sign-in's raw token and answer (for the browser worker to give a page
  // the same session), the answer of each setup step, and which step produced each captured value.
  const sessions = {};
  const bodies = {};
  const producedBy = {};
  const parsed = (t) => { try { return JSON.parse(t ?? ""); } catch { return null; } };
  const vars = {};
  const results = [];
  // Every setup step's outcome also goes to the live view as it happens.
  const record = results.push.bind(results);
  results.push = (r) => {
    emit({ k: "note", text: `${r.kind === "identity" ? "Sign-in" : "Setup"} "${r.id}": ${r.ok ? "done" : r.skipped ? "skipped" : "failed"}${r.note ? ` (${String(r.note).slice(0, 120)})` : ""}` });
    return record(r);
  };
  const ok = new Map();
  for (const n of nodes ?? []) {
    const failedDep = (n.dependsOn ?? []).find((d) => ok.get(d) !== true);
    if (failedDep) {
      ok.set(n.id, false);
      results.push({ id: n.id, kind: n.kind, ok: false, skipped: true, note: `not run: it needs "${failedDep}", which did not succeed` });
      continue;
    }
    const local = { ...vars, $uid: newUid() };
    if (n.kind === "command") {
      const r = await run("bash", ["-lc", withPath(stripEnv(fill(n.command, local, env)))], { cwd: n.cwd ?? cwd, env: { ...env, BASE_URL: base, API_URL: base }, timeoutMs: (n.timeoutSec ?? 120) * 1000 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      // A seed script may print values later steps need, as NAME=value lines.
      for (const m of out.matchAll(/^([A-Za-z_][\w]*)=(\S+)$/gm)) if ((n.exports ?? []).includes(m[1])) vars[m[1]] = m[2];
      ok.set(n.id, r.status === 0);
      results.push({ id: n.id, kind: n.kind, ok: r.status === 0, note: r.status === 0 ? "exit 0" : `exit ${r.status ?? r.error?.code ?? "?"}`, output: mask(out.slice(-1500)) });
      continue;
    }
    if (n.kind === "request") {
      const steps = [];
      let good = true;
      for (const raw of n.steps ?? []) {
        const step = fill(raw, local, env);
        const missing = unfilled(step);
        if (missing) {
          steps.push({ method: step.method, path: step.path, status: null, ok: false, why: missingText(missing) });
          good = false;
          break;
        }
        let auth = n.identity ? auths[n.identity] : null;
        let r = await request(step, auth);
        // Setup only: refused (401/403) as one sign-in, try the other sign-ins that work, admin-like first.
        // Creating data is a means here, not the behaviour under test.
        let ranAs = null;
        if ([401, 403].includes(r.status)) {
          const others = Object.keys(auths).filter((k) => k !== n.identity && ok.get(k) === true).sort((a, b) => Number(/admin|owner|root|super|manager/i.test(b)) - Number(/admin|owner|root|super|manager/i.test(a)));
          for (const k of others) {
            const again = await request(step, auths[k]);
            if (![401, 403].includes(again.status)) {
              r = again;
              auth = auths[k];
              ranAs = k;
              break;
            }
          }
        }
        let fixedTypes = false;
        // Up to two corrections: fixing one field often reveals the next one the answer complains about.
        let current = step;
        for (let i = 0; i < 2; i++) {
          const retyped = retypedBody(current, r, local);
          if (!retyped) break;
          current = retyped;
          r = await request(retyped, auth);
          fixedTypes = true;
        }
        const v = judge(step.expect ?? { statusClass: ["2xx"] }, r);
        const usedKey = capture(step, r, local, true);
        if (r.status != null && r.status < 300) bodies[n.id] = parsed(r.text);
        if (step.capture && usable(local[step.capture.name])) producedBy[step.capture.name] = n.id;
        const adjusted = [ranAs ? `sent as "${ranAs}" after "${n.identity ?? "no sign-in"}" was refused` : null, fixedTypes ? "body corrected after a 422 (field types or missing required fields)" : null, usedKey ? `captured "${usedKey}" (the response had no "${step.capture.path}")` : null].filter(Boolean).join("; ");
        // The fields a correction changed, so a reproduction shows the body that was actually sent.
        const corrected = fixedTypes && current.json && typeof current.json === "object" ? Object.fromEntries(Object.entries(current.json).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(step.json?.[k]))) : null;
        steps.push({ method: step.method, path: step.path, status: r.status, ok: v.ok, why: v.why ? `${v.why}${adjusted ? ` (${adjusted})` : ""}` : adjusted || null, body: mask((r.text ?? "").slice(0, 800)), ...(corrected ? { corrected: JSON.parse(mask(JSON.stringify(corrected))) } : {}) });
        if (!v.ok) {
          good = false;
          break;
        }
        // A value later steps need that the answer did not contain: fail here, with the keys it had, so the
        // setup repair sees the real response shape instead of a "value not available" further down.
        if (step.capture && !usable(local[step.capture.name])) {
          let keys = "";
          try {
            const b = JSON.parse(r.text ?? "");
            keys = b && typeof b === "object" ? Object.keys(Array.isArray(b) ? b[0] ?? {} : b).slice(0, 12).join(", ") : "";
          } catch {}
          const last = steps.at(-1);
          last.ok = false;
          last.why = `the answer has no "${step.capture.path}" to keep as {{${step.capture.name}}}${keys ? ` (its fields: ${keys})` : ""}`;
          good = false;
          break;
        }
      }
      for (const [k, v] of Object.entries(local)) if (k !== "$uid") vars[k] = v;
      ok.set(n.id, good);
      const last = steps.at(-1);
      results.push({ id: n.id, kind: n.kind, ok: good, note: last ? `${last.method} ${last.path} answered ${last.status ?? "nothing"}${last.why ? ` (${last.why})` : ""}` : "no steps", steps });
      continue;
    }
    // identity
    const a = { headers: {}, cookies: {} };
    let good = true;
    let note = "";
    let loginAnswer = "";
    const id = n.auth ?? {};
    // Models put a header value under "token" or a token under "value": either is accepted (a missing one would be sent as "undefined").
    if (id.kind === "bearer") a.headers.authorization = `Bearer ${fill(id.token ?? id.value, local, env)}`;
    else if (id.kind === "header") a.headers[String(id.header).toLowerCase()] = fill(id.value ?? id.token, local, env);
    else if (id.kind === "basic") a.headers.authorization = `Basic ${Buffer.from(`${fill(id.user, local, env)}:${fill(id.pass, local, env)}`).toString("base64")}`;
    else if (id.kind === "login") {
      const step = fill(id.request, local, env);
      const missing = unfilled(step);
      if (missing) {
        good = false;
        note = missingText(missing);
      } else {
        const r = await request(step, null);
        // Token values are hidden; the field names are what a repair needs to see.
        loginAnswer = (r.text ?? "").slice(0, 300).replace(/"(\w*(?:token|jwt|session|secret)\w*)"\s*:\s*"[^"]*"/gi, `"$1":"[hidden]"`);
        keepCookies(a, r.setCookies);
        sessions[n.id] = { token: null, body: parsed(r.text) };
        if (id.tokenPath) {
          try {
            const tok = pick(JSON.parse(r.text), id.tokenPath);
            if (usable(tok)) {
              keepSecret((a.headers.authorization = `Bearer ${tok}`));
              sessions[n.id].token = String(tok);
            }
          } catch {}
        }
        good = r.status != null && r.status < 400;
        note = `sign-in answered ${r.status ?? r.error}; ${Object.keys(a.cookies).length} cookie(s)${a.headers.authorization ? ", token captured" : ""}`;
        if (good && !Object.keys(a.cookies).length && !a.headers.authorization) {
          good = false;
          note += "; no session cookie or token came back";
        }
        if (!good) note += `; response: ${(r.text ?? "").slice(0, 300)}`;
      }
    }
    // A sign-in is trusted only after a protected request accepts it.
    if (good && n.verify) {
      const r = await request(fill({ method: n.verify.method ?? "GET", path: n.verify.path }, local, env), a);
      const accepted = r.status != null && r.status !== 401 && r.status !== 403 && r.status < 500;
      note = `${note ? `${note}; ` : ""}${n.verify.method ?? "GET"} ${n.verify.path} with it answered ${r.status ?? r.error}`;
      if (!accepted) {
        good = false;
        note += `: still refused; response: ${(r.text ?? "").slice(0, 300)}${loginAnswer ? `; the sign-in answered: ${loginAnswer}` : ""}`;
      }
    }
    // A token or header sign-in: the value itself, and the answer of the setup step that produced it (a check-in).
    if (id.kind === "bearer" || id.kind === "header") {
      const template = String(id.kind === "bearer" ? (id.token ?? id.value ?? "") : (id.value ?? id.token ?? ""));
      const from = template.match(/\{\{(\w+)\}\}/)?.[1];
      sessions[n.id] = { token: fill(template, local, env), body: from && producedBy[from] ? bodies[producedBy[from]] : null };
    }
    auths[n.id] = a;
    ok.set(n.id, good);
    results.push({ id: n.id, kind: n.kind, ok: good, note: mask(note || "credentials set") });
  }
  return { auths, vars, results, ok, sessions, bodies };
}

// ---------------------------------------------------------------- load series (k6 CSV output)

const pct = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * Second-by-second load numbers from k6's CSV output, fed one line at a time (the file can hold millions of
 * rows, so nothing but the per-second buckets is kept). At most `maxPoints` points: longer stages are merged.
 */
export function loadSeries(maxPoints = 300) {
  const buckets = new Map();
  let cols = null;
  const at = (sec) => {
    let b = buckets.get(sec);
    if (!b) buckets.set(sec, (b = { n: 0, fail: 0, durs: [], vus: null }));
    return b;
  };
  return {
    /** One CSV line; the header line sets the column order. */
    line(text) {
      // metric_name, timestamp and metric_value come before any quoted column, so a plain split is safe for them.
      const parts = text.split(",", 3);
      if (!cols) {
        cols = { name: parts.indexOf("metric_name"), ts: parts.indexOf("timestamp"), value: parts.indexOf("metric_value") };
        if (cols.name < 0) cols = { name: 0, ts: 1, value: 2 };
        else return;
      }
      const name = parts[cols.name];
      if (name !== "http_req_duration" && name !== "http_req_failed" && name !== "vus") return;
      const sec = Math.floor(Number(parts[cols.ts]));
      const v = Number(parts[cols.value]);
      if (!Number.isFinite(sec) || !Number.isFinite(v)) return;
      const b = at(sec);
      if (name === "http_req_duration") {
        b.n++;
        b.durs.push(v);
      } else if (name === "http_req_failed") b.fail += v ? 1 : 0;
      else b.vus = Math.max(b.vus ?? 0, v);
    },
    points() {
      const secs = [...buckets.keys()].sort((a, b) => a - b);
      if (!secs.length) return [];
      const start = secs[0];
      const step = Math.max(1, Math.ceil((secs.at(-1) - start + 1) / maxPoints));
      const merged = new Map();
      for (const s of secs) {
        const k = start + Math.floor((s - start) / step) * step;
        const b = buckets.get(s);
        const m = merged.get(k) ?? { n: 0, fail: 0, durs: [], vus: null };
        m.n += b.n;
        m.fail += b.fail;
        for (const d of b.durs) m.durs.push(d);
        m.vus = b.vus == null ? m.vus : Math.max(m.vus ?? 0, b.vus);
        merged.set(k, m);
      }
      return [...merged.entries()].map(([k, m]) => {
        const sorted = m.durs.sort((a, b) => a - b);
        return { t: k - start, rps: round1(m.n / step), p50Ms: round1(pct(sorted, 0.5)), p95Ms: round1(pct(sorted, 0.95)), errorRatePct: m.n ? Math.round((m.fail / m.n) * 10000) / 100 : 0, vus: m.vus };
      });
    },
  };
}

/** Healthy under load: fewer than 5% server errors or timeouts, and 95% of answers within 2 s. */
export const BREAKPOINT = { errorRatePct: 5, p95Ms: 2000 };

/**
 * Where an app gives way under a rising request rate: the highest rate it handled while still healthy, and what
 * failed first. One bad second is noise; two in a row (or a bad last second) is the break.
 */
export function breakpointOf(points, { appExited = false, droppedIterations = 0 } = {}) {
  const bad = (p) => p.errorRatePct >= BREAKPOINT.errorRatePct || (p.p95Ms ?? 0) >= BREAKPOINT.p95Ms;
  const i = points.findIndex((p, k) => bad(p) && (k === points.length - 1 || bad(points[k + 1])));
  const healthy = i < 0 ? points : points.slice(0, i);
  const limitRps = healthy.length ? Math.max(...healthy.map((p) => p.rps)) : null;
  const brokeBy = appExited ? "crash" : i >= 0 ? (points[i].errorRatePct >= BREAKPOINT.errorRatePct ? "errors" : "latency") : droppedIterations > 0 ? "generator" : null;
  return { limitRps, brokeBy };
}
