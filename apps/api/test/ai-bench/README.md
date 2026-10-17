# cybercheck AI Evaluator benchmark

Projects used to measure the accuracy of the cybercheck AI Evaluator check. Each project folder has:

- `project/`: exactly what a user would upload. No node_modules, no .env, no answer hints.
- `expected.json`: the answer key, read only by the scorer, never by the engine.

| Fixture | Where | What it tests |
| --- | --- | --- |
| Gauntlet (5 AI defects) | `test/testing-bench/cybercheck-gauntlet` | Regression truth, frozen in `gauntlet-ai-frozen.json`: indirect prompt injection, system prompt and synthetic secret disclosure, unrestricted file tool, global assistant history, model output assigned to innerHTML. Its assistant is local code with no model provider. |
| `clean-ai-control` | here | Clean control: an OpenAI-compatible assistant over `AI_BASE_URL` with tenant-scoped documents and history, retrieved text passed as data, citations filtered to retrieved documents, owner-checked tools with strict arguments, customer approval before cancelling, a bounded tool loop, one retry, an instruction-echo guard and text-only rendering. Any confirmed high or critical AI finding is a false positive. |
| No-AI control | `test/security-bench/clean-node-control` | Has no AI component: AI Evaluator must return `not_applicable` without starting a sandbox or a judge. |

## Answer key notes

- `gauntlet-ai-frozen.json` copies the Gauntlet's `track: "ai"` entries and pins a source anchor for each, so a
  change to the Gauntlet or its key fails `test/ai-bench-frozen.test.ts` instead of silently moving the target.
- Each frozen defect names the AI Evaluator case category that must detect it.
- `defects` is empty for a control; `mustNotReport` lists the claims a correct engine must not make about it.
