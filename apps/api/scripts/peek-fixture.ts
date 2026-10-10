// Prints the analyzer's view of a named fixture (development aid for writing answer keys).
// Usage (from apps/api): npx tsx scripts/peek-fixture.ts <fixture>
import { analyzeSource } from "../src/understanding/analyze.ts";
import { fixtureSource } from "../test/fixture-source.ts";

async function main() {
  const d = await analyzeSource(fixtureSource(process.argv[2]!), { snapshotId: "peek", contentDigest: "peek" });
  const view = {
    routes: d.entryPoints.map((e) => `${e.method} ${e.path} -> ${e.control.kind} (${e.control.reason})`),
    entities: d.dataModel.entities.map((e) => `${e.table}: ${e.fields.map((f) => f.name).join(",")} | rel ${e.relations.map((r) => r.to).join(",")}`),
    env: d.config.envVars.map((e) => `${e.name} used=${e.usedIn.length} doc=${e.documented} req=${e.required} def=${e.hasDefault} ${e.sensitivity} ${e.side}`),
    jobs: d.background.map((j) => `${j.name}: ${j.schedule} -> ${j.resolvedSchedule} (${j.scheduleNote}) tz=${j.timezone} handler=${j.handler}`),
    containers: d.deployment.containers.map((c) => `${c.name}@${c.file}`),
    screens: d.screens.map((s) => `${s.route} ${s.file} inputs=${s.interactions.inputs} mut=${s.interactions.mutations}`),
    types: d.domainTypes.map((t) => t.id),
    security: { mech: d.securityModel.authMechanisms.map((m) => m.detail), cred: d.securityModel.credentialChecks.map((c) => c.kind), rl: d.securityModel.rateLimiting, notDetected: d.securityModel.notDetected.map((n) => n.control) },
    logging: d.quality.logging,
    tests: d.quality.testFiles,
    ai: d.aiComponents.map((a) => a.sdk),
    coverage: d.coverage.categories.map((c) => `${c.id}=${c.count}`).join(" ") + ` total=${d.coverage.filesTotal}`,
    findings: d.observations.map((o) => `[${o.severity}] ${o.title}`),
    consistency: d.consistency.map((c) => `${c.severity}: ${c.message}`),
  };
  console.log(JSON.stringify(view, null, 1));
}

void main();
