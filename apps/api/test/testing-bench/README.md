# cybercheck Testing benchmark

Eight small projects used to measure the accuracy of cybercheck Testing.
Each folder has:

- `project/`: exactly what a user would upload (sources, manifest, lockfile or
  pinned requirements). No node_modules, no .env, no answer hints.
- `expected.json`: the answer key (never shown to the engine's AI).

| Project            | Stack                                   | What it tests |
| ------------------ | --------------------------------------- | ------------- |
| `ledger-api`       | Fastify, zod, better-sqlite3, vitest    | One existing test fails from a real rounding mistake (D1, existing_test) and POST /transfers has no body validation so malformed bodies return 500 (D2, api_probe). Requires ADMIN_TOKEN at boot. |
| `todo-express`     | Express 4 (CommonJS), jest, supertest   | Safe twin: no product defects. One test is nondeterministic (about 50% failure from random title lengths). Engine must report flaky, and any product defect is a false positive. |
| `notes-zero-tests` | Fastify, zod, vitest                    | `npm test` exits 0 but runs zero tests. Engine must not report the suite as passed. |
| `broken-build`     | TypeScript library, vitest              | `tsc` fails with one real type error (TS2554) while all tests pass. Typecheck and build failed, tests passed. |
| `py-inventory`     | FastAPI, pydantic, pytest               | One failing pytest test caused by over-reservation of stock (reserve checks on_hand, not available). |
| `hanging-suite`    | TypeScript library, vitest              | One test awaits an event that never fires and testTimeout is 10 minutes. Engine must time out, kill and report not passed. |
| `order-workflow`   | Fastify, vitest                         | Happy-path tests pass; the state machine allows created to shipped (unpaid). Stretch goal (mustFind=false). |
| `env-integrations` | Express 5, zod, pg, vitest, supertest   | Safe twin for environment problems: needs Stripe, SendGrid, Postgres and token env vars; two contract tests need real network and fail offline. Offline failures must be classified as environment, not product defects. |

## Answer key notes

- `defects[].line` points at the faulty line in the uploaded project.
- `broken-build` uses `kind: "build_defect"` and `detectableBy: "typecheck"`
  because its only issue is a compile error, not a runtime defect.
- Test names in `failingTests`, `flakyTests` and `environmentFailingTests` are
  the vitest/jest "describe > test" path or the pytest node id.
- Commands assume the sandbox image (Node 22, Debian bookworm, python3 3.11).
