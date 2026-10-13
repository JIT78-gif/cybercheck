// Debug helper (local only): installs and starts the local services in a real sandbox and prints what happens.
import { env } from "../src/env.ts";
import { NebiusSandboxProvider } from "../src/testing/sandbox/nebius.ts";
import { installServices, startServices } from "../src/testing/services.ts";

const p = new NebiusSandboxProvider({ apiKey: env.NEBIUS_API_KEY!, projectId: env.NEBIUS_PROJECT_ID! });
const base = await p.image("docker.io/library/node:22-bookworm");
const inst = await p.run({ image: base, command: installServices(["postgres", "redis"]), network: true, keep: true, timeoutSec: 600 });
console.log("install", inst.status, inst.exitCode, inst.stdout.slice(-300), inst.stderr.slice(-300));
const run = await p.run({ image: inst.resultImage!, command: `${startServices(["postgres", "redis"])} echo ---; ls /etc/postgresql; id; (service postgresql status || true); tail -20 /var/log/postgresql/*.log 2>/dev/null`, network: false, keep: false, timeoutSec: 120 });
console.log("start", run.status, run.exitCode, "\nOUT:\n" + run.stdout.slice(-2500), "\nERR:\n" + run.stderr.slice(-2500));
