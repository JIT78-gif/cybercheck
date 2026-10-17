import { posix } from "node:path";
import type { BrowserScreen, ProjectDossier, Screen } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

// Pages a backend serves itself (the 9+/10 plan, section 4): an Express static folder, a route answering with
// res.sendFile, a server-rendered template. They need no frontend build: the browser opens them on the backend.

const isHtml = (p: string) => /\.html?$/i.test(p);
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Counts of what a person can do on a page, from its HTML. */
function interactions(html: string): Screen["interactions"] {
  return {
    inputs: (html.match(/<(input|textarea|select)\b/gi) ?? []).filter((t) => !/type=["']?hidden/i.test(t)).length,
    buttons: (html.match(/<button\b/gi) ?? []).length,
    submitHandlers: (html.match(/addEventListener\(\s*["']submit|onsubmit=/gi) ?? []).length,
    mutations: (html.match(/fetch\([^)]*method\s*:\s*["'](POST|PUT|PATCH|DELETE)/gi) ?? []).length,
    formLibraries: [],
  };
}

/** API paths a page calls (fetch("/api/..."), axios.get("/api/...")), for linking screens to endpoints. */
const calledEndpoints = (html: string) => [...new Set([...html.matchAll(/(?:fetch|axios\.\w+)\(\s*[`"'](\/[^`"'?#\s]*)/g)].map((m) => m[1]!))].slice(0, 20);

/**
 * Resolves the directory or file a path.join/path.resolve expression names, relative to the file it appears in
 * (__dirname) or the project root. Only literal parts are understood; anything else gives null.
 */
function resolveExpr(raw: string, file: string): string | null {
  const dir = posix.dirname(file);
  // A plain argument can arrive with the call's closing bracket: "site") is "site".
  const expr = raw.includes("(") ? raw : raw.replace(/\)\s*$/, "");
  const call = expr.match(/path\.(?:join|resolve)\(([^)]*)\)/);
  const parts = call ? call[1]!.split(",").map((s) => s.trim()) : [expr.trim()];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "__dirname" || p === "import.meta.dirname") out.push(dir);
    else if (p === "process.cwd()") out.push(".");
    else if (/^["'`][^"'`$]*["'`]$/.test(p)) out.push(p.slice(1, -1));
    else return null;
  }
  const joined = posix.normalize(out.join("/")).replace(/^\.\//, "").replace(/^\/+/, "");
  return joined.startsWith("..") ? null : joined || ".";
}

/** Screens served by the backend itself: static HTML folders, res.sendFile routes and server-rendered templates. */
export function servedScreens(src: SnapshotSource, d: Pick<ProjectDossier, "entryPoints">): { screens: Screen[]; found: BrowserScreen[] } {
  const html = [...src.files.keys()].filter(isHtml);
  const byRoute = new Map<string, { file: string; source: BrowserScreen["source"]; at: { path: string; line: number } }>();
  const add = (route: string, file: string, source: BrowserScreen["source"], at: { path: string; line: number }) => {
    const r = route.replace(/\/+$/, "") || "/";
    if (!byRoute.has(r)) byRoute.set(r, { file, source, at });
  };
  for (const [file, f] of src.files) {
    if (!/\.(c|m)?[jt]s$/.test(file) || /(^|\/)(node_modules|test|tests|__tests__)\//.test(file)) continue;
    const text = f.text;
    // app.use(express.static(dir)) or app.use("/assets", express.static(dir))
    for (const m of text.matchAll(/\.use\(\s*(?:["'`]([^"'`]*)["'`]\s*,\s*)?express\.static\(([^)]*\)?)\s*[,)]/g)) {
      const dir = resolveExpr(m[2]!, file);
      if (!dir) continue;
      const mount = (m[1] ?? "").replace(/\/+$/, "");
      for (const h of html.filter((p) => dir === "." ? !p.includes("/") : p.startsWith(`${dir}/`))) {
        const rel = dir === "." ? h : h.slice(dir.length + 1);
        if (rel.includes("/node_modules/")) continue;
        const at = { path: file, line: lineOf(text, m.index!) };
        add(`${mount}/${rel}`, h, "static_html", at);
        if (/(^|\/)index\.html?$/i.test(rel)) add(`${mount}/${rel.replace(/(^|\/)index\.html?$/i, "")}`, h, "static_html", at);
      }
    }
    // app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")))
    for (const m of text.matchAll(/\.get\(\s*["'`]([^"'`]+)["'`][\s\S]{0,300}?\.sendFile\(\s*(path\.(?:join|resolve)\([^)]*\)|["'`][^"'`]+["'`])/g)) {
      const target = resolveExpr(m[2]!, file);
      if (!target || !isHtml(target) || !src.files.has(target) || /[:*]/.test(m[1]!)) continue;
      add(m[1]!, target, "send_file", { path: file, line: lineOf(text, m.index!) });
    }
    // app.get("/report", (req, res) => res.render("report"))
    for (const m of text.matchAll(/\.get\(\s*["'`]([^"'`:*]+)["'`][\s\S]{0,300}?\.render\(\s*["'`]([\w/-]+)["'`]/g)) {
      const view = [...src.files.keys()].find((p) => new RegExp(`(^|/)views/${m[2]}\\.(ejs|pug|hbs|html|njk)$`).test(p));
      if (view) add(m[1]!, view, "server_route", { path: file, line: lineOf(text, m.index!) });
    }
  }
  // Flask: @app.route("/report") ... return render_template("report.html")
  for (const [file, f] of src.files) {
    if (!file.endsWith(".py")) continue;
    for (const m of f.text.matchAll(/@\w+\.(?:route|get)\(\s*["']([^"'<]+)["'][\s\S]{0,400}?render_template\(\s*["']([\w/.-]+)["']/g)) {
      const view = [...src.files.keys()].find((p) => p.endsWith(`templates/${m[2]}`));
      if (view) add(m[1]!, view, "server_route", { path: file, line: lineOf(f.text, m.index!) });
    }
  }
  // An API route is never a screen, even if it happens to send a file.
  const apiPaths = new Set(d.entryPoints.filter((e) => /^\/(api|v\d+)(\/|$)/.test(e.path)).map((e) => e.path));
  // One page, one screen: "/index.html" is "/", and "/admin.html" is "/admin" when a route serves that same file.
  const clean = new Set([...byRoute].filter(([route]) => !/\.html?$/i.test(route)).map(([, s]) => s.file));
  const entries = [...byRoute].filter(([route, s]) => !apiPaths.has(route) && !/\.(json|txt|xml)$/.test(route) && !(/\.html?$/i.test(route) && clean.has(s.file)));
  return {
    screens: entries.map(([route, s]) => {
      const text = src.files.get(s.file)?.text ?? "";
      return { route, url: route, endpoints: calledEndpoints(text), file: s.file, framework: s.source === "server_route" ? "server-rendered" : "static-html", forms: (text.match(/<form\b/gi) ?? []).length, interactions: interactions(text) };
    }),
    found: entries.map(([route, s]) => ({ path: route, source: s.source, location: { path: s.at.path, line: s.at.line }, target: "backend_served" as const })),
  };
}
