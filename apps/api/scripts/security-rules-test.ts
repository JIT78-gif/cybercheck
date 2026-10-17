// Tests the Cybercheck Semgrep rule pack in the security tool image: validates every rule, then runs Semgrep's own test
// runner on the fixtures (each rule has a buggy line marked "ruleid" and a fixed one marked "ok"). Sandbox only, no AI.
// Usage (from apps/api): npx tsx --env-file=../../.env scripts/security-rules-test.ts
import { readdirSync, readFileSync } from "node:fs";
import { securityToolImage, TOOL_ROOT } from "../src/security/tools.ts";
import { sandboxProvider } from "../src/testing/worker.ts";

const provider = sandboxProvider();
if (!provider) throw new Error("Nebius Sandboxes are not configured.");
const tools = await securityToolImage(provider, async (label, req) => {
  console.log(`[sandbox] ${label}`);
  const r = await provider.run(req);
  if (r.status !== "ok" || r.exitCode !== 0) console.log(`[sandbox] ${r.status} exit ${r.exitCode}
${(r.stdout + r.stderr).slice(-3000)}`);
  return { ok: r.status === "ok" && r.exitCode === 0, image: r.resultImage, stdout: `${r.stdout}
${r.stderr}`, executionId: null };
});
if (tools.image === null) throw new Error(tools.reason);
console.log(`tools ${tools.cached ? "(cached)" : "(built)"}: ${JSON.stringify(tools.versions)}`);

const dir = new URL("../src/security/rules/", import.meta.url);
const files = [];
for (const name of readdirSync(dir)) files.push({ path: `/cc-rules/${name}`, fileId: await provider.upload(readFileSync(new URL(name, dir))) });
const r = await provider.run({
  image: tools.image,
  command: `export PATH=${TOOL_ROOT}/venv/bin:$PATH SEMGREP_ENABLE_VERSION_CHECK=0 SEMGREP_SEND_METRICS=off; cd /cc-rules && semgrep --test --metrics=off . 2>&1 | tail -40`,
  network: false,
  keep: false,
  timeoutSec: 600,
  files,
});
console.log(r.stdout.slice(-8000));
if (r.stderr) console.log(r.stderr.slice(-2000));
process.exit(/0\/\d+: ✖|failed|error/i.test(r.stdout) ? 1 : 0);
