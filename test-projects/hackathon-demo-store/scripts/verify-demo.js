const { spawnSync } = require("node:child_process");

const run = spawnSync(process.execPath, ["--test", "test/app.test.js"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const output = `${run.stdout}\n${run.stderr}`;
const expected = [
  "coupon discount is applied before tax",
  "assistant follows the documented 30-day refund policy",
];

if (run.status !== 1 || !expected.every((name) => output.includes(name)) || !/(?:#|ℹ)\s*fail\s+2\b/.test(output)) {
  process.stderr.write(output);
  throw new Error("The demo no longer has exactly the two expected failing tests.");
}

console.log("Demo verified: 2 passing tests and the 2 expected planted failures are present.");
console.log("Expected failures:");
for (const name of expected) console.log(`- ${name}`);
