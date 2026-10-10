import type { Node } from "web-tree-sitter";
import type { EntryPoint, Evidence, RuntimeFacts } from "@cybercheck/contracts";
import { line, walk } from "../parse.ts";
import { isFrontendPath, type Ctx } from "./context.ts";
import { configObjects, resolveMember } from "./integrations.ts";

const lineAt = (text: string, i: number) => text.slice(0, i).split("\n").length;
const first = (ctx: Ctx, re: RegExp, filter: (path: string) => boolean = () => true): Evidence | null => {
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path) || !filter(p.path)) continue;
    const m = p.text.match(re);
    if (m?.index !== undefined) return { path: p.path, line: lineAt(p.text, m.index) };
  }
  return null;
};

/** Object literal text after `key:` inside `text` (balanced braces), or null. */
function objectAfter(text: string, key: RegExp): string | null {
  const m = text.match(key);
  if (!m || m.index === undefined) return null;
  const start = text.indexOf("{", m.index + m[0].length - 1);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** key: value pairs from a small object literal, with config references resolved to their defaults. */
function pairs(obj: string, configs: Map<string, Node>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of obj.matchAll(/(\w+)\s*:\s*([^,}\n]+)/g)) {
    const key = m[1]!;
    let value = m[2]!.trim().replace(/\s*\/\/.*$/, "");
    if (/^\{/.test(value)) continue;
    const ref = value.match(/^([a-z]\w*(?:\.\w+)+)$/i);
    if (ref && configs.size) {
      const r = resolveMember(ref[1]!, configs);
      if (r?.value != null) value = `${r.value}${r.env ? ` (${r.env}, default)` : ""}`;
      else if (r?.env) value = `from ${r.env}`;
    }
    // 60 * 60 * 24 * 7 -> 604800
    if (/^[\d\s*+]+$/.test(value) && /[*+]/.test(value)) value = String(value.split("+").reduce((sum, term) => sum + term.split("*").reduce((prod, x) => prod * Number(x.trim()), 1), 0));
    const bytes = Number(value.split(" ")[0]);
    if (/size|bytes|limit/i.test(key) && Number.isFinite(bytes) && bytes >= 1024) value = `${value} (${bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.round(bytes / 1024)} KB`})`;
    // Strip quotes only from plain literals; expressions stay as written.
    out[key] = /^(["'])[^"']*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}

const UPLOAD_LIBS: Array<[RegExp, string]> = [[/@fastify\/multipart/, "@fastify/multipart"], [/\bmulter\b/, "multer"], [/\bbusboy\b/, "busboy"], [/\bformidable\b/, "formidable"], [/UploadFile/, "FastAPI UploadFile"], [/request\.files/, "Flask/Django request.files"]];

export function analyzeRuntime(ctx: Ctx, entryPoints: EntryPoint[]): RuntimeFacts {
  const configs = configObjects(ctx);
  const code = [...ctx.parsed.values()].filter((p) => !ctx.isTest(p.path));
  const all = code.map((p) => p.text).join("\n");

  // ---- Uploads
  const uploads: RuntimeFacts["uploads"] = [];
  const lib = UPLOAD_LIBS.find(([re]) => re.test(all))?.[1];
  const registration = code.map((p) => ({ p, m: p.text.match(/register\(\s*(?:fastifyMultipart|multipart)\b|multer\(\s*\{|MAX_CONTENT_LENGTH/) })).find((x) => x.m);
  const regLimits = registration ? pairs(objectAfter(registration.p.text.slice(registration.m!.index!), /limits\s*:/) ?? "", configs) : {};
  const storageDir = first(ctx, /(?:createWriteStream|writeFile|\.save\()\s*\(/);
  const storageExpr = code.map((p) => p.text.match(/const\s+(?:ROOT|UPLOAD_DIR|UPLOADS?_ROOT|STORAGE_DIR|AUDIO_DIR)\s*=\s*([^;\n]+)/)?.[1]).find(Boolean);
  const storage = storageExpr ? storageExpr.replace(/resolve\(\s*(config\.[\w.]+)\s*\)/, (_m, ref: string) => { const r = resolveMember(ref, configs); return r ? `${r.value ?? ""}${r.env ? ` (${r.env})` : ""}` : ref; }) : null;
  const servesStoredType = /\.type\(\s*\w+\.(mime_?type|content_?type|mimeType)\s*\)|['"]Content-Type['"]\s*,\s*\w+\.(mime_?type|mimeType)/i.test(all);
  const storesClientType = /\.mimetype\b|file\.type\b|content_type\b/.test(all);
  for (const e of entryPoints.filter((x) => x.inputs.files)) {
    uploads.push({ endpoint: `${e.method} ${e.path}`, library: lib ?? "unknown", limits: regLimits, storage, contentTypeFromClient: storesClientType && servesStoredType ? true : storesClientType ? null : false, evidence: [e.handler, ...(registration ? [{ path: registration.p.path, line: lineAt(registration.p.text, registration.m!.index!) }] : []), ...(storageDir ? [storageDir] : [])] });
  }
  if (!uploads.length && registration) uploads.push({ endpoint: null, library: lib ?? "unknown", limits: regLimits, storage, contentTypeFromClient: null, evidence: [{ path: registration.p.path, line: lineAt(registration.p.text, registration.m!.index!) }] });

  // ---- Session
  let session: RuntimeFacts["session"] = null;
  const sess = code.map((p) => ({ p, m: p.text.match(/register\(\s*(secureSession|fastifySession|session)\b|app\.use\(\s*(session|cookieSession)\(|SESSION_ENGINE|iron-session|getIronSession/) })).find((x) => x.m);
  if (sess) {
    const tail = sess.p.text.slice(sess.m!.index!);
    const cookie = pairs(objectAfter(tail, /cookie\s*:/) ?? "", configs);
    const name = tail.match(/cookieName\s*:\s*["'](\w+)["']|name\s*:\s*["'](\w+)["']/);
    if (name) cookie.name = name[1] ?? name[2]!;
    const library = /secureSession/.test(sess.m![0]) ? "@fastify/secure-session" : /cookieSession/.test(sess.m![0]) ? "cookie-session" : /iron/i.test(sess.m![0]) ? "iron-session" : /SESSION_ENGINE/.test(sess.m![0]) ? "django sessions" : ctx.declared.has("express-session") ? "express-session" : "@fastify/session";
    const keys = [...new Set([...all.matchAll(/session\.set\(\s*["'](\w+)["']|session\.(\w+)\s*=(?!=)|session\[["'](\w+)["']\]\s*=(?!=)/g)].map((m) => m[1] ?? m[2] ?? m[3]!).filter((k) => !/^(cookie|regenerate|destroy|touch)$/.test(k)))];
    session = { library, storage: /secure-session|cookie-session|iron-session/.test(library) ? "cookie" : /express-session|@fastify\/session|django/.test(library) ? "server" : "unknown", cookie, keys, evidence: [{ path: sess.p.path, line: lineAt(sess.p.text, sess.m!.index!) }] };
  }

  // ---- Limits
  const limits: RuntimeFacts["limits"] = [];
  for (const p of code) {
    for (const m of p.text.matchAll(/\bbodyLimit\s*:\s*([^,}\n]+)|express\.json\(\s*\{[^}]*limit\s*:\s*["']([^"']+)["']|MAX_CONTENT_LENGTH\s*=\s*([^\n]+)|DATA_UPLOAD_MAX_MEMORY_SIZE\s*=\s*([^\n]+)/g)) {
      limits.push({ name: m[1] ? "bodyLimit" : m[2] ? "json body limit" : m[3] ? "MAX_CONTENT_LENGTH" : "DATA_UPLOAD_MAX_MEMORY_SIZE", value: (m[1] ?? m[2] ?? m[3] ?? m[4]!).trim(), evidence: { path: p.path, line: lineAt(p.text, m.index!) } });
    }
  }
  for (const [k, v] of Object.entries(regLimits)) limits.push({ name: `upload ${k}`, value: v, evidence: { path: registration!.p.path, line: lineAt(registration!.p.text, registration!.m!.index!) } });
  if (!limits.some((l) => l.name === "bodyLimit") && ctx.declared.has("fastify")) limits.push({ name: "bodyLimit", value: "1 MB (Fastify default, not overridden)", evidence: first(ctx, /Fastify\(/) ?? { path: code[0]?.path ?? "package.json", line: 1 } });

  // ---- Outbound calls
  const outboundCalls: RuntimeFacts["outboundCalls"] = [];
  for (const p of code) {
    if (isFrontendPath(ctx, p.path)) continue;
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "call_expression" && n.type !== "call") continue;
      const fn = n.childForFieldName("function")?.text ?? "";
      if (!/^(fetch|axios(\.\w+)?|got(\.\w+)?|ky(\.\w+)?|requests\.\w+|httpx\.\w+|undici\.request)$/.test(fn)) continue;
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) as Node[];
      const target = (args[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      if (target.startsWith("'/") || target.startsWith('"/')) continue; // same-origin paths
      outboundCalls.push({ target, timeout: /\bsignal\s*:|\btimeout\s*[:=]|AbortSignal\.timeout|AbortController/.test(n.text), evidence: { path: p.path, line: line(n) } });
    }
  }

  // ---- Error handling
  const eh = first(ctx, /setErrorHandler\(|app\.use\(\s*\(\s*err\b|app\.use\(\s*function\s*\(\s*err|@app\.exception_handler|errorhandler\(/i);

  // ---- Agent instruction files (untrusted for downstream AI agents)
  const agentInstructionFiles = ctx.src.allPaths.filter((p) => /(^|\/)(\.agents?|\.cursor|\.claude|\.windsurf|\.clinerules|\.aider[\w.-]*|\.continue)(\/|$)|(^|\/)(AGENTS|CLAUDE|GEMINI|COPILOT)\.md$|\.github\/copilot-instructions\.md$|(^|\/)SKILL\.md$/i.test(p));

  // ---- Supply chain
  const images: RuntimeFacts["supplyChain"]["images"] = [];
  const installs: RuntimeFacts["supplyChain"]["installs"] = [];
  for (const [path, f] of ctx.src.files) {
    const isDocker = /(^|\/)(Dockerfile|Containerfile)[\w.-]*$/.test(path);
    const isCompose = /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(path);
    if (!isDocker && !isCompose) continue;
    f.text.split("\n").forEach((l, i) => {
      const img = isDocker ? l.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i)?.[1] ?? l.match(/COPY\s+--from=([\w./:@-]+[:@][\w.:-]+)/i)?.[1] : l.match(/^\s*image:\s*["']?([^\s"']+)/)?.[1];
      if (img && !/^[a-z0-9_-]+$/i.test(img)) images.push({ image: img, pinned: /@sha256:|:\d+\.\d+\.\d+/.test(img), evidence: { path, line: i + 1 } });
      const inst = isDocker ? l.match(/\b(npm (?:ci|install|i)\b[^&;\n]*|pnpm install[^&;\n]*|yarn(?: install)?[^&;\n]*|pip install[^&;\n]*|poetry install[^&;\n]*|uv sync[^&;\n]*)/)?.[1] : null;
      if (inst) installs.push({ command: inst.trim(), locked: /npm ci|--frozen-lockfile|--immutable|poetry install|uv sync|--require-hashes|-r requirements[\w.-]*\.txt/.test(inst), evidence: { path, line: i + 1 } });
    });
  }
  const ci = [...ctx.src.files].filter(([p]) => /^\.github\/workflows\/[\w.-]+\.ya?ml$|(^|\/)\.gitlab-ci\.yml$/.test(p)).map(([path, f]) => ({
    path,
    runsTests: /\b(npm (run )?test|pnpm test|yarn test|vitest|jest|pytest|playwright test|go test)\b/.test(f.text),
    runsTypecheck: /\b(tsc|typecheck|mypy|pyright)\b/.test(f.text),
    runsLint: /\b(eslint|lint|ruff|flake8|biome)\b/.test(f.text),
    publishes: /push:\s*true|docker push|build-push-action[\s\S]*push/.test(f.text) ? (f.text.match(/registry:\s*([\w.-]+)/)?.[1] ?? f.text.match(/\b(ghcr\.io|docker\.io|\d+\.dkr\.ecr[\w.-]+|gcr\.io|registry\.gitlab\.com)\b/)?.[1] ?? "a container registry") : /npm publish|pypi-publish|twine upload/.test(f.text) ? "package registry" : null,
  }));

  // ---- Frontend
  const fe = code.filter((p) => isFrontendPath(ctx, p.path));
  let frontend: RuntimeFacts["frontend"] = null;
  if (fe.length) {
    const basename = all.match(/basename\s*[=:]\s*\{?\s*["'`](\/[^"'`]*)["'`]/)?.[1] ?? null;
    const vite = [...ctx.src.files].find(([p]) => /(^|\/)vite\.config\.\w+$/.test(p));
    const devServer = vite ? { port: vite[1].text.match(/port\s*:\s*(\d+)/)?.[1] ?? "5173", proxy: [...(objectAfter(vite[1].text, /proxy\s*:/) ?? "").matchAll(/["'](\/[^"']*)["']\s*:/g)].map((m) => m[1]!) } : null;
    const client = fe.find((p) => /credentials\s*:\s*["']include["']|withCredentials\s*:\s*true|credentials\s*:\s*["']same-origin["']/.test(p.text));
    const apiClient = client
      ? {
          file: client.path,
          sendsCookies: true,
          on401: /401/.test(client.text) ? (/dispatchEvent|navigate|location\.(href|assign|replace)|redirect|signOut|logout/i.test(client.text) ? "sends the user to the sign-in page" : "throws an error") : null,
          evidence: [{ path: client.path, line: lineAt(client.text, client.text.search(/credentials\s*:|withCredentials/)) }],
        }
      : null;
    const thirdPartyAssets: Array<{ host: string; evidence: Evidence }> = [];
    for (const [path, f] of ctx.src.files) {
      if (!isFrontendPath(ctx, path) || !/\.(html|css|tsx|jsx)$/.test(path)) continue;
      for (const m of f.text.matchAll(/(?:href|src)=["']https?:\/\/([^/"']+)|@import\s+url\(["']?https?:\/\/([^/"')]+)/g)) {
        const host = m[1] ?? m[2]!;
        if (!thirdPartyAssets.some((a) => a.host === host)) thirdPartyAssets.push({ host, evidence: { path, line: lineAt(f.text, m.index!) } });
      }
    }
    frontend = { basename, devServer, apiClient, thirdPartyAssets };
  }

  // ---- Reverse proxy (Caddy or nginx config in the repository)
  let reverseProxy: RuntimeFacts["reverseProxy"] = null;
  const proxyFile = [...ctx.src.files].find(([p]) => /(^|\/)(Caddyfile|nginx\.conf|[\w.-]*nginx[\w.-]*\.conf)$/.test(p));
  if (proxyFile) {
    const [path, f] = proxyFile;
    const body = f.text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const caddy = /Caddyfile/.test(path);
    reverseProxy = {
      file: path,
      sites: caddy ? [...body.matchAll(/^(\S[^{\n]*?)\s*\{\s*$/gm)].map((m) => m[1]!.trim()).filter((s) => !s.startsWith("(")) : [...body.matchAll(/server_name\s+([^;]+);/g)].map((m) => m[1]!.trim()),
      upstreams: caddy ? [...body.matchAll(/reverse_proxy\s+([^\s{]+)/g)].map((m) => m[1]!) : [...body.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]!.trim()),
      directives: [...new Set([...body.matchAll(/^\s+([a-z_]+)\b/gm)].map((m) => m[1]!))],
    };
  }

  return { uploads, session, limits, outboundCalls, errorHandling: { globalHandler: Boolean(eh), evidence: eh ? [eh] : [] }, reverseProxy, agentInstructionFiles, supplyChain: { images, installs, ci }, frontend };
}
