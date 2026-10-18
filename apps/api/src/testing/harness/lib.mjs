// cybercheck harness library. Runs INSIDE the sandbox (network disabled), never on the host.
// Shared by the probe, browser, database and load harnesses: start and stop apps, send requests,
// and run the fixture graph (seed commands, data creation, sign-in) once, in dependency order.
// No dependencies: Node 18+ only. Captured tokens and ids stay in memory; they are never written to logs.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

/**
 * A request path with its values filled in, each one encoded: a value in a path segment cannot add a "/", and one
 * in the query cannot add "&" or "#". Text written into the path itself (a payload such as <script>) is left as is.
 */
export function fillPath(path, vars, env) {
  const enc = (x) => encodeURIComponent(String(x));
  return String(path)
    .replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (m, n) => (env?.[n] != null ? enc(env[n]) : m))
    .replace(/\{\{(\$?[\w.]+)\}\}/g, (m, n) => (n === "$uid" ? vars.$uid : usable(vars[n]) ? enc(vars[n]) : m));
}

/** Fills {{name}}, {{$uid}} and ${ENV:NAME}. "{{id}}" on its own keeps the captured value's type; a request's path is encoded. */
export function fill(v, vars, env) {
  if (typeof v === "string") {
    const whole = v.match(/^\{\{([\w.]+)\}\}$/);
    if (whole && usable(vars[whole[1]])) return vars[whole[1]];
    return subEnv(v, env).replace(/\{\{(\$?[\w.]+)\}\}/g, (_m, n) => (n === "$uid" ? vars.$uid : usable(vars[n]) ? String(vars[n]) : `{{${n}}}`));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars, env));
  if (v && typeof v === "object") {
    const isRequest = typeof v.method === "string" && typeof v.path === "string";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isRequest && k === "path" ? fillPath(x, vars, env) : fill(x, vars, env)]));
  }
  return v;
}

/**
 * A value a setup step asked for under a name the response nests: "userId" (or "$.id") when the answer is
 * {"user": {"id": 5}}. The last two keys spell the name, or the asked-for field sits under a key the name starts with.
 * Only an unambiguous match is used.
 */
export function inferCapture(body, name, path) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const leaves = [];
  const walk = (o, keys, depth) => {
    if (depth > 4 || o == null) return;
    if (Array.isArray(o)) return o.length ? walk(o[0], [...keys, "0"], depth + 1) : undefined;
    if (typeof o !== "object") return usable(o) && keys.length ? leaves.push({ keys, value: o }) : undefined;
    for (const [k, v] of Object.entries(o)) walk(v, [...keys, k], depth + 1);
  };
  walk(body, [], 0);
  const want = norm(name);
  const named = (keys) => keys.filter((k) => !/^\d+$/.test(k));
  let hits = leaves.filter((l) => named(l.keys).length >= 2 && norm(named(l.keys).slice(-2).join("")) === want);
  const field = norm(String(path ?? "").split(/[.[\]$]/).filter(Boolean).pop() ?? "");
  if (!hits.length && field) hits = leaves.filter((l) => norm(l.keys.at(-1)) === field && named(l.keys).slice(0, -1).some((k) => norm(k).length >= 3 && want.startsWith(norm(k))));
  return hits.length === 1 ? { path: `$.${hits[0].keys.join(".")}`, value: hits[0].value } : null;
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
  return text.match(/\{\{(\$?[\w.]+)\}\}/)?.[1] ?? (env ? `ENV:${env[1]}` : null);
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
/** The parts of a JSON path: names, indexes ([0] or .0) and list filters ([id=o3]: the item whose id is o3). */
export const pathParts = (path) => [...path.replace(/^\$\.?/, "").matchAll(/\[([^\]=]+)=([^\]]*)\]|\[(\d+)\]|([^.[\]]+)/g)].map((m) => (m[1] !== undefined ? { key: m[1], eq: m[2] } : (m[3] ?? m[4])));
export const pick = (obj, path) =>
  pathParts(path).reduce((o, k) => (o == null ? undefined : typeof k === "object" ? (Array.isArray(o) ? o.find((x) => x != null && String(x[k.key]) === k.eq) : undefined) : o[k]), obj);
/** A JSON path with {{symbol}} filled in, so a filter can name a record the scenario created. */
export const pathWith = (path, symbols) => path.replace(/\{\{([^}]+)\}\}/g, (m, name) => (symbols[name] === undefined ? m : String(symbols[name])));

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
      const res = await fetch(`${base}${step.path}`, { method: step.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(step.timeoutMs ?? 15000) });
      const text = await res.text();
      const ms = Date.now() - t;
      latencies?.push(ms);
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      return { status: res.status, ms, text, contentType: res.headers.get("content-type"), location: res.headers.get("location"), setCookies, headers: Object.fromEntries(res.headers.entries()) };
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
    // A nested answer: "userId" asked for, {"user": {"id": 5}} returned.
    const nested = inferCapture(body, step.capture.name, step.capture.path);
    if (nested) {
      vars[step.capture.name] = nested.value;
      return nested.path;
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
        // The signed-in account's own id ({"user": {"id": 5}} or {"id": 5}), for checks about "my own" records.
        const own = parsed(r.text) && typeof parsed(r.text) === "object" ? (inferCapture(parsed(r.text), "userId", "$.id") ?? (usable(parsed(r.text).id) ? { value: parsed(r.text).id } : null)) : null;
        if (own && usable(own.value)) vars[`${n.id}.id`] = own.value;
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
    // Forge a tampered token for a security proof: decode the bearer token's payload, change a claim, re-encode without
    // re-signing, and register it as "<id>#forged". A server that verifies its tokens rejects it; one that does not accepts it.
    if (good && n.forge && a.headers.authorization) {
      try {
        const tok = String(a.headers.authorization).replace(/^Bearer\s+/i, "");
        const parts = tok.split(".");
        const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        const roleKey = Object.keys(payload).find((k) => /role|scope|admin|perm|type/i.test(k)) ?? "role";
        payload[roleKey] = n.forge.role ?? "admin";
        parts[0] = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const forged = `${n.id}#forged`;
        auths[forged] = { headers: { authorization: `Bearer ${parts.join(".")}` }, cookies: {} };
        ok.set(forged, true);
        results.push({ id: forged, kind: "identity", ok: true, note: `forged a tampered token (changed "${roleKey}") from ${n.id}'s token` });
      } catch {
        // The token is not decodable JSON (e.g. an opaque or encrypted token): a forged-token proof cannot be built.
      }
    }
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

// ---------------------------------------------------------------- typed scenarios (compiled by the API first)

class MissingSymbol extends Error {
  constructor(symbol) {
    super(`the value ${symbol} was not available`);
    this.symbol = symbol;
  }
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/** A fresh value made when the scenario runs. */
export function generated(kind, days = 0) {
  const uid = newUid();
  if (kind === "unique_email") return `cc-${uid}@example.test`;
  if (kind === "unique_name") return `cc-${uid}`;
  if (kind === "uuid") return crypto.randomUUID();
  if (kind === "today") return isoDay(new Date());
  if (kind === "days_from_today") return isoDay(new Date(Date.now() + Number(days) * 86400000));
  throw new Error(`unknown generated value ${kind}`);
}

const asNumber = (v, what) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${what} is not a number (${JSON.stringify(v)})`);
  return n;
};

/** Fills a JSON template: {"$symbol"}, {"$generated"} and {"$expr"} leaves become values. */
export function resolveTemplate(t, symbols) {
  if (Array.isArray(t)) return t.map((x) => resolveTemplate(x, symbols));
  if (t === null || typeof t !== "object") return t;
  if (typeof t.$symbol === "string") {
    if (!(t.$symbol in symbols) || symbols[t.$symbol] === undefined) throw new MissingSymbol(t.$symbol);
    return symbols[t.$symbol];
  }
  if (typeof t.$generated === "string") return generated(t.$generated, t.days);
  if (t.$expr && typeof t.$expr === "object") {
    const args = t.$expr.args.map((a, i) => asNumber(resolveTemplate(a, symbols), `argument ${i + 1} of ${t.$expr.op}`));
    const ops = { add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b, min: Math.min, max: Math.max };
    const v = args.slice(1).reduce((acc, x) => ops[t.$expr.op](acc, x), args[0]);
    return Math.round(v * 1e9) / 1e9;
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, resolveTemplate(v, symbols)]));
}

/**
 * The request line of a typed request: placeholders are whole path segments, each value encoded as one segment;
 * query values are appended separately and encoded, so "<script>", colons and braces arrive unchanged.
 */
export function requestPath(r, symbols) {
  const path = r.path.replace(/\{([^}/]+)\}/g, (_, name) => encodeURIComponent(String(resolveTemplate(r.pathParams?.[name], symbols))));
  const q = new URLSearchParams();
  for (const { name, value } of r.query ?? []) {
    const v = resolveTemplate(value, symbols);
    for (const x of Array.isArray(v) ? v : [v]) q.append(name, typeof x === "string" ? x : JSON.stringify(x));
  }
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Equal as data; numbers (and numeric strings against numbers) within a rounding error. */
export function sameValue(a, b) {
  const numeric = (x) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)));
  if (numeric(a) && numeric(b) && (typeof a === "number" || typeof b === "number")) return Math.abs(Number(a) - Number(b)) < 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

function readTarget(target, res) {
  if (!res || res.status == null) return undefined;
  if (target.from === "status") return res.status;
  if (target.from === "header") return res.headers?.[target.name.toLowerCase()];
  if (res.json === undefined) {
    try {
      res.json = JSON.parse(res.text);
    } catch {
      res.json = null;
    }
  }
  return res.json == null ? undefined : pick(res.json, target.jsonPath);
}

/** One assertion against the responses: whether it held, and what it expected and observed. */
export function checkAssertion(a, responses, symbols) {
  const res = responses.get(a.requestId);
  const target = a.target.from === "body" ? { ...a.target, jsonPath: pathWith(a.target.jsonPath, symbols) } : a.target;
  const observed = readTarget(target, res);
  let expected;
  try {
    expected = a.expected === undefined ? undefined : resolveTemplate(a.expected, symbols);
  } catch (e) {
    return { passed: false, expected: null, observed, why: String(e.message) };
  }
  const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  let passed;
  switch (a.op) {
    case "equals": passed = sameValue(observed, expected); break;
    case "not_equals": passed = observed !== undefined && !sameValue(observed, expected); break;
    case "gt": passed = num(observed) > num(expected); break;
    case "gte": passed = num(observed) >= num(expected); break;
    case "lt": passed = num(observed) < num(expected); break;
    case "lte": passed = num(observed) <= num(expected); break;
    case "one_of": passed = Array.isArray(expected) && expected.some((x) => sameValue(observed, x)); break;
    case "contains": passed = typeof observed === "string" ? observed.includes(String(expected)) : Array.isArray(observed) && observed.some((x) => sameValue(x, expected)); break;
    case "not_contains": passed = typeof observed === "string" ? !observed.includes(String(expected)) : Array.isArray(observed) && !observed.some((x) => sameValue(x, expected)); break;
    case "length": passed = (typeof observed === "string" || Array.isArray(observed)) && observed.length === num(expected); break;
    case "exists": passed = observed !== undefined && observed !== null; break;
    case "absent": passed = observed === undefined || observed === null; break;
    case "changed_by": {
      const before = readTarget(target, responses.get(a.baselineRequestId));
      passed = Number.isFinite(num(before)) && Number.isFinite(num(observed)) && Math.abs(num(observed) - num(before) - num(expected)) < 1e-6;
      return { passed, expected: { before, change: expected }, observed: { after: observed, change: Number.isFinite(num(before)) && Number.isFinite(num(observed)) ? num(observed) - num(before) : null }, why: passed ? null : `changed by ${Number.isFinite(num(before)) && Number.isFinite(num(observed)) ? num(observed) - num(before) : "an unknown amount"} instead of ${expected}` };
    }
    default: passed = false;
  }
  return { passed, expected, observed, why: passed ? null : `${a.says}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}` };
}

const REFUSED = new Set([401, 403]);

/**
 * Runs one compiled scenario against the app. A setup step that fails, a value that was never produced, or an
 * action stopped by sign-in makes it inconclusive (the behaviour was not reached); a failed assertion on a reached
 * action makes it failed. Each assertion leaves its expected and observed values and a short masked excerpt.
 */
export async function runScenario(s, { request, auths = {}, symbols: given = {} }) {
  const symbols = { ...given };
  // Fresh values the scenario makes for itself (one key sent twice must be the same key).
  for (const b of s.bindings ?? []) if (b.producer?.kind === "generated" && symbols[b.symbol] === undefined) symbols[b.symbol] = generated(b.producer.value);
  const responses = new Map();
  const reached = new Map();
  const inconclusive = (reason) => ({ scenarioId: s.id, status: "inconclusive", reason, targetReached: false, proofs: [] });
  for (const r of s.requests) {
    if (r.as && !auths[r.as]) return inconclusive(`Sign-in as ${r.as} did not work, so ${r.method} ${r.path} was not sent.`);
    let step;
    try {
      const headers = resolveTemplate(r.headers ?? {}, symbols);
      step = { method: r.method, path: requestPath(r, symbols), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) };
      if (r.body?.kind === "json") step.json = resolveTemplate(r.body.value, symbols);
      else if (r.body?.kind === "form") step.form = Object.fromEntries(Object.entries(resolveTemplate(r.body.fields, symbols)).map(([k, v]) => [k, String(v)]));
      else if (r.body?.kind === "raw") Object.assign(step, { raw: r.body.text, contentType: r.body.contentType });
    } catch (e) {
      if (e instanceof MissingSymbol) return inconclusive(`${e.message} for ${r.method} ${r.path}.`);
      throw e;
    }
    const res = await request(step, r.as ? auths[r.as] : null);
    responses.set(r.id, res);
    emit({ k: "req", method: r.method, path: step.path, status: res.status, ms: res.ms, ok: res.status != null && res.status < 500, as: r.as ?? null, check: s.id });
    if (r.role === "setup" && (res.status == null || res.status >= 400)) return inconclusive(`Setup ${r.method} ${r.path} answered ${res.status ?? res.error}, so the behaviour was not reached.`);
    // A refusal reaches the target only when the scenario expects that refusal (an isolation check expects 403).
    const expectsRefusal = s.assertions.some((a) => a.requestId === r.id && a.target.from === "status" && JSON.stringify(a.expected ?? null).match(/\b(401|403|404)\b/));
    // No answer at all (a crash, a reset connection) means the request reached the app and broke it: not a refusal.
    const refused = res.status != null && ((REFUSED.has(res.status) && !expectsRefusal) || (res.status === 404 && Object.keys(r.pathParams ?? {}).length > 0 && !expectsRefusal));
    reached.set(r.id, !refused);
    if (r.role === "action" && refused) return inconclusive(`${r.method} ${r.path} answered ${res.status ?? res.error} before reaching the behaviour under test${res.status === 404 ? " (the record was not found)" : ""}.`);
    // A refusal that is itself correct behaviour (a parent with children may not be deleted) ends the scenario as passed.
    if (r.endsIfRefused && !refused && res.status != null && res.status >= 400 && res.status < 500) {
      const excerpt = mask(`${res.status} ${res.text ?? ""}`).slice(0, 400);
      const proofs = s.assertions.map((a) => ({ requirementId: a.requirementId, assertionId: a.id, passed: true, expected: "refused, or done without breaking related records", observed: { status: res.status }, targetReached: true, stateVerified: false, excerpt }));
      return { scenarioId: s.id, status: "passed", reason: `${r.method} ${r.path} answered ${res.status}: the app refused it, which also keeps related records consistent.`, targetReached: true, proofs };
    }
    if (res.status != null && res.status < 400 && r.captures?.length) {
      const json = readTarget({ from: "body", jsonPath: "$" }, res);
      for (const c of r.captures) {
        const v = json == null ? undefined : pick(json, pathWith(c.jsonPath, symbols));
        if (v !== undefined) symbols[c.symbol] = v;
      }
    }
  }
  const proofs = s.assertions.map((a) => {
    const req = s.requests.find((x) => x.id === a.requestId);
    const r = checkAssertion(a, responses, symbols);
    const res = responses.get(a.requestId);
    return {
      requirementId: a.requirementId,
      assertionId: a.id,
      passed: r.passed,
      expected: r.expected,
      observed: r.observed,
      targetReached: Boolean(reached.get(a.requestId)),
      stateVerified: r.passed && (req?.role === "readback" || a.op === "changed_by"),
      excerpt: res ? mask(`${res.status ?? ""} ${res.text ?? ""}`).slice(0, 400) : null,
      why: r.why,
    };
  });
  const failed = proofs.filter((p) => !p.passed);
  const crash = s.requests.find((r) => r.role === "action" && responses.has(r.id) && (responses.get(r.id).status == null || responses.get(r.id).status >= 500));
  const crashText = crash ? `${crash.method} ${crash.path} ${responses.get(crash.id).status == null ? `got no response (${responses.get(crash.id).error}); the app may have crashed` : `answered ${responses.get(crash.id).status}`}.` : "";
  return {
    scenarioId: s.id,
    status: failed.length || crash ? "failed" : "passed",
    reason: [crashText, failed.map((p) => p.why).join("; ")].filter(Boolean).join(" ").slice(0, 800) || `All ${proofs.length} assertion(s) held.`,
    targetReached: true,
    proofs: proofs.map(({ why: _w, ...p }) => p),
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

// ---------------------------------------------------------------- AI Evaluator replay model

/** What the replay model says when a case set no script (a turn of the conversation before the one under test). */
export const REPLAY_DEFAULT = "This is cybercheck's replay model. No scripted answer was set for this request.";

const approxTokens = (s) => Math.max(1, Math.ceil(String(s ?? "").length / 4));

/**
 * A loopback, OpenAI-compatible model that answers from a script, so an app's own handling of model output (prompt
 * building, parsing, tools, retries, errors) can be exercised with no real provider. `setScript(turns)` arms the
 * script for the next request(s): each model call takes the next turn and the last one repeats. Every call is recorded
 * (path, request body, what was served). Turns: {content, toolCalls, status, malformed, hang}.
 */
export async function startReplay(port, host = "127.0.0.1") {
  const state = { script: null, served: 0, requests: [], hanging: new Set(), seq: 0 };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw || "null");
      } catch {}
      const path = String(req.url ?? "").split("?")[0];
      const isChat = req.method === "POST" && /\/chat\/completions$/.test(path);
      const turn = isChat ? (state.script?.length ? state.script[Math.min(state.served, state.script.length - 1)] : { content: REPLAY_DEFAULT }) : null;
      if (isChat) state.served++;
      const served = !isChat ? "unsupported" : turn.hang ? "hang" : turn.status ? `status ${turn.status}` : turn.malformed ? "malformed" : turn.toolCalls?.length ? "tool_calls" : state.script?.length ? "content" : "default";
      state.requests.push({ method: req.method, path, body: raw.slice(0, 40000), served, at: Date.now() });
      if (!isChat) {
        if (req.method === "GET" && /\/models$/.test(path)) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "cc-replay", object: "model" }] }));
        return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The replay model only answers chat completions.", type: "invalid_request_error" } }));
      }
      if (turn.hang) {
        state.hanging.add(res);
        res.on("close", () => state.hanging.delete(res));
        return;
      }
      if (turn.status) return res.writeHead(turn.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Replayed provider error.", type: turn.status === 429 ? "rate_limit_error" : "server_error" } }));
      if (turn.malformed) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "cc-replay-malformed", object: "chat.completion" }));
      state.seq++;
      const toolCalls = (turn.toolCalls ?? []).map((t, i) => ({ id: `call_cc${state.seq}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } }));
      const message = { role: "assistant", content: turn.content ?? (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      const usage = { prompt_tokens: approxTokens(JSON.stringify(body?.messages ?? "")), completion_tokens: approxTokens(turn.content ?? JSON.stringify(toolCalls)) };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const finish = toolCalls.length ? "tool_calls" : "stop";
      const model = typeof body?.model === "string" ? body.model : "cc-replay";
      if (body?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `cc-replay-${state.seq}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant", ...(message.content ? { content: message.content } : {}), ...(toolCalls.length ? { tool_calls: toolCalls.map((t, index) => ({ index, ...t })) } : {}) });
        chunk({}, finish);
        res.write(`data: ${JSON.stringify({ id: `cc-replay-${state.seq}`, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `cc-replay-${state.seq}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    /** Arm a script for the following model calls; null serves the default answer. */
    setScript(turns) {
      state.script = turns && turns.length ? turns : null;
      state.served = 0;
    },
    /** Requests recorded since index `from`. */
    since: (from) => state.requests.slice(from),
    get count() {
      return state.requests.length;
    },
    /** Release hanging answers (between cases and at the end). */
    release() {
      for (const res of state.hanging) res.destroy();
      state.hanging.clear();
    },
    close() {
      this.release();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/**
 * The restricted live-model gateway: a loopback OpenAI-compatible server the app is pointed at. It overrides the model
 * to cybercheck's configured one, forwards each chat completion to the upstream provider with cybercheck's credentials
 * (which the app never sees), enforces request, token and cost limits, and records sanitized usage only (model, token
 * counts, latency, cost; never the credentials or the raw messages). A gateway or upstream error is reported to the
 * app as a clean 502, so it never becomes an AI-quality failure. `cfg`: { upstreamUrl, upstreamKey, model, maxRequests,
 * maxTokensPerCall, maxCostUsd, inPricePerMTok, outPricePerMTok }.
 */
export async function startGateway(port, cfg, host = "127.0.0.1") {
  const state = { requests: [], spentUsd: 0, overBudget: false };
  const cost = (inTok, outTok) => (inTok * cfg.inPricePerMTok + outTok * cfg.outPricePerMTok) / 1_000_000;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const path = String(req.url ?? "").split("?")[0];
      if (req.method === "GET" && /\/models$/.test(path)) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: cfg.model, object: "model" }] }));
      if (!(req.method === "POST" && /\/chat\/completions$/.test(path))) return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The gateway only forwards chat completions.", type: "invalid_request_error" } }));
      let body = null;
      try {
        body = JSON.parse(raw || "null");
      } catch {}
      const requestedModel = typeof body?.model === "string" ? body.model : null;
      // Request and cost budgets: stop before sending once either is used up.
      if (state.requests.length >= (cfg.maxRequests ?? 1e9) || state.spentUsd >= (cfg.maxCostUsd ?? 1e9)) {
        state.overBudget = true;
        state.requests.push({ requestedModel, served: "budget", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 });
        return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The gateway budget was reached.", type: "rate_limit_error" } }));
      }
      // Cap the output tokens cybercheck's model may produce (the app's own value is clamped down, never up).
      const forward = { ...(body ?? {}), model: cfg.model, max_tokens: Math.min(Number(body?.max_tokens ?? cfg.maxTokensPerCall ?? 1024), cfg.maxTokensPerCall ?? 1024), stream: false };
      const started = Date.now();
      try {
        const up = await fetch(`${cfg.upstreamUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.upstreamKey}` }, body: JSON.stringify(forward), signal: AbortSignal.timeout(cfg.timeoutMs ?? 30000) });
        const text = await up.text();
        const ms = Date.now() - started;
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        const inTok = json?.usage?.prompt_tokens ?? approxTokens(JSON.stringify(body?.messages ?? ""));
        const outTok = json?.usage?.completion_tokens ?? approxTokens(JSON.stringify(json?.choices ?? ""));
        const c = cost(inTok, outTok);
        state.spentUsd += c;
        state.requests.push({ requestedModel, served: up.ok ? "forwarded" : `upstream ${up.status}`, inputTokens: inTok, outputTokens: outTok, costUsd: c, ms });
        if (!up.ok) return res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The model provider returned an error.", type: "server_error" } }));
        return res.writeHead(200, { "content-type": "application/json" }).end(text);
      } catch (err) {
        state.requests.push({ requestedModel, served: `error ${String(err?.name ?? err)}`, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: Date.now() - started });
        return res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The gateway could not reach the model provider.", type: "server_error" } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    since: (from) => state.requests.slice(from),
    get count() {
      return state.requests.length;
    },
    get spentUsd() {
      return state.spentUsd;
    },
    get overBudget() {
      return state.overBudget;
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
