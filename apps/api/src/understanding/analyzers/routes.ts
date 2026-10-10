import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { EndpointControl, EntryPoint, Evidence, Screen } from "@cybercheck/contracts";
import { line, stringValue, walk, type Parsed } from "../parse.ts";
import type { Ctx } from "./context.ts";
import { importsOf, type Resolver } from "./structure.ts";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL", "ANY", "ACTION"]);

/** Names that indicate an authentication/authorization check. */
const AUTH_NAME = /(auth|protect|guard|session|jwt|token|login|logged|require[_]?user|current[_]?user|verify|ensure|permission|role|admin|isAuthenticated|is_authenticated|passport|clerk|signed[_]?in|bearer|apikey|api_key)/i;
/** Middleware that sets something up (sessions, parsing, CORS) rather than rejecting callers. */
const SETUP_MIDDLEWARE = /^(session|expressSession|cookieSession|ironSession|passport\.(initialize|session)|cors|helmet|compression|morgan|express\.(json|urlencoded|static|raw|text)|bodyParser\.\w+|cookieParser|fastifyCookie|secureSession)$/;
/** Names that look like auth but mean "public". */
const PUBLIC_NAME = /(public|allow[_]?any|anonymous|optional[_]?auth|skip[_]?auth)/i;
/** Calls inside a handler body that check the caller. */
const AUTH_CALL = /\b(auth\(\)|getServerSession\(|getSession\(|currentUser\(|getUser\(|getToken\(|auth\.api\.getSession\(|requireUser\(|requireAuth\(|verifyToken\(|verifyJwt\(|jwt\.verify\(|clerkClient|getAuth\(|supabase\.auth\.getUser\(|req\.user\b|request\.user\b|ctx\.state\.user\b|session\.user\b|validateRequest\()/;

const SERVER_IMPORTS = /^(express|fastify|hono|koa|@koa\/router|koa-router|elysia|restify|@hapi\/hapi|polka|h3)$/;
const SERVER_FACTORY = /^(express|fastify|Fastify|Router|express\.Router|Hono|Elysia|Koa|KoaRouter|createApp|createRouter|polka)$/;
const SERVER_VAR = /^(app|router|server|fastify|instance|api|r|routes?|v1|admin)$/i;

/** Guard detection result from framework-specific code (before the final control classification). */
type Guard = { status: "required" | "none_found" | "unknown" | "public"; via: string[]; evidence: Evidence[]; reason?: string };

type RouteDraft = Omit<EntryPoint, "id" | "status" | "control" | "inputs" | "sideEffects"> & {
  auth: Guard;
  /** Handler source, used to recognise checks made inside the handler. */
  handlerText: string;
};

function ev(p: Parsed, n: Node): Evidence {
  return { path: p.path, line: line(n), endLine: n.endPosition.row + 1 };
}

function joinPath(prefix: string, path: string) {
  const joined = `/${[prefix, path].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
  return joined === "/" ? "/" : joined;
}

function nameOf(n: Node | null | undefined): string {
  if (!n) return "";
  if (n.type === "call_expression") return nameOf(n.childForFieldName("function"));
  if (n.type === "call") return nameOf(n.childForFieldName("function"));
  return n.text.slice(0, 80);
}

/** What import specifier each local name comes from (for following router mounts across files). */
function bindings(p: Parsed): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of importsOf(p)) for (const n of imp.names) out.set(n, imp.spec);
  // const x = require("./y")
  for (const n of walk(p.tree.rootNode)) {
    if (n.type === "variable_declarator") {
      const v = n.childForFieldName("value");
      const id = n.childForFieldName("name");
      if (id?.type === "identifier" && v?.type === "call_expression" && v.childForFieldName("function")?.text === "require") {
        const s = stringValue(v.childForFieldName("arguments")?.namedChildren[0]);
        if (s) out.set(id.text, s);
      }
    }
  }
  return out;
}

// ---------------- JavaScript / TypeScript servers ----------------

function serverVars(p: Parsed, importsServer: boolean): Set<string> {
  const vars = new Set<string>();
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "variable_declarator") continue;
    const id = n.childForFieldName("name");
    let v = n.childForFieldName("value");
    if (v?.type === "await_expression") v = v.namedChildren[0] ?? null;
    if (!id || id.type !== "identifier" || !v) continue;
    const callee = v.type === "call_expression" ? v.childForFieldName("function")?.text : v.type === "new_expression" ? v.childForFieldName("constructor")?.text : null;
    if (callee && SERVER_FACTORY.test(callee)) vars.add(id.text);
  }
  if (importsServer) {
    // Fastify plugins and route modules receive the server as a parameter.
    for (const n of walk(p.tree.rootNode)) {
      if (n.type === "required_parameter" || n.type === "identifier") {
        const t = n.type === "identifier" ? n.text : n.childForFieldName("pattern")?.text ?? "";
        if (n.parent?.type === "formal_parameters" || n.type === "required_parameter") if (SERVER_VAR.test(t)) vars.add(t);
      }
    }
    for (const v of ["app", "router", "server", "fastify"]) vars.add(v);
  }
  return vars;
}

type Mount = { prefix: string; spec: string; from: string };

function jsMounts(p: Parsed, binds: Map<string, string>): Mount[] {
  const mounts: Mount[] = [];
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression") continue;
    const fn = n.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const prop = fn.childForFieldName("property")?.text;
    const args = n.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[] | undefined;
    if (!args?.length) continue;
    if (prop === "use" || prop === "route") {
      // app.use("/api", router) / app.route("/api", subApp) (Hono)
      const prefix = stringValue(args[0]);
      const target = args[1];
      if (prefix && target?.type === "identifier" && binds.has(target.text)) mounts.push({ prefix, spec: binds.get(target.text)!, from: p.path });
    } else if (prop === "register") {
      // fastify.register(routes, { prefix: "/v1" })
      const target = args[0];
      const opts = args[1];
      if (target?.type === "identifier" && binds.has(target.text) && opts?.type === "object") {
        for (const pair of opts.namedChildren) {
          if (pair?.type === "pair" && pair.childForFieldName("key")?.text.replace(/['"]/g, "") === "prefix") {
            const prefix = stringValue(pair.childForFieldName("value"));
            if (prefix) mounts.push({ prefix, spec: binds.get(target.text)!, from: p.path });
          }
        }
      }
    }
  }
  return mounts;
}

function handlerHasAuthCall(n: Node | undefined) {
  return Boolean(n && /function|arrow_function/.test(n.type) && AUTH_CALL.test(n.text));
}

function classifyMiddleware(names: string[]): { status: Guard["status"]; via: string[] } | null {
  const pub = names.filter((x) => PUBLIC_NAME.test(x));
  if (pub.length) return { status: "public", via: pub };
  const auth = names.filter((x) => AUTH_NAME.test(x));
  return auth.length ? { status: "required", via: auth } : null;
}

/** Screens before the router basename and the endpoints they call are known. */
type ScreenDraft = Omit<Screen, "url" | "endpoints">;

type FileGuard = { line: number; name: string; how: string };

function jsServerRoutes(p: Parsed, vars: Set<string>, fileGuards: FileGuard[]): RouteDraft[] {
  const out: RouteDraft[] = [];
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression") continue;
    const fn = n.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text?.toLowerCase() ?? "";
    const args = (n.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [];

    let path: string | null = null;
    let methods: string[] = [];
    let middleware: Node[] = [];
    let handler: Node | undefined;
    let schema: string | null = null;

    // router.route("/x").get(handler)
    if (HTTP_METHODS.has(prop) && obj?.type === "call_expression" && obj.childForFieldName("function")?.text.endsWith(".route")) {
      const base = obj.childForFieldName("function")?.childForFieldName("object")?.text ?? "";
      if (!vars.has(base)) continue;
      path = stringValue(obj.childForFieldName("arguments")?.namedChildren[0]);
      methods = [prop.toUpperCase()];
      middleware = args.slice(0, -1);
      handler = args.at(-1);
    } else if (HTTP_METHODS.has(prop) && obj?.type === "identifier" && vars.has(obj.text)) {
      path = stringValue(args[0]);
      if (!path || !(path.startsWith("/") || path === "*")) continue;
      methods = [prop.toUpperCase()];
      const rest = args.slice(1);
      // fastify: app.get("/x", { preHandler: [...], schema: {...} }, handler)
      if (rest[0]?.type === "object") {
        for (const pair of rest[0].namedChildren) {
          const key = pair?.childForFieldName("key")?.text.replace(/['"]/g, "");
          const val = pair?.childForFieldName("value");
          if (!key || !val) continue;
          if (/^(preHandler|onRequest|preValidation|beforeHandler)$/.test(key)) middleware.push(...(val.type === "array" ? (val.namedChildren.filter(Boolean) as Node[]) : [val]));
          if (key === "schema") schema = "schema" + (val.text.includes("body") ? " (body)" : "");
        }
        middleware.push(...rest.slice(1, -1));
      } else middleware = rest.slice(0, -1);
      handler = rest.at(-1);
    } else if (prop === "route" && obj?.type === "identifier" && vars.has(obj.text) && args[0]?.type === "object") {
      // fastify.route({ method: "GET", url: "/x", handler, preHandler })
      for (const pair of args[0].namedChildren) {
        const key = pair?.childForFieldName("key")?.text.replace(/['"]/g, "");
        const val = pair?.childForFieldName("value");
        if (!key || !val) continue;
        if (key === "url" || key === "path") path = stringValue(val);
        if (key === "method") methods = val.type === "array" ? val.namedChildren.map((c) => stringValue(c) ?? "").filter(Boolean) : [stringValue(val) ?? "GET"];
        if (/^(preHandler|onRequest|preValidation)$/.test(key)) middleware.push(...(val.type === "array" ? (val.namedChildren.filter(Boolean) as Node[]) : [val]));
        if (key === "handler") handler = val;
        if (key === "schema") schema = "schema";
      }
      if (!path) continue;
    } else continue;

    if (!path) continue;
    const names = middleware.map(nameOf).filter((x) => x && !SETUP_MIDDLEWARE.test(x));
    const mw = classifyMiddleware(names);
    let auth: Guard | null = mw ? { ...mw, evidence: [ev(p, n)], reason: `${mw.via.join(", ")} runs before the handler (route options)` } : null;
    if (!auth && handlerHasAuthCall(handler)) auth = { status: "required", via: ["session check in handler"], evidence: [ev(p, n)], reason: "The handler checks the signed-in user before doing anything else" };
    if (!auth) {
      const guard = fileGuards.filter((g) => g.line < line(n)).at(-1);
      if (guard) auth = { status: "required", via: [guard.name], evidence: [{ path: p.path, line: guard.line }], reason: `${guard.name} ${guard.how}` };
    }
    if (!schema && handler) {
      const m = handler.text.match(/\b([A-Z][\w]*(?:Schema|Input|Dto|Body|Request)?)\.(?:parse|safeParse|parseAsync|validate)\(\s*(?:req|request|ctx)\.(?:body|query|params)/);
      if (m) schema = m[1]!;
    }
    for (const method of methods.map((m) => m.toUpperCase())) {
      out.push({
        kind: /webhook/i.test(path) ? "webhook" : "http",
        method,
        path,
        framework: "node-http",
        handler: ev(p, n),
        auth: auth ?? { status: "none_found", via: [], evidence: [] },
        handlerText: handler?.text ?? n.text,
        requestSchema: schema,
        mutates: MUTATING.has(method),
      });
    }
  }
  return out;
}

/** router.use(requireAuth) / app.addHook("preHandler", requireAuth): applies to routes registered after it in the file. */
function jsFileGuards(p: Parsed, vars: Set<string>): FileGuard[] {
  const out: FileGuard[] = [];
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression") continue;
    const fn = n.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object")?.text ?? "";
    const prop = fn.childForFieldName("property")?.text;
    if (!vars.has(obj) || !(prop === "use" || prop === "addHook")) continue;
    const args = (n.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [];
    const names = args.filter((a) => a.type !== "string").map(nameOf).filter((x) => !SETUP_MIDDLEWARE.test(x));
    const hit = names.find((x) => AUTH_NAME.test(x) && !PUBLIC_NAME.test(x));
    if (hit && !(args[0] && stringValue(args[0]) && args.length === 2 && args[1]?.type === "identifier" && !AUTH_NAME.test(args[1].text))) {
      const how = prop === "addHook" ? `is registered as a ${stringValue(args[0]) ?? "request"} hook for every route in this file (line ${line(n)})` : `is applied with ${obj}.use() to every route registered after line ${line(n)}`;
      out.push({ line: line(n), name: hit, how });
    }
  }
  return out;
}

// ---------------- NestJS ----------------

function decoratorCall(d: Node): { name: string; args: Node[] } | null {
  const expr = d.namedChildren[0];
  if (!expr) return null;
  if (expr.type === "call_expression") return { name: expr.childForFieldName("function")?.text ?? "", args: (expr.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [] };
  return { name: expr.text, args: [] };
}

function nestRoutes(p: Parsed): RouteDraft[] {
  const out: RouteDraft[] = [];
  for (const cls of walk(p.tree.rootNode)) {
    if (cls.type !== "class_declaration") continue;
    const decos = cls.children.filter((c) => c?.type === "decorator") as Node[];
    const prevDecos: Node[] = [];
    // Decorators may also be siblings before the class (export + decorators).
    let s = cls.previousNamedSibling;
    while (s?.type === "decorator") {
      prevDecos.push(s);
      s = s.previousNamedSibling;
    }
    const parentDecos = cls.parent?.type === "export_statement" ? (cls.parent.children.filter((c) => c?.type === "decorator") as Node[]) : [];
    const all = [...decos, ...prevDecos, ...parentDecos].map(decoratorCall).filter(Boolean) as Array<{ name: string; args: Node[] }>;
    const ctrl = all.find((d) => d.name === "Controller");
    if (!ctrl) continue;
    const prefix = stringValue(ctrl.args[0]) ?? "";
    const classGuard = all.filter((d) => d.name === "UseGuards").flatMap((d) => d.args.map((a) => a.text));
    const classPublic = all.some((d) => PUBLIC_NAME.test(d.name));
    const body = cls.childForFieldName("body");
    if (!body) continue;
    let pending: Array<{ name: string; args: Node[] }> = [];
    for (const m of body.namedChildren) {
      if (!m) continue;
      if (m.type === "decorator") {
        const d = decoratorCall(m);
        if (d) pending.push(d);
        continue;
      }
      if (m.type !== "method_definition") {
        pending = [];
        continue;
      }
      const own = [...pending, ...((m.children.filter((c) => c?.type === "decorator") as Node[]).map(decoratorCall).filter(Boolean) as Array<{ name: string; args: Node[] }>)];
      pending = [];
      const verb = own.find((d) => /^(Get|Post|Put|Patch|Delete|All|Options|Head)$/.test(d.name));
      if (!verb) continue;
      const guards = [...classGuard, ...own.filter((d) => d.name === "UseGuards").flatMap((d) => d.args.map((a) => a.text))];
      const isPublic = classPublic || own.some((d) => PUBLIC_NAME.test(d.name));
      const bodyParam = m.text.match(/@Body\(\)\s*\w+\s*:\s*([A-Z]\w*)/);
      const method = verb.name.toUpperCase();
      out.push({
        kind: "http",
        method,
        path: joinPath(prefix, stringValue(verb.args[0]) ?? ""),
        framework: "nestjs",
        handler: ev(p, m),
        auth: isPublic
          ? { status: "public", via: ["@Public"], evidence: [ev(p, m)], reason: "Marked public with a @Public decorator" }
          : guards.length
            ? { status: "required", via: guards, evidence: [ev(p, m)], reason: `${guards.join(", ")} guard on the controller or method` }
            : { status: "unknown", via: [], evidence: [], reason: "No guard on this controller; a global guard registered elsewhere may apply" },
        handlerText: m.text,
        requestSchema: bodyParam?.[1] ?? null,
        mutates: MUTATING.has(method),
      });
    }
  }
  return out;
}

// ---------------- Next.js ----------------

function nextSegments(path: string, marker: "app" | "pages"): string | null {
  const m = path.match(marker === "app" ? /(?:^|\/)app\/(.*)$/ : /(?:^|\/)pages\/(.*)$/);
  if (!m) return null;
  const rest = m[1]!.split("/").slice(0, -1);
  const segs = rest
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@") && !s.startsWith("_"))
    .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]\]?$/, "*$1").replace(/^\[(\w+)\]$/, ":$1"));
  return `/${segs.join("/")}`.replace(/\/+$/, "") || "/";
}

function nextMiddlewareGuard(ctx: Ctx): { file: string; matchers: string[]; auth: boolean } | null {
  for (const [path, f] of ctx.src.files) {
    if (!/^(src\/)?(middleware|proxy)\.(ts|js)$/.test(path)) continue;
    const matchers = [...f.text.matchAll(/["'](\/[^"']*)["']/g)].map((m) => m[1]!).filter((s) => !s.includes("_next"));
    return { file: path, matchers, auth: AUTH_CALL.test(f.text) || /auth|session|token|cookie/i.test(f.text) };
  }
  return null;
}

function matcherCovers(matchers: string[], route: string) {
  if (!matchers.length) return true;
  return matchers.some((m) => {
    const base = m.replace(/\/?:path\*.*$|\/?\(.*\)$|\*.*$/, "");
    return route === base || route.startsWith(base.endsWith("/") ? base : `${base}/`) || base === "";
  });
}

function nextRoutes(ctx: Ctx, p: Parsed, mw: ReturnType<typeof nextMiddlewareGuard>, screens: ScreenDraft[]): RouteDraft[] {
  const out: RouteDraft[] = [];
  const authVia = (route: string, bodyText: string, at: Evidence): Guard => {
    if (AUTH_CALL.test(bodyText)) return { status: "required", via: ["session check in handler"], evidence: [at], reason: "The handler checks the signed-in user" };
    if (mw?.auth && matcherCovers(mw.matchers, route)) return { status: "required", via: [mw.file], evidence: [{ path: mw.file, line: 1 }], reason: `${mw.file} checks the session for this path` };
    return { status: "none_found", via: [], evidence: [] };
  };

  if (/(^|\/)app\/(.*\/)?route\.(ts|js|tsx|jsx)$/.test(p.path)) {
    const route = nextSegments(p.path, "app") ?? "/";
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "export_statement") continue;
      const decl = n.childForFieldName("declaration") ?? n.namedChildren[0];
      let name: string | undefined;
      if (decl?.type === "function_declaration") name = decl.childForFieldName("name")?.text;
      if (decl?.type === "lexical_declaration") name = decl.namedChildren[0]?.childForFieldName("name")?.text;
      if (!name || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(name)) continue;
      const schema = n.text.match(/\b([A-Z]\w*)\.(?:parse|safeParse)\(/)?.[1] ?? null;
      out.push({ kind: /webhook/i.test(route) ? "webhook" : "http", method: name, path: route, framework: "nextjs", handler: ev(p, n), auth: authVia(route, n.text, ev(p, n)), handlerText: n.text, requestSchema: schema, mutates: MUTATING.has(name) });
    }
  } else if (/(^|\/)pages\/api\/.+\.(ts|js|tsx|jsx)$/.test(p.path)) {
    const route = `/api${(nextSegments(p.path.replace(/(^|\/)pages\/api\//, "$1pages/"), "pages") ?? "").replace(/^\/$/, "")}${p.path.endsWith("index.ts") || p.path.endsWith("index.js") ? "" : "/" + posix.basename(p.path).replace(/\.\w+$/, "").replace(/^\[(\w+)\]$/, ":$1")}`;
    const methods = [...new Set([...p.text.matchAll(/method\s*===?\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g)].map((m) => m[1]!))];
    for (const method of methods.length ? methods : ["ANY"]) {
      out.push({ kind: /webhook/i.test(route) ? "webhook" : "http", method, path: route, framework: "nextjs", handler: { path: p.path, line: 1 }, auth: authVia(route, p.text, { path: p.path, line: 1 }), handlerText: p.text, requestSchema: null, mutates: MUTATING.has(method) });
    }
  } else if (/(^|\/)app\/(.*\/)?page\.(tsx|jsx|ts|js|mdx)$/.test(p.path)) {
    screens.push({ route: nextSegments(p.path, "app") ?? "/", file: p.path, framework: "nextjs", forms: (p.text.match(/<form\b/g) ?? []).length, interactions: interactionsOf(p.text) });
  } else if (/(^|\/)pages\/(?!api\/)(?!_)[^]*\.(tsx|jsx)$/.test(p.path)) {
    const base = posix.basename(p.path).replace(/\.\w+$/, "");
    const seg = nextSegments(p.path, "pages") ?? "";
    const route = base === "index" ? seg || "/" : `${seg === "/" ? "" : seg}/${base.replace(/^\[(\w+)\]$/, ":$1")}`;
    screens.push({ route, file: p.path, framework: "nextjs", forms: (p.text.match(/<form\b/g) ?? []).length, interactions: interactionsOf(p.text) });
  }

  // Server actions: exported async functions in "use server" files are callable POST endpoints.
  if (/^\s*["']use server["']/.test(p.text)) {
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "export_statement") continue;
      const decl = n.childForFieldName("declaration");
      const name = decl?.type === "function_declaration" ? decl.childForFieldName("name")?.text : undefined;
      if (!name) continue;
      out.push({ kind: "http", method: "ACTION", path: `server action ${name}()`, framework: "nextjs", handler: ev(p, n), auth: authVia("/", n.text, ev(p, n)), handlerText: n.text, requestSchema: null, mutates: true });
    }
  }
  void ctx;
  return out;
}

/** JSX attribute value by name on an element (opening or self-closing). */
function jsxAttr(el: Node, name: string): Node | null | "flag" {
  for (const a of el.namedChildren) {
    if (a?.type !== "jsx_attribute") continue;
    if (a.namedChildren[0]?.text !== name) continue;
    return a.namedChildren[1] ?? "flag";
  }
  return null;
}

function jsxOpening(n: Node): Node | null {
  if (n.type === "jsx_self_closing_element") return n;
  if (n.type === "jsx_element") return n.childForFieldName("open_tag") ?? n.namedChildren[0] ?? null;
  return null;
}

/** First component name rendered by an element={<X />} or component={X} value. */
function componentName(v: Node | null | "flag"): string | null {
  if (!v || v === "flag") return null;
  const m = v.text.match(/<\s*([A-Z][\w.]*)/) ?? v.text.match(/^\{?\s*([A-Z][\w.]*)\s*\}?$/);
  return m?.[1] ?? null;
}

function joinRoute(parts: string[]) {
  const segs = parts.flatMap((x) => x.split("/")).filter(Boolean);
  return `/${segs.join("/")}`;
}

function reactRouterScreens(ctx: Ctx, p: Parsed, screens: ScreenDraft[], binds: Map<string, string>, resolver: Resolver) {
  if (!/react-router|@tanstack\/react-router|vue-router/.test(p.text)) return;
  const framework = /vue-router/.test(p.text) ? "vue-router" : "react-router";
  const fileOf = (component: string | null) => {
    if (!component) return p.path;
    const spec = binds.get(component.split(".")[0]!);
    return (spec && resolver.resolve(p.path, spec, false)) || p.path;
  };
  const push = (route: string, component: string | null) => {
    if (route.includes("*")) return; // catch-all redirects are not screens
    const file = fileOf(component);
    const text = ctx.src.files.get(file)?.text ?? "";
    screens.push({ route, file, framework, forms: (text.match(/<form\b/g) ?? []).length, interactions: interactionsOf(file === p.path ? "" : text) });
  };

  for (const n of walk(p.tree.rootNode)) {
    // <Route path="chats/:id" element={<Chat />} /> nested inside <Route path="/" ...>
    const open = jsxOpening(n);
    if (open && /^Route$/.test(open.childForFieldName("name")?.text ?? open.namedChildren[0]?.text ?? "")) {
      const pathV = jsxAttr(open, "path");
      const isIndex = jsxAttr(open, "index") !== null;
      if (!pathV && !isIndex) continue;
      // A route with child routes is a layout (shell, guard); its children are the screens.
      if (n.type === "jsx_element" && n.namedChildren.some((c) => c && c !== open && /<\s*Route\b/.test(c.text))) continue;
      const parts: string[] = [];
      for (let a = n.parent; a; a = a.parent) {
        const o = jsxOpening(a);
        if (!o) continue;
        const pv = jsxAttr(o, "path");
        const s = pv && pv !== "flag" ? stringValue(pv.type === "jsx_expression" ? pv.namedChildren[0] : pv) ?? pv.text.replace(/^["']|["']$/g, "") : null;
        if (s) parts.unshift(s);
      }
      const own = pathV && pathV !== "flag" ? stringValue(pathV.type === "jsx_expression" ? pathV.namedChildren[0] : pathV) ?? pathV.text.replace(/^["']|["']$/g, "") : "";
      push(joinRoute([...parts, own]), componentName(jsxAttr(open, "element")) ?? componentName(jsxAttr(open, "component")));
      continue;
    }
    // createBrowserRouter([{ path: "/", children: [{ path: "chats", element: <Chat /> }] }])
    const keyOf = (c: Node | null) => (c?.type === "pair" ? c.childForFieldName("key")?.text.replace(/['"]/g, "") : undefined);
    if (n.type === "object" && n.namedChildren.some((c) => keyOf(c) === "path" || (keyOf(c) === "index" && /true/.test(c!.text)))) {
      const val = (o: Node, key: string) => o.namedChildren.find((c) => keyOf(c) === key)?.childForFieldName("value") ?? null;
      if (val(n, "children")) continue; // layout route
      const own = val(n, "index")?.text === "true" ? "" : stringValue(val(n, "path"));
      if (own == null || (own && !own.startsWith("/") && !/^[\w:.-]+(\/[\w:.-]+)*$/.test(own))) continue;
      const parts: string[] = [];
      for (let a = n.parent; a; a = a.parent) if (a.type === "object") {
        const s = stringValue(val(a, "path"));
        if (s) parts.unshift(s);
      }
      const comp = val(n, "element") ?? val(n, "component");
      push(joinRoute([...parts, own]), comp ? componentName(comp) : null);
    }
  }
}

// ---------------- Python ----------------

function pyCallName(n: Node | null | undefined) {
  if (!n) return "";
  return n.type === "call" ? (n.childForFieldName("function")?.text ?? "") : n.text;
}

function pyKwarg(call: Node, name: string): Node | null {
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a?.type === "keyword_argument" && a.childForFieldName("name")?.text === name) return a.childForFieldName("value");
  }
  return null;
}

function pyString(n: Node | null | undefined): string | null {
  if (!n || n.type !== "string") return null;
  if (n.namedChildren.some((c) => c?.type === "interpolation")) return null;
  return n.namedChildren.filter((c) => c?.type === "string_content").map((c) => c!.text).join("");
}

const PY_AUTH_DEP = /Depends\(\s*([\w.]*(?:auth|user|token|jwt|current|verify|login|permission|admin|role|security|api_key)[\w.]*)/i;
const PY_AUTH_DECORATOR = /^(login_required|jwt_required|auth_required|requires_auth|permission_required|roles_required|staff_member_required|user_passes_test|[\w.]*login_required|[\w.]*auth\.login_required|[\w.]*\.require\w*)$/;

type PyRouter = { prefix: string; deps: boolean };

function pyRouterVars(p: Parsed) {
  const vars = new Map<string, PyRouter & { kind: "fastapi" | "flask" }>();
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "assignment") continue;
    const left = n.childForFieldName("left");
    const right = n.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const fn = pyCallName(right);
    if (/(^|\.)(FastAPI|APIRouter)$/.test(fn)) {
      vars.set(left.text, { kind: "fastapi", prefix: pyString(pyKwarg(right, "prefix")) ?? "", deps: PY_AUTH_DEP.test(pyKwarg(right, "dependencies")?.text ?? "") });
    } else if (/(^|\.)(Flask|Blueprint)$/.test(fn)) {
      vars.set(left.text, { kind: "flask", prefix: pyString(pyKwarg(right, "url_prefix")) ?? "", deps: false });
    }
  }
  return vars;
}

function pyMounts(p: Parsed, binds: Map<string, string>): Mount[] {
  const out: Mount[] = [];
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call") continue;
    const fn = pyCallName(n);
    if (!/\.(include_router|register_blueprint)$/.test(fn)) continue;
    const target = n.childForFieldName("arguments")?.namedChildren[0];
    const prefix = pyString(pyKwarg(n, "prefix")) ?? pyString(pyKwarg(n, "url_prefix"));
    const base = target?.type === "attribute" ? target.childForFieldName("object")?.text : target?.text;
    if (prefix && base && binds.has(base)) out.push({ prefix, spec: binds.get(base)!, from: p.path });
  }
  return out;
}

function pyRoutes(p: Parsed): RouteDraft[] {
  const out: RouteDraft[] = [];
  const routers = pyRouterVars(p);
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "decorated_definition") continue;
    const def = n.childForFieldName("definition");
    if (def?.type !== "function_definition") continue;
    const decos = n.namedChildren.filter((c) => c?.type === "decorator") as Node[];
    const decoNames = decos.map((d) => pyCallName(d.namedChildren[0]));
    for (const d of decos) {
      const call = d.namedChildren[0];
      if (call?.type !== "call") continue;
      const fn = call.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const obj = fn.childForFieldName("object")?.text ?? "";
      const attr = fn.childForFieldName("attribute")?.text ?? "";
      const router = routers.get(obj);
      if (!router && !/^(app|router|api|bp|blueprint|\w+_bp|\w+_router)$/.test(obj)) continue;
      const pathArg = pyString(call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type === "string"));
      if (pathArg == null) continue;
      let methods: string[];
      if (attr === "route" || attr === "api_route") {
        const m = pyKwarg(call, "methods");
        methods = m ? [...m.text.matchAll(/["'](\w+)["']/g)].map((x) => x[1]!.toUpperCase()) : ["GET"];
      } else if (HTTP_METHODS.has(attr)) methods = [attr.toUpperCase()];
      else if (attr === "websocket") methods = ["WS"];
      else continue;

      const params = def.childForFieldName("parameters")?.text ?? "";
      const decoDeps = pyKwarg(call, "dependencies")?.text ?? "";
      const depMatch = params.match(PY_AUTH_DEP) ?? decoDeps.match(PY_AUTH_DEP);
      const decoAuth = decoNames.find((x) => PY_AUTH_DECORATOR.test(x));
      const via = [depMatch?.[1], decoAuth, router?.deps ? "router dependencies" : undefined].filter(Boolean) as string[];
      const body = params.match(/\w+\s*:\s*([A-Z]\w*)(?:\s*[,)=])/);
      const kind = router?.kind ?? (decoNames.some((x) => x.endsWith(".route")) ? "flask" : "fastapi");
      for (const method of methods) {
        out.push({
          kind: /webhook/i.test(pathArg) ? "webhook" : "http",
          method,
          path: joinPath(router?.prefix ?? "", pathArg),
          framework: kind,
          handler: ev(p, n),
          auth: via.length ? { status: "required", via, evidence: [ev(p, n)], reason: `${via.join(", ")} runs before the handler` } : { status: "none_found", via: [], evidence: [] },
          handlerText: n.text,
          requestSchema: body && !/^(Request|Response|Session|AsyncSession|BackgroundTasks|UploadFile)$/.test(body[1]!) ? body[1]! : null,
          mutates: MUTATING.has(method),
        });
      }
    }
  }
  return out;
}

/** Django urls.py: path("x/", view) with include() prefixes; DRF router.register. */
function djangoRoutes(ctx: Ctx, resolver: Resolver): RouteDraft[] {
  const out: RouteDraft[] = [];
  /** View name -> the check that protects it (IsAuthenticated, IsAdminUser, login_required, ...). */
  const authViews = new Map<string, string>();
  const publicViews = new Set<string>();
  for (const [path, p] of ctx.parsed) {
    if (p.lang !== "python" || !/views?/.test(path)) continue;
    for (const n of walk(p.tree.rootNode)) {
      if (n.type === "decorated_definition") {
        const name = n.childForFieldName("definition")?.childForFieldName("name")?.text;
        const decos = (n.namedChildren.filter((c) => c?.type === "decorator") as Node[]).map((d) => pyCallName(d.namedChildren[0]));
        const deco = decos.find((x) => PY_AUTH_DECORATOR.test(x));
        if (name && deco) authViews.set(name, deco);
      }
      if (n.type === "class_definition") {
        const name = n.childForFieldName("name")?.text;
        const t = n.text;
        if (!name) continue;
        const check = t.match(/permission_classes\s*=\s*[[(][^\])]*?(IsAdminUser|DjangoModelPermissions\w*|IsAuthenticated\w*)/)?.[1] ?? t.match(/(PermissionRequiredMixin|LoginRequiredMixin|UserPassesTestMixin)/)?.[1];
        if (check) authViews.set(name, check);
        if (/permission_classes\s*=\s*[[(][^\])]*AllowAny/.test(t)) publicViews.add(name);
      }
    }
  }
  const settingsAuth = [...ctx.src.files.entries()].some(([p, f]) => /settings[\w/]*\.py$/.test(p) && /DEFAULT_PERMISSION_CLASSES[\s\S]{0,200}IsAuthenticated/.test(f.text));

  const visit = (file: string, prefix: string, seen: Set<string>) => {
    if (seen.has(file)) return;
    seen.add(file);
    const p = ctx.parsed.get(file);
    if (!p) return;
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "call") continue;
      const fn = pyCallName(n);
      const args = (n.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [];
      if (/^(path|re_path|url)$/.test(fn)) {
        const route = pyString(args[0]);
        if (route == null) continue;
        const target = args[1];
        if (target?.type === "call" && pyCallName(target) === "include") {
          const mod = pyString(target.childForFieldName("arguments")?.namedChildren[0]);
          const sub = mod ? resolver.resolve(file, mod, true) : null;
          if (sub) visit(sub, joinPath(prefix, route), seen);
          continue;
        }
        const view = target?.text.replace(/\.as_view\(.*\)$/, "").split(".").at(-1) ?? "";
        out.push({
          kind: /webhook/i.test(route) ? "webhook" : "http",
          method: "ANY",
          path: joinPath(prefix, route.replace(/^\^|\$$/g, "").replace(/<(?:\w+:)?(\w+)>/g, ":$1")),
          framework: "django",
          handler: ev(p, n),
          auth: publicViews.has(view)
            ? { status: "public", via: ["AllowAny"], evidence: [], reason: `${view} sets permission_classes = [AllowAny]` }
            : authViews.has(view)
              ? { status: "required", via: [authViews.get(view)!], evidence: [], reason: `${view} uses ${authViews.get(view)}` }
              : settingsAuth
                ? { status: "required", via: ["DEFAULT_PERMISSION_CLASSES"], evidence: [], reason: "DEFAULT_PERMISSION_CLASSES requires authentication by default" }
                : { status: "none_found", via: [], evidence: [] },
          handlerText: "",
          requestSchema: null,
          mutates: true,
        });
      } else if (/\.register$/.test(fn) && args.length >= 2) {
        const route = pyString(args[0]);
        if (route == null) continue;
        const view = args[1]?.text ?? "";
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          out.push({
            kind: "http",
            method,
            path: joinPath(prefix, route.replace(/^r?\^?/, "")),
            framework: "django-rest-framework",
            handler: ev(p, n),
            auth: publicViews.has(view)
              ? { status: "public", via: ["AllowAny"], evidence: [], reason: `${view} sets permission_classes = [AllowAny]` }
              : authViews.has(view)
                ? { status: "required", via: [authViews.get(view)!], evidence: [], reason: `${view} sets permission_classes = [${authViews.get(view)}]` }
                : settingsAuth
                  ? { status: "required", via: ["DEFAULT_PERMISSION_CLASSES"], evidence: [], reason: "DEFAULT_PERMISSION_CLASSES requires authentication by default" }
                  : { status: "none_found", via: [], evidence: [] },
            handlerText: "",
            requestSchema: null,
            mutates: MUTATING.has(method),
          });
        }
      }
    }
  };
  const roots = [...ctx.parsed.keys()].filter((f) => /(^|\/)urls\.py$/.test(f)).sort((a, b) => a.split("/").length - b.split("/").length);
  const seen = new Set<string>();
  for (const r of roots) visit(r, "", seen);
  return out;
}

/** GraphQL operations from SDL files and gql/typeDefs strings. */
function graphqlEntryPoints(ctx: Ctx): RouteDraft[] {
  const out: RouteDraft[] = [];
  for (const [path, f] of ctx.src.files) {
    if (!/\.(graphql|gql)$/.test(path) && !/typeDefs|gql`/.test(f.text)) continue;
    for (const block of f.text.matchAll(/type\s+(Query|Mutation|Subscription)\s*\{([^}]*)\}/g)) {
      const startLine = f.text.slice(0, block.index).split("\n").length;
      for (const field of block[2]!.matchAll(/^\s*(\w+)\s*[(:]/gm)) {
        out.push({
          kind: "graphql",
          method: block[1]!.toUpperCase(),
          path: field[1]!,
          framework: "graphql",
          handler: { path, line: startLine },
          auth: { status: "unknown", via: [], evidence: [], reason: "Resolver-level checks are not analysed yet" },
          handlerText: "",
          requestSchema: null,
          mutates: block[1] === "Mutation",
        });
      }
    }
  }
  return out;
}

// ---------------- Control classification ----------------

/** Line inside the handler where a pattern first matches (falls back to the handler line). */
function lineOf(d: RouteDraft, re: RegExp): Evidence {
  const m = d.handlerText.match(re);
  if (!m || m.index === undefined) return { path: d.handler.path, line: d.handler.line };
  return { path: d.handler.path, line: d.handler.line + d.handlerText.slice(0, m.index).split("\n").length - 1 };
}

const SIGNATURE = /x-hub-signature|stripe-signature|constructEvent\(|createHmac\(|svix|verifySignature|verify_signature|x-signature|webhook[-_]?signature|x-slack-signature|x-github-event[\s\S]{0,200}hmac/i;
const STATE_CHECK = /(?:expected_?state|stored_?state|session[\s\S]{0,40}state)[\s\S]{0,120}(?:!==|===|!=|==)|state\s*(?:!==|===|!=|==)|state_mismatch|invalid_state|verify_?state/i;
const HEADER_CREDENTIAL = /headers\s*\[\s*["'](?:authorization|x-api-key|x-auth-token|api-key)["']\s*\]|headers\.(?:authorization|get\(\s*["'](?:authorization|x-api-key)["']\))|\bbearer\b|request\.headers\.get\(\s*["'](?:authorization|x-api-key)|\b(?:req|request|c\.req|ctx)\.(?:get|header)\(\s*["'](?:authorization|x-api-key|x-auth-token)["']|Header\(\s*(?:alias=)?["']?(?:authorization|x-api-key)|x_api_key/i;
const COMPARE = /timingSafeEqual|compare_digest|constantTime\w*|safeCompare|===|!==|==|!=/;
const REJECT = /\.code\(\s*40[13]\s*\)|\.status\(\s*40[13]\s*\)|status(?:_code)?\s*[:=]\s*40[13]|HTTPException\([^)]*40[13]|abort\(\s*40[13]|Unauthorized|Forbidden|PermissionDenied|NotAuthenticated/;
const QUERY_TOKEN = /(?:query|params|args)[\s\S]{0,40}(?:token|verify|secret|key)|verify_token/i;
/** Guards that check what the caller may do, not only who they are. */
const ROLE_NAME = /role|admin|staff|owner|superuser|permission_required|PermissionRequired|ModelPermissions|has_?permission|can[A-Z]\w+|requirePermission|checkPermission/;

/** Endpoints that must be reachable without a session for the product to work. */
function publicByDesign(d: RouteDraft): string | null {
  const p = d.path.toLowerCase();
  if (/(^|\/)(log-?in|sign-?in|sign-?up|register|signup|forgot[-_]?password|reset[-_]?password|verify[-_]?email|magic[-_]?link|otp|refresh)(\/|$)/.test(p)) return "Sign-in and account recovery endpoints must work before a session exists";
  if (/(^|\/)(log-?out|sign-?out)(\/|$)/.test(p)) return "Signing out only ends the caller's own session";
  if (d.method === "GET" && /(^|\/)(me|whoami|session)$/.test(p)) return "Reports whether the caller is signed in";
  if (d.method === "GET" && /(^|\/)(health|healthz|healthcheck|ready|readyz|live|livez|ping|status|version)$/.test(p)) return "Health and status checks are meant for load balancers and monitors";
  if (d.method === "GET" && /(^|\/)(privacy|privacy-policy|terms|tos|legal|cookies|data-deletion|imprint|about|robots\.txt|sitemap\.xml|favicon\.ico|\.well-known)(\/|$)/.test(p)) return "Public information page";
  if (d.method === "GET" && p === "/") return "Root or landing page";
  return null;
}

function classifyControl(d: RouteDraft, guardDefs: Map<string, Evidence>): EndpointControl {
  const withDefs = (names: string[], ev: Evidence[]) => [...ev, ...names.map((n) => guardDefs.get(n)).filter((x): x is Evidence => Boolean(x))];
  const isCallback = /(^|\/)(callback|oauth2?callback|redirect)(\/|$)/i.test(d.path);
  const isWebhook = d.kind === "webhook";

  if (d.auth.status === "public") return { kind: "public_intentional", reason: d.auth.reason ?? `Marked public (${d.auth.via.join(", ")})`, via: d.auth.via, evidence: d.auth.evidence };
  if (d.auth.status === "required") {
    const kind = d.auth.via.some((v) => ROLE_NAME.test(v)) ? "role_required" : "session_required";
    return { kind, reason: d.auth.reason ?? `${d.auth.via.join(", ")} runs before the handler`, via: d.auth.via, evidence: withDefs(d.auth.via, d.auth.evidence) };
  }

  // Checks made inside the handler itself.
  const h = d.handlerText;
  if (h) {
    if (SIGNATURE.test(h)) return { kind: "webhook_signature", reason: "The handler verifies the sender's signature", via: ["signature check in handler"], evidence: [lineOf(d, SIGNATURE)] };
    if (isCallback && STATE_CHECK.test(h)) return { kind: "callback_state", reason: "OAuth callback compares the returned state with the one stored in the session", via: ["state check in handler"], evidence: [lineOf(d, STATE_CHECK)] };
    if (HEADER_CREDENTIAL.test(h) && COMPARE.test(h) && REJECT.test(h)) {
      return { kind: "service_token", reason: "The handler compares a token from the request headers with a configured secret and rejects mismatches", via: ["header token check in handler"], evidence: [lineOf(d, HEADER_CREDENTIAL), lineOf(d, REJECT)] };
    }
    if (REJECT.test(h) && QUERY_TOKEN.test(h) && COMPARE.test(h)) {
      return { kind: "handler_check", reason: "The handler compares a token from the query string and rejects mismatches (for example a webhook verification handshake)", via: ["token check in handler"], evidence: [lineOf(d, QUERY_TOKEN), lineOf(d, REJECT)] };
    }
  }

  const pub = publicByDesign(d);
  if (pub && !isWebhook) return { kind: "public_intentional", reason: pub, via: [], evidence: [d.handler] };
  if (isCallback) return { kind: "none_found", reason: "OAuth callback with no state check found", via: [], evidence: [d.handler] };
  if (isWebhook) return { kind: "none_found", reason: "Webhook receiver with no signature verification found in the handler", via: [], evidence: [d.handler] };
  if (d.auth.status === "unknown") return { kind: "unknown", reason: d.auth.reason ?? "Could not be determined", via: [], evidence: d.auth.evidence };
  return { kind: "none_found", reason: "No guard, hook, decorator or check in the handler was found", via: [], evidence: [d.handler] };
}

/** Where guard functions like requireAuth are defined, so a control can cite the code that enforces it. */
function guardDefinitions(ctx: Ctx, names: Set<string>): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  if (!names.size) return out;
  for (const [path, p] of ctx.parsed) {
    for (const n of walk(p.tree.rootNode)) {
      let name: string | undefined;
      if (n.type === "function_declaration" || n.type === "function_definition") name = n.childForFieldName("name")?.text;
      else if (n.type === "variable_declarator" && /function|arrow_function/.test(n.childForFieldName("value")?.type ?? "")) name = n.childForFieldName("name")?.text;
      if (name && names.has(name) && !out.has(name)) out.set(name, { path, line: line(n), endLine: n.endPosition.row + 1 });
    }
  }
  return out;
}

// ---------------- Screen interactions ----------------

const FORM_LIBS: Array<[RegExp, string]> = [[/react-hook-form/, "react-hook-form"], [/formik/, "Formik"], [/@tanstack\/react-form/, "TanStack Form"], [/@conform-to\//, "Conform"], [/vee-validate/, "VeeValidate"]];

export function interactionsOf(text: string): Screen["interactions"] {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  return {
    inputs: count(/<(input|textarea|select|Input|Textarea|TextArea|Select|TextField|Checkbox|Switch|RadioGroup)\b/g),
    buttons: count(/<(button|Button)\b/g),
    submitHandlers: count(/\bonSubmit\s*=|\bhandleSubmit\b|@submit\b/g),
    mutations: count(/method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]|\b(?:axios|api|client|http)\.(post|put|patch|delete)\(|\buseMutation\(|\.mutate(?:Async)?\(/gi),
    formLibraries: FORM_LIBS.filter(([re]) => re.test(text)).map(([, n]) => n),
  };
}

// ---------------- Following code: what handlers do and what screens call ----------------

/** Function bodies by name across the parsed code. */
function functionIndex(ctx: Ctx): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string | undefined, text: string) => {
    if (!name || name.length < 4) return;
    out.set(name, [...(out.get(name) ?? []), text]);
  };
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path)) continue;
    for (const n of walk(p.tree.rootNode)) {
      if (n.type === "function_declaration" || n.type === "function_definition" || n.type === "method_definition") add(n.childForFieldName("name")?.text, n.text);
      else if (n.type === "variable_declarator" && /function|arrow_function/.test(n.childForFieldName("value")?.type ?? "")) add(n.childForFieldName("name")?.text, n.text);
    }
  }
  return out;
}

const CALL_STOP = /^(then|catch|finally|map|filter|forEach|reduce|find|some|every|push|join|split|slice|replace|trim|toString|parse|stringify|log|info|warn|error|debug|send|code|status|json|type|header|get|set|has|keys|values|entries|includes|startsWith|endsWith|test|match|exec|now|from|resolve|reject|assign|freeze|isArray|max|min|floor|ceil|round)$/;

/** Text of the code plus the functions it calls, `depth` levels deep (bounded). */
function reach(text: string, index: Map<string, string[]>, depth = 2): string {
  let all = text;
  let frontier = [text];
  const seen = new Set<string>();
  for (let d = 0; d < depth && all.length < 300_000; d++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const m of t.matchAll(/\b([A-Za-z_]\w{3,})\s*(?:<[^>()]*>)?\(/g)) {
        const name = m[1]!;
        if (seen.has(name) || CALL_STOP.test(name)) continue;
        seen.add(name);
        for (const body of index.get(name) ?? []) next.push(body);
      }
    }
    all += `\n${next.join("\n")}`;
    frontier = next;
  }
  return all;
}

const SIDE_EFFECTS: Array<[RegExp, string]> = [
  [/\.(run|exec)\(\s*["'`]?\s*(insert|update|delete|replace|create|alter|drop)|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\.(create|createMany|update|updateMany|upsert|delete|deleteMany|insert|insertOne|insertMany|updateOne|deleteOne)\(|\.save\(\)|session\.commit\(\)|\.objects\.(create|update|delete)/i, "writes database"],
  [/generateContent|chat\.completions|messages\.create\(\s*\{[\s\S]{0,200}model|responses\.create|generateText|streamText|openrouter\.ai|api\.openai\.com|api\.anthropic\.com|\.invoke\(/i, "calls AI provider"],
  [/graph\.facebook\.com|api\.telegram\.org|hooks\.slack\.com|api\.twilio\.com|sendWhatsApp\w*|send\w*WhatsApp/i, "sends message"],
  [/api\.resend\.com|resend\.emails|sendMail\(|sendgrid|mailgun|postmark|nodemailer/i, "sends email"],
  [/googleapis\.com\/calendar|calendar\.events\.(insert|patch|delete)/i, "changes calendar"],
  [/writeFile|createWriteStream|fs\.promises\.(writeFile|rename|unlink)|\bunlink\(|\brm\(\s*[^)]*recursive/i, "writes files"],
];

function inputsOf(text: string): EntryPoint["inputs"] {
  const part = (where: string) =>
    text.match(new RegExp(`\\b([A-Za-z_]\\w*)\\.(?:parse|safeParse|parseAsync|safeParseAsync|validate)\\(\\s*(?:req|request|ctx|c\\.req)\\.${where}\\b`))?.[1] ??
    text.match(new RegExp(`schema\\s*:\\s*\\{[^}]*\\b${where}\\s*:\\s*([A-Za-z_]\\w*)`))?.[1] ??
    null;
  return {
    params: part("params"),
    query: part("query"),
    body: part("body"),
    files: /\breq\.file\(|\breq\.files\(|request\.files|\.parts\(\)|saveRequestFiles|upload\.(single|array|fields)\(|UploadFile|await\s+request\.formData\(\)|multer\(/.test(text),
  };
}

const normPath = (p: string) =>
  p
    .replace(/([^/])\$\{[^}]*\}/g, "$1") // `/api/leads${query}`: a suffix, not a path segment
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/:[A-Za-z_]\w*/g, ":p")
    .replace(/\{[^}/]+\}/g, ":p")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "") || "/";


/**
 * API calls written in code that match known endpoints, as "METHOD /path" when the method is
 * visible (request("PATCH", `/api/x/${id}`), api.post("/x"), fetch("/x", { method: "POST" })), else "/path".
 */
function apiCallsIn(text: string, known: Map<string, string>, methodsOf: Map<string, string[]>): string[] {
  const out = new Set<string>();
  // Plain strings, plus template literals (which may contain quotes inside ${...}).
  for (const m of text.matchAll(/`(\/[^`]*)`|["'](\/[^"'\s]*)["']/g)) {
    const norm = normPath(m[1] ?? m[2]!);
    const hit = norm === "/" ? undefined : known.get(norm);
    if (!hit) continue;
    const before = text.slice(Math.max(0, m.index! - 240), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
    // The last .get/.post/... before the string, with nothing but a generic type and "(" in between.
    const calls = [...before.matchAll(/\.(get|post|put|patch|delete)\s*(?=[<(])/gi)];
    const last = calls.at(-1);
    const lastMethod = last && !/["'`]/.test(before.slice(last.index! + last[0].length)) && /\(\s*$/.test(before) ? last[1] : null;
    const method = (before.match(/["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*$/i)?.[1] ?? lastMethod ?? after.match(/^\s*,\s*\{[^}]*method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i)?.[1] ?? (/fetch\(\s*$/.test(before) ? "GET" : null))?.toUpperCase();
    const only = methodsOf.get(hit);
    const resolved = method ?? (only?.length === 1 ? only[0] : null); // the API defines a single method for this path
    out.add(resolved ? `${resolved} ${hit}` : hit);
  }
  return [...out];
}

/** Router basename for the frontend (react-router basename, Vite base, Next basePath). */
function basenameOf(ctx: Ctx): string | null {
  for (const [path, f] of ctx.src.files) {
    const m = f.text.match(/basename\s*[=:]\s*\{?\s*["'`](\/[^"'`]*)["'`]/) ?? (/(^|\/)next\.config\.\w+$/.test(path) ? f.text.match(/basePath\s*:\s*["'`](\/[^"'`]*)["'`]/) : null) ?? (/(^|\/)vite\.config\.\w+$/.test(path) ? f.text.match(/\bbase\s*:\s*["'`](\/[^"'`]*)["'`]/) : null);
    if (m) return m[1]!.replace(/\/+$/, "") || null;
  }
  return null;
}

/** A screen's component file plus the components and helpers it uses (frontend only, bounded). */
type Helper = { name: string; text: string; parts: Array<{ key: string; text: string }> | null };

function screenFiles(ctx: Ctx, resolver: Resolver, file: string): { files: string[]; helpers: Helper[] } {
  const files = new Set<string>([file]);
  const helpers = new Map<string, Helper>();
  let frontier = [file];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      const p = ctx.parsed.get(f);
      if (!p) continue;
      for (const imp of importsOf(p)) {
        const target = resolver.resolve(f, imp.spec, false);
        if (!target || files.has(target)) continue;
        if (/\.(tsx|jsx|vue|svelte)$/.test(target)) {
          files.add(target);
          next.push(target);
        } else {
          // Helper modules (API clients): only the imported functions, not the whole file.
          const t = ctx.parsed.get(target);
          if (!t) continue;
          for (const n of walk(t.tree.rootNode)) {
            const name = n.type === "function_declaration" ? n.childForFieldName("name")?.text : n.type === "variable_declarator" ? n.childForFieldName("name")?.text : undefined;
            if (!name || !imp.names.includes(name)) continue;
            // export const leadsApi = { list: () => ..., get: (id) => ... }: keep each method separately.
            let value = n.type === "variable_declarator" ? n.childForFieldName("value") : null;
            while (value && /^(as_expression|satisfies_expression)$/.test(value.type)) value = value.namedChildren[0] ?? null;
            const parts = value?.type === "object"
              ? value.namedChildren.filter((c): c is Node => Boolean(c) && (c!.type === "pair" || c!.type === "method_definition")).map((c) => ({ key: (c.childForFieldName("key") ?? c.childForFieldName("name"))?.text.replace(/['"]/g, "") ?? "", text: c.text }))
              : null;
            helpers.set(`${target}#${name}`, { name, text: n.text, parts });
          }
        }
      }
    }
    frontier = next;
  }
  return { files: [...files], helpers: [...helpers.values()] };
}

export function analyzeRoutes(ctx: Ctx, resolver: Resolver) {
  const drafts: Array<RouteDraft & { file: string }> = [];
  const screens: ScreenDraft[] = [];
  const mounts: Mount[] = [];
  const mw = nextMiddlewareGuard(ctx);

  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    if (p.lang === "python") {
      const binds = new Map<string, string>();
      for (const imp of importsOf(p)) {
        // "from pkg import mod" binds a submodule when pkg/mod.py exists, otherwise a name inside pkg.
        for (const n of imp.names) {
          const sub = `${imp.spec}.${n}`;
          binds.set(n, resolver.resolve(path, sub, true) ? sub : imp.spec);
        }
        binds.set(imp.spec.split(".").at(-1)!, imp.spec);
      }
      mounts.push(...pyMounts(p, binds));
      for (const r of pyRoutes(p)) drafts.push({ ...r, file: path });
      continue;
    }
    const binds = bindings(p);
    const importsServer = importsOf(p).some((i) => SERVER_IMPORTS.test(i.spec));
    const vars = serverVars(p, importsServer);
    mounts.push(...jsMounts(p, binds));
    if (importsServer || [...vars].length) {
      const guards = jsFileGuards(p, vars);
      for (const r of jsServerRoutes(p, vars, guards)) drafts.push({ ...r, framework: importsOf(p).find((i) => SERVER_IMPORTS.test(i.spec))?.spec ?? "node-http", file: path });
    }
    if (/@nestjs\//.test(p.text)) for (const r of nestRoutes(p)) drafts.push({ ...r, file: path });
    if (ctx.declared.has("next")) for (const r of nextRoutes(ctx, p, mw, screens)) drafts.push({ ...r, file: path });
    reactRouterScreens(ctx, p, screens, binds, resolver);
  }
  for (const r of djangoRoutes(ctx, resolver)) drafts.push({ ...r, file: r.handler.path });
  for (const r of graphqlEntryPoints(ctx)) drafts.push({ ...r, file: r.handler.path });

  // Apply mount prefixes (app.use("/api", router), include_router(prefix=...)), following chains.
  const prefixOf = new Map<string, string>();
  for (let pass = 0; pass < 4; pass++) {
    for (const m of mounts) {
      const python = m.from.endsWith(".py");
      const target = resolver.resolve(m.from, m.spec, python);
      if (!target) continue;
      const outer = prefixOf.get(m.from) ?? "";
      prefixOf.set(target, joinPath(outer, m.prefix));
    }
  }
  const guardDefs = guardDefinitions(ctx, new Set(drafts.flatMap((d) => d.auth.via)));
  const index = functionIndex(ctx);
  const seen = new Set<string>();
  const entryPoints: EntryPoint[] = [];
  for (const d of drafts) {
    const prefix = d.framework === "nextjs" || d.framework === "django" || d.framework === "graphql" ? "" : (prefixOf.get(d.file) ?? "");
    const path = d.kind === "graphql" || d.method === "ACTION" ? d.path : joinPath(prefix, d.path);
    const key = `${d.method} ${path} ${d.handler.path}:${d.handler.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const full = { ...d, path };
    const control = classifyControl(full, guardDefs);
    const { file: _file, auth: _auth, handlerText: _text, ...rest } = full;
    void _file;
    void _auth;
    void _text;
    const followed = reach(d.handlerText, index);
    const sideEffects = SIDE_EFFECTS.filter(([re]) => re.test(followed)).map(([, label]) => label);
    entryPoints.push({ ...rest, id: `endpoint:${d.method} ${path}`, status: control.kind === "unknown" ? "unresolved" : "observed", control, inputs: inputsOf(d.handlerText), sideEffects });
  }
  entryPoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  // Screens: full URL, endpoints called (directly, from child components, or via imported API helpers),
  // and interactions counted across the screen and its child components.
  const base = basenameOf(ctx) ?? "";
  const known = new Map(entryPoints.filter((e) => e.kind !== "page").map((e) => [normPath(e.path), e.path]));
  const methodsOf = new Map<string, string[]>();
  for (const e of entryPoints) methodsOf.set(e.path, [...(methodsOf.get(e.path) ?? []), e.method]);
  const unique = [...new Map(screens.map((s) => [`${s.route}|${s.file}`, s])).values()];
  const enriched: Screen[] = unique.map((s) => {
    const { files, helpers } = screenFiles(ctx, resolver, s.file);
    const text = files.map((f) => ctx.src.files.get(f)?.text ?? "").join("\n");
    const own = interactionsOf(text);
    // Only the helper functions (or helper object methods) this screen actually calls.
    const used = helpers.flatMap((h) => (h.parts ? h.parts.filter((p) => new RegExp(`\\b${h.name}\\.${p.key}\\b`).test(text)).map((p) => p.text) : new RegExp(`\\b${h.name}\\b`).test(text) ? [h.text] : []));
    const calls = apiCallsIn(`${text}\n${used.join("\n")}`, known, methodsOf);
    return {
      ...s,
      url: `${base}${s.route === "/" ? (base ? "" : "/") : s.route}` || "/",
      endpoints: calls,
      forms: (text.match(/<form\b/g) ?? []).length,
      // Data-changing calls = distinct POST/PUT/PATCH/DELETE endpoints this screen can call.
      interactions: { ...own, mutations: calls.filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c)).length || own.mutations },
    };
  });
  return { entryPoints, screens: enriched.sort((a, b) => a.route.localeCompare(b.route)) };
}
