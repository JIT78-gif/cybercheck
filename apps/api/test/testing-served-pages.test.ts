import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { servedScreens } from "../src/testing/served-pages.ts";

/** A project folder as the engine sees it (without node_modules). */
function source(dir: string) {
  const files = new Map<string, { text: string }>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === "node_modules" || name === ".git") continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full).replace(/\\/g, "/"), { text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return { files, allPaths: [...files.keys()] } as never;
}
const mem = (entries: Record<string, string>) => ({ files: new Map(Object.entries(entries).map(([k, text]) => [k, { text }])), allPaths: Object.keys(entries) }) as never;
const noApi = { entryPoints: [] } as never;

describe("pages the backend serves itself", () => {
  it("finds the Gauntlet's static shop, admin and assistant pages, with what a person can do on them", () => {
    const { screens, found } = servedScreens(source(join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project")), noApi);
    const routes = screens.map((s) => s.route);
    // Each page once, under its clean route.
    expect(routes.sort()).toEqual(["/", "/admin", "/assistant"]);
    const home = screens.find((s) => s.route === "/")!;
    expect(home.file).toBe("public/index.html");
    expect(home.interactions.inputs).toBeGreaterThan(0);
    expect(found.find((f) => f.path === "/admin")).toMatchObject({ source: "send_file", target: "backend_served" });
    expect(found.find((f) => f.path === "/")).toMatchObject({ source: "static_html" });
  });

  it("understands mounted static folders, project-root paths and server-rendered templates", () => {
    const src = mem({
      "server.js": `app.use("/docs", express.static("site"));\napp.get("/report", (req, res) => res.render("report"));\napp.get("/api/export", (req, res) => res.sendFile(path.join(__dirname, "out", "x.html")));`,
      "site/index.html": "<form><input name=q></form>",
      "site/guide.html": "<button>Go</button>",
      "views/report.ejs": "<h1>Report</h1>",
      "out/x.html": "<p>x</p>",
      "app.py": `@app.route("/stats")\ndef stats():\n    return render_template("stats.html")`,
      "templates/stats.html": "<table></table>",
    });
    const { screens } = servedScreens(src, { entryPoints: [{ path: "/api/export" }] } as never);
    // /docs/index.html is the same page as /docs: one screen.
    expect(screens.map((s) => s.route).sort()).toEqual(["/docs", "/docs/guide.html", "/report", "/stats"]);
    expect(screens.find((s) => s.route === "/docs")!.forms).toBe(1);
  });

  it("finds nothing in a project without served pages", () => {
    expect(servedScreens(mem({ "server.js": "app.get('/api/x', h)" }), noApi).screens).toEqual([]);
  });
});
