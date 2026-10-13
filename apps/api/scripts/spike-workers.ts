// Spike (local only): proves Playwright + Chromium + axe-core, k6 and sqlite introspection run in a Nebius sandbox.
import { env } from "../src/env.ts";
import { NebiusSandboxProvider } from "../src/testing/sandbox/nebius.ts";

const p = new NebiusSandboxProvider({ apiKey: env.NEBIUS_API_KEY!, projectId: env.NEBIUS_PROJECT_ID! });
const base = await p.image("docker.io/library/node:22-bookworm");
const install = [
  "set -e",
  "uname -m",
  "mkdir -p /opt/cc-browser && cd /opt/cc-browser && npm init -y >/dev/null",
  "npm i --no-audit --no-fund playwright@1.49.1 axe-core@4.10.2 >/dev/null",
  "npx playwright install --with-deps chromium 2>&1 | tail -3",
  "mkdir -p /opt/cc-k6 && cd /opt/cc-k6",
  "curl -fsSL -o k6.tgz https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-linux-amd64.tar.gz",
  "curl -fsSL -o sums.txt https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-checksums.txt",
  "grep linux-amd64.tar.gz sums.txt | sed 's/ .*//' > want; sha256sum k6.tgz | sed 's/ .*//' > got; cmp want got && echo checksum-ok",
  "tar xzf k6.tgz --strip-components=1 && ./k6 version",
  "python3 -c 'import sqlite3; print(\"sqlite\", sqlite3.sqlite_version)'",
].join(" && ");
const t0 = Date.now();
const inst = { status: "ok", exitCode: 0, stdout: "", stderr: "", resultImage: process.env.SPIKE_IMAGE ?? (await p.run({ image: base, command: install, network: true, keep: true, timeoutSec: 900 })).resultImage };
console.log("install", inst.status, inst.exitCode, Math.round((Date.now() - t0) / 1000) + "s\n", inst.stdout.slice(-1500), inst.stderr.slice(-1500));
if (!inst.resultImage) process.exit(1);

const page = `<html><head><title>t</title></head><body><main><h1>Shop</h1><form><input id=q><button type=submit>Go</button></form><img src=x.png></main><script>console.error("boom-from-page")</script></body></html>`;
const files = { "/cc/s/server.mjs": `import http from "node:http"; http.createServer((q,r)=>{ if(q.url==="/api") { r.setHeader("content-type","application/json"); return r.end('{"ok":true}'); } r.setHeader("content-type","text/html"); r.end(${JSON.stringify(page)}); }).listen(4100, ()=>console.log("listening"));`,
  "/cc/s/b.mjs": `import { chromium } from "/opt/cc-browser/node_modules/playwright/index.mjs"; import fs from "node:fs";
const axe = fs.readFileSync("/opt/cc-browser/node_modules/axe-core/axe.min.js","utf8");
const b = await chromium.launch({ args: ["--disable-dev-shm-usage","--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 375, height: 800 } });
await ctx.tracing.start({ screenshots: true, snapshots: true });
const pg = await ctx.newPage(); const errs = []; pg.on("console", m => m.type()==="error" && errs.push(m.text()));
const res = await pg.goto("http://127.0.0.1:4100/"); await pg.addScriptTag({ content: axe });
const r = await pg.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa","wcag22aa"] } })).violations.map(v => v.id + ":" + v.impact + ":" + v.nodes.length));
await pg.getByRole("button", { name: "Go" }).click();
await ctx.tracing.stop({ path: "/cc/s/trace.zip" }); await pg.screenshot({ path: "/cc/s/shot.png" });
console.log("status", res.status(), "errors", JSON.stringify(errs), "axe", JSON.stringify(r), "trace", fs.statSync("/cc/s/trace.zip").size);
await b.close();`,
  "/cc/s/load.js": `import http from "k6/http"; export const options = { vus: 5, duration: "8s", summaryTrendStats: ["p(50)","p(95)","max"] }; export default function () { http.get("http://127.0.0.1:4100/api"); }`,
  "/cc/s/db.py": `import sqlite3; c=sqlite3.connect(":memory:"); c.executescript("create table a(id integer primary key, n text not null unique); create table b(id integer primary key, a_id integer references a(id));"); print([tuple(r) for r in c.execute("pragma foreign_key_list(b)")]); print(c.execute("pragma foreign_keys").fetchone())`,
};
const ids: { path: string; fileId: string }[] = [];
for (const [path, body] of Object.entries(files)) ids.push({ path, fileId: await p.upload(Buffer.from(body)) });
const t1 = Date.now();
const run = await p.run({ image: inst.resultImage, network: false, keep: false, timeoutSec: 300, files: ids,
  command: "cd /cc/s; node server.mjs > /cc/s/srv.log 2>&1 & SP=$!; sleep 1; node b.mjs 2>&1 | tail -5 && /opt/cc-k6/k6 run --quiet --summary-export=/cc/s/sum.json load.js 2>&1 | tail -8; node -e 'const s=require(\"/cc/s/sum.json\");console.log(\"k6\",JSON.stringify(s.metrics.http_req_duration),JSON.stringify(s.metrics.http_reqs.count))' && python3 db.py; kill $SP" });
console.log("run", run.error, run.status, run.exitCode, Math.round((Date.now() - t1) / 1000) + "s\nOUT:\n" + run.stdout.slice(-3000), "\nERR:\n" + run.stderr.slice(-2000));
