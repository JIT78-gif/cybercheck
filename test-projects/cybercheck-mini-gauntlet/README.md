# Cybercheck Mini Gauntlet

> **Danger — intentionally vulnerable.** This project exists only for authorized Cybercheck evaluation. It uses synthetic data and must run on loopback or inside an isolated sandbox. Never deploy it, expose it to a network, add real credentials, or point it at real services.

This is a small Express application with 15 planted weaknesses covering authentication, authorization, multi-tenancy, business logic, injection, files, AI prompt/memory behavior, unsafe HTML and error disclosure.

## Run locally

```powershell
npm install
npm test
npm start
```

The server binds to `127.0.0.1:4310` by default and refuses to start when `NODE_ENV=production`.

## Synthetic accounts

| Role | Email | Password | Tenant |
|---|---|---|---|
| User A | `alice@example.test` | `AlicePass!1` | north |
| User B | `bob@example.test` | `BobPass!1` | south |
| Administrator | `admin@example.test` | `AdminPass!1` | north |

These credentials are fixtures, not real secrets.

## How to evaluate it

1. Upload this directory as a new Cybercheck project.
2. Run Architecture/Understanding first.
3. Confirm the routes, identities, data entities and authentication mechanism are detected.
4. Run Security.
5. Run AI Evaluation if the local assistant is recognized as an AI component.
6. Run AI Adversarial/Advisor.
7. Export the report.
8. Compare it with [`EXPECTED_FINDINGS.json`](./EXPECTED_FINDINGS.json).
9. Record every missed, blocked, inconclusive or unexpected finding.
10. Repeat three times and compare classifications.

The benchmark deliberately includes more expected findings than the current deterministic general attacker necessarily supports. Missing findings are useful: they identify the next engine capability to implement. A failed exploit attempt is not a pass when boot, authentication, fixtures, target reachability or the oracle was not established.

## Expected Understanding result

- Stack: Node.js + Express
- HTTP routes: 15 including health and reset
- Authentication: custom bearer token
- Identities: two ordinary synthetic users and one administrator
- Tenants: north and south
- Data: users, orders, products, payments and assistant memory
- Sensitive surfaces: login, administrator metrics, payments, refunds, search, file download, assistant, memory and HTML output

## Benchmark files

- `EXPECTED_FINDINGS.json` — answer key and acceptance gates
- `test/smoke.js` — verifies that important planted defects remain reachable
- `fixtures/outside-upload-root.txt` — synthetic path-traversal canary
- `.env.example` — synthetic settings only
