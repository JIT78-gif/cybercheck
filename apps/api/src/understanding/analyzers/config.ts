import type { Node } from "web-tree-sitter";
import type { EnvVar, Evidence } from "@cybercheck/contracts";
import { line, stringValue, walk, type Parsed } from "../parse.ts";
import { envExampleNames, isEnvExample } from "../source.ts";
import { isFrontendPath, type Ctx } from "./context.ts";

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,}$/;
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_KEY|CREDENTIAL|_KEY$|^KEY$|(?<!SENTRY_)DSN$|DATABASE_URL|CONNECTION_STRING|_URI_WITH_AUTH|WEBHOOK_SECRET)/;
const BROWSER_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;
/** Shell and CI variables that are not application configuration. */
const SHELL_VARS = new Set(["HOME", "PATH", "PWD", "USER", "SHELL", "HOSTNAME", "TERM", "LANG", "TMPDIR", "OLDPWD", "IFS", "UID", "GID", "PPID", "RANDOM", "SECONDS", "LINENO", "BASH_SOURCE", "CI", "GITHUB_SHA", "GITHUB_REF", "GITHUB_TOKEN", "GITHUB_WORKSPACE", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "RUNNER_OS"]);

type Read = { name: string; evidence: Evidence; via: string | null; required: boolean | null; hasDefault: boolean | null; defaultValue?: string | null };

/** A function that reads an environment variable named by one of its parameters. */
type Wrapper = { name: string; param: number; required: boolean | null; defaultParam: number | null };

function params(fn: Node): string[] {
  const ps = fn.childForFieldName("parameters");
  return (ps?.namedChildren ?? []).map((p) => (p?.childForFieldName("pattern") ?? p?.childForFieldName("name") ?? p)?.text.replace(/[:=].*$/, "").trim() ?? "");
}

function functionsOf(p: Parsed): Array<{ name: string; node: Node; params: string[]; body: string }> {
  const out: Array<{ name: string; node: Node; params: string[]; body: string }> = [];
  for (const n of walk(p.tree.rootNode)) {
    if (n.type === "function_declaration" || n.type === "function_definition") {
      const name = n.childForFieldName("name")?.text;
      if (name) out.push({ name, node: n, params: params(n), body: n.childForFieldName("body")?.text ?? "" });
    } else if (n.type === "variable_declarator") {
      const v = n.childForFieldName("value");
      const name = n.childForFieldName("name")?.text;
      if (name && v && /^(arrow_function|function_expression|function)$/.test(v.type)) out.push({ name, node: v, params: params(v), body: v.childForFieldName("body")?.text ?? "" });
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find env-reading helpers, including helpers that call other helpers (requireMinLength -> required). */
function findWrappers(ctx: Ctx): Map<string, Wrapper> {
  const wrappers = new Map<string, Wrapper>();
  const fns = [...ctx.parsed.values()].filter((p) => !ctx.isTest(p.path)).flatMap((p) => functionsOf(p).map((f) => ({ ...f, lang: p.lang })));
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fns) {
      if (wrappers.has(f.name)) continue;
      f.params.forEach((param, i) => {
        if (!param || wrappers.has(f.name)) return;
        const P = esc(param);
        const direct = f.lang === "python"
          ? new RegExp(`os\\.(?:environ\\s*\\[\\s*${P}\\s*\\]|environ\\.get\\(\\s*${P}|getenv\\(\\s*${P})`)
          : new RegExp(`(?:process\\.env|import\\.meta\\.env|Bun\\.env)\\s*\\[\\s*${P}\\s*\\]|Deno\\.env\\.get\\(\\s*${P}`);
        const viaOther = [...wrappers.values()].find((w) => new RegExp(`\\b${esc(w.name)}\\(\\s*${P}\\b`).test(f.body));
        if (!direct.test(f.body) && !viaOther) return;
        const throws = /\bthrow\b|raise\b|process\.exit\(/.test(f.body);
        // Any other parameter used in the body is treated as the fallback: optional(name, fallback).
        const fallbackParam = f.params.findIndex((x, j) => j !== i && x && new RegExp(`\\b${esc(x)}\\b`).test(f.body));
        const named = /^(required|require\w*|must\w*|get_?required\w*)$/i.test(f.name) ? true : /^(optional|opt|get_?optional\w*|with_?default)$/i.test(f.name) ? false : null;
        wrappers.set(f.name, {
          name: f.name,
          param: i,
          defaultParam: fallbackParam >= 0 ? fallbackParam : null,
          required: viaOther?.required ?? named ?? (throws && fallbackParam < 0 ? true : fallbackParam >= 0 ? false : null),
        });
      });
    }
  }
  return wrappers;
}

function wrapperReads(p: Parsed, wrappers: Map<string, Wrapper>, out: Read[]) {
  if (!wrappers.size) return;
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression" && n.type !== "call") continue;
    const fn = (n.childForFieldName("function")?.text ?? "").split(".").at(-1) ?? "";
    const w = wrappers.get(fn);
    if (!w) continue;
    const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) as Node[];
    const arg = args[w.param];
    const name = stringValue(arg);
    if (!name || !ENV_NAME.test(name)) continue;
    const hasDefault = w.defaultParam != null ? args.length > w.defaultParam : null;
    const defArg = w.defaultParam != null ? args[w.defaultParam] : undefined;
    out.push({ name, evidence: { path: p.path, line: line(arg!) }, via: `${w.name}()`, required: w.required === true ? true : hasDefault ? false : w.required, hasDefault, defaultValue: defArg ? (stringValue(defArg) ?? defArg.text.slice(0, 60)) : null });
  }
}

function directReads(p: Parsed, out: Read[]) {
  const re = p.lang === "python"
    ? /os\.(?:environ\s*\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|environ\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*(,)?|getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*(,)?)|\benv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g
    : /(?:process\.env|import\.meta\.env|Bun\.env)\s*(?:\.\s*([A-Z_][A-Z0-9_]*)|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])(!)?|Deno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']/g;
  for (const m of p.text.matchAll(re)) {
    const name = m[1] ?? m[2] ?? m[4] ?? m[6];
    if (!name) continue;
    const at = { path: p.path, line: p.text.slice(0, m.index).split("\n").length };
    const after = p.text.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
    const hasDefault = p.lang === "python" ? (m[3] === "," || m[5] === "," ? true : m[1] ? false : null) : /^\s*(\?\?|\|\|)/.test(after) ? true : null;
    const required = p.lang === "python" && m[1] ? true : m[3] === "!" ? true : hasDefault ? false : null;
    const literal = after.match(/^\s*(?:\?\?|\|\|)\s*(["'`])([^"'`]*)\1/)?.[2] ?? null;
    out.push({ name, evidence: at, via: null, required, hasDefault, defaultValue: literal });
  }
  // const { A, B } = process.env
  if (p.lang !== "python") {
    for (const m of p.text.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.split(/[:=]/)[0]!.trim();
        if (ENV_NAME.test(name)) out.push({ name, evidence: { path: p.path, line: p.text.slice(0, m.index).split("\n").length }, via: "destructuring", required: null, hasDefault: /=/.test(part) || null });
      }
    }
  }
}

/** Schemas validated against the environment: z.object({...}).parse(process.env), createEnv({ server: {...} }), pydantic BaseSettings. */
function schemaReads(p: Parsed, out: Read[]) {
  if (p.lang === "python") {
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "class_definition" || !/BaseSettings/.test(n.childForFieldName("superclasses")?.text ?? "")) continue;
      for (const st of n.childForFieldName("body")?.namedChildren ?? []) {
        const a = st?.type === "expression_statement" ? st.namedChildren[0] : null;
        if (a?.type !== "assignment" || !a.childForFieldName("type")) continue;
        const field = a.childForFieldName("left")?.text ?? "";
        if (!/^\w+$/.test(field) || field.startsWith("_") || field === "model_config") continue;
        const hasDefault = Boolean(a.childForFieldName("right"));
        out.push({ name: field.toUpperCase(), evidence: { path: p.path, line: line(a) }, via: "pydantic BaseSettings", required: !hasDefault && !/Optional\[|None/.test(a.childForFieldName("type")!.text), hasDefault, defaultValue: a.childForFieldName("right")?.text.replace(/^["']|["']$/g, "").slice(0, 60) ?? null });
      }
    }
    return;
  }
  if (!/\.(?:safe)?[pP]arse\(\s*process\.env|createEnv\(/.test(p.text)) return;
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression" || !/^z\.object$/.test(n.childForFieldName("function")?.text ?? "")) continue;
    const obj = n.childForFieldName("arguments")?.namedChildren[0];
    if (obj?.type !== "object") continue;
    for (const pair of obj.namedChildren) {
      if (pair?.type !== "pair") continue;
      const key = pair.childForFieldName("key")?.text.replace(/['"]/g, "") ?? "";
      if (!ENV_NAME.test(key)) continue;
      const v = pair.childForFieldName("value")?.text ?? "";
      const hasDefault = /\.default\(/.test(v);
      out.push({ name: key, evidence: { path: p.path, line: line(pair) }, via: "zod env schema", required: !hasDefault && !/\.optional\(\)|\.nullish\(\)/.test(v), hasDefault, defaultValue: v.match(/\.default\(\s*["'`]?([^"'`)]*)/)?.[1] ?? null });
    }
  }
}

/** ${VAR}, ${VAR:-x}, $VAR and Caddy's {$VAR} in compose, Caddyfile, shell scripts, Dockerfiles and YAML config. */
function deployReads(ctx: Ctx, out: Read[]) {
  for (const [path, f] of ctx.src.files) {
    if (!/(^|\/)(Dockerfile[\w.-]*|Containerfile|Caddyfile|[\w.-]+\.conf|[\w.-]+\.sh|[\w.-]+\.ya?ml|Procfile|[\w.-]+\.toml)$/.test(path)) continue;
    if (/^\.github\//.test(path) && /\$\{\{/.test(f.text)) {
      // GitHub Actions expressions are CI variables, not app configuration.
    }
    f.text.split("\n").forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      for (const m of l.replace(/\$\{\{[^}]*\}\}/g, "").matchAll(/\{\$([A-Z][A-Z0-9_]+)\}|\$\{([A-Z][A-Z0-9_]+)(?::?[-=?+][^}]*)?\}|\$([A-Z][A-Z0-9_]+)\b/g)) {
        const name = m[1] ?? m[2] ?? m[3]!;
        if (SHELL_VARS.has(name)) continue;
        out.push({ name, evidence: { path, line: i + 1 }, via: null, required: null, hasDefault: /:-|:=/.test(m[0]) || null });
      }
    });
  }
}

/**
 * "At least one of these must be set" checks: if (!A && !B) throw ... where A and B are env reads
 * or config fields backed by env vars.
 */
export function requiredOneOf(ctx: Ctx, envOf: (expr: string) => string | null): Array<{ names: string[]; evidence: Evidence }> {
  const out: Array<{ names: string[]; evidence: Evidence }> = [];
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path)) continue;
    for (const m of p.text.matchAll(/if\s*\(\s*!\s*([\w.]+(?:\[[^\]]+\])?)\s*&&\s*!\s*([\w.]+(?:\[[^\]]+\])?)(?:\s*&&\s*!\s*([\w.]+))?\s*\)\s*\{?\s*(?:throw|process\.exit|raise)/g)) {
      const names = [m[1], m[2], m[3]].filter((x): x is string => Boolean(x)).map((x) => x.match(/process\.env\.(\w+)|\[["'](\w+)["']\]/)?.slice(1).find(Boolean) ?? envOf(x)).filter((x): x is string => Boolean(x));
      if (names.length >= 2) out.push({ names, evidence: { path: p.path, line: p.text.slice(0, m.index).split("\n").length } });
    }
  }
  return out;
}

export function analyzeConfig(ctx: Ctx): { envVars: EnvVar[] } {
  const reads: Read[] = [];
  const wrappers = findWrappers(ctx);
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    wrapperReads(p, wrappers, reads);
    directReads(p, reads);
    schemaReads(p, reads);
  }
  deployReads(ctx, reads);

  const declared = new Map<string, Evidence[]>();
  for (const [path, f] of ctx.src.files) {
    if (!isEnvExample(path)) continue;
    for (const { name, line: l } of envExampleNames(f.text)) declared.set(name, [...(declared.get(name) ?? []), { path, line: l }]);
  }

  const names = new Set([...reads.map((r) => r.name), ...declared.keys()]);
  const envVars: EnvVar[] = [...names].sort().map((name) => {
    const rs = reads.filter((r) => r.name === name);
    const code = rs.filter((r) => ctx.parsed.has(r.evidence.path));
    const usedIn = [...new Map(rs.map((r) => [`${r.evidence.path}:${r.evidence.line}`, r.evidence])).values()].slice(0, 10);
    const req = code.map((r) => r.required).find((x) => x != null) ?? null;
    const def = code.map((r) => r.hasDefault).find((x) => x != null) ?? null;
    const defaultValue = code.map((r) => r.defaultValue).find((x) => x != null) ?? null;
    const browser = BROWSER_PREFIX.test(name) || code.some((r) => isFrontendPath(ctx, r.evidence.path));
    return {
      id: `env:${name}`,
      status: "observed",
      name,
      usedIn,
      declaredIn: declared.get(name) ?? [],
      documented: declared.has(name),
      required: req,
      hasDefault: def,
      sensitivity: SECRET_NAME.test(name) ? "secret" : "config",
      side: browser ? "browser" : code.length ? "server" : rs.length ? "deploy" : "server",
      readVia: [...new Set(rs.map((r) => r.via).filter((x): x is string => Boolean(x)))],
      defaultValue: SECRET_NAME.test(name) ? null : defaultValue,
    } satisfies EnvVar;
  });
  return { envVars };
}
