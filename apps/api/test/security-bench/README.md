# cybercheck Security benchmark

Projects used to measure the accuracy of the cybercheck Security check. Each folder has:

- `project/`: exactly what a user would upload. No node_modules, no .env, no answer hints.
- `expected.json`: the answer key, read only by the scorer (`test/security-score.ts`), never by the engine.

The Gauntlet (`test/testing-bench/cybercheck-gauntlet`) carries the Security track defects of Round 1 in its own key;
`npm run eval:security` scores it together with the projects here.

| Project              | Stack                                  | What it tests |
| -------------------- | -------------------------------------- | ------------- |
| `clean-node-control` | Express 5, helmet, node:sqlite         | Clean control: scrypt passwords, HMAC-signed tokens compared in constant time, parameterised queries, per-owner queries, an admin role check, an origin allowlist, a contained file download and a generic error handler. Any critical or high finding is a false positive. |

## Answer key notes

- `defects` is empty for a control; `mustNotReport` lists the claims a correct engine must not make about it.
- Security-track defects use `track: "security"` and an OWASP `category`; the scorer only credits a finding whose
  CWE belongs to that category.
