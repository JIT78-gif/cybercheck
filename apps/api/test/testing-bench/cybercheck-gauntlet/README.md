# Cybercheck Gauntlet benchmark

This directory contains a deliberately defective application used to measure Cybercheck itself.

- Upload or import only `project/` when running a blind test.
- Keep `expected.json` outside the uploaded snapshot. It is the answer key.
- Run only on loopback or inside an isolated sandbox.
- Every credential and secret is synthetic. Never add real credentials or production data.
- The subject is intentionally unsafe and must never be deployed or exposed to a network.

The answer key covers four evaluation tracks: functional/testing, application security, AI safety,
and adversarial/performance/reliability. Automated tools are not expected to prove every item; the
`mustFind` entries are the release-gating baseline and the remaining entries measure deeper coverage.

Run `node verify-seeded-defects.mjs` from this directory after installing `project/`. It performs a
small, safe loopback check that the principal seeded behaviors still exist. This is a fixture-integrity
check, not the Cybercheck evaluation itself.


