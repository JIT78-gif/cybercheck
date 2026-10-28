# cybercheck

> Evidence-first quality, security, and AI assurance for software projects.

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=nextdotjs&logoColor=white">
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-black?style=flat-square&logo=fastify&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Checks" src="https://img.shields.io/badge/assurance_checks-4-45d0b6?style=flat-square">
  <img alt="Evidence first" src="https://img.shields.io/badge/verdicts-evidence_first-a996ff?style=flat-square">
</p>

cybercheck ingests a repository or source archive, builds a source-grounded understanding of the project, and runs four complementary checks: **Testing**, **Security**, **AI Evaluator**, and **AI Adversarial**. Every result is designed to answer three questions a developer or judge will ask: **What happened? What proves it? What should we do next?**

This is a hackathon build with a working full-stack application, a deliberately flawed demonstration project, isolated execution support, review and repair workflows, and benchmark suites for the check engines.

**Live demo:** https://32-237-56-77.sslip.io · **Track:** Coding and Agentic Engineering · **License:** [MIT](LICENSE)

> **Safety boundary:** cybercheck assesses only code you own or are authorized to test. Uploaded projects and generated commands are untrusted workloads. Never point the adversarial workflow at production or third-party systems.

## Contents

- [Why cybercheck](#why-cybercheck)
- [NVIDIA Nemotron on Nebius Token Factory](#nvidia-nemotron-on-nebius-token-factory)
- [What the product does](#what-the-product-does)
- [The 3-minute judge demo](#the-3-minute-judge-demo)
- [System architecture](#system-architecture)
- [Agent architecture](#agent-architecture)
- [How a project moves through the system](#how-a-project-moves-through-the-system)
- [Repository structure](#repository-structure)
- [Technology choices](#technology-choices)
- [Run locally](#run-locally)
- [Use the application](#use-the-application)
- [Configuration](#configuration)
- [Testing and evaluation](#testing-and-evaluation)
- [Security model](#security-model)
- [API map](#api-map)
- [Current limitations](#current-limitations)
- [Roadmap](#roadmap)
- [Troubleshooting](#troubleshooting)

## Why cybercheck

Shipping software now requires more than a green unit-test badge. A project can compile while its critical user journey is broken, pass a security scan while authorization is missing, or return fluent AI answers that are wrong, unsafe, or vulnerable to prompt injection.

Most tools expose isolated signals. cybercheck creates a shared, evidence-backed project model and lets four specialist engines examine the same immutable snapshot:

| Problem | cybercheck's response |
|---|---|
| Tests pass, but important behavior is untested | Map requirements, routes, identities, data operations, and user journeys to explicit obligations and evidence |
| Static security alerts are noisy | Correlate static candidates with runtime proofs and preserve `suspected`, `confirmed`, `blocked`, and `inconclusive` states |
| AI quality is reduced to one vague score | Run versioned cases, deterministic graders, canaries, latency/cost checks, and an optional calibrated judge |
| Prompt injection is tested without application context | Build an attack surface from real routes, identities, memory, retrieval, tools, and previously observed weaknesses |
| Automated fixes are hard to trust | Require explicit approval, patch a fresh baseline, replay the original failure, and run regression checks |

The core design principle is simple: **AI may propose and explain; deterministic code, tool output, and replayable evidence decide whenever possible.**

## NVIDIA Nemotron on Nebius Token Factory

cybercheck is a coding agent that writes, runs and tests code. Its model calls go to the Nebius Token Factory inference API, and the untrusted project code it builds and attacks runs in Nebius Sandboxes on the same platform.

**Which model does what.** Every model call names a role, and each role maps to the model that fits it:

| Role | Default model (Token Factory) | Why this size |
|---|---|---|
| Author: writes tests, probes, attack steps and repair patches for all four checks | `nvidia/nemotron-3-super-120b-a12b` (Nemotron 3 Super) | The highest-volume role: dozens of calls per run, so it needs to be fast and low cost while still writing correct code |
| Triage: plans how to boot an app and explains why a test failed | `nvidia/Nemotron-3-Ultra-550b-a55b` (Nemotron 3 Ultra) | Fewer calls that need the strongest reasoning over long logs and source |
| Project understanding: summarises the codebase into the shared project model | Nemotron 3 Super (fast passes) and Nemotron 3 Ultra (deep passes) | Same split: breadth with Super, depth with Ultra |
| Critic: must agree before a defect is confirmed, and scores AI answers as the AI Evaluator judge | `zai-org/GLM-5.3` | Deliberately a different model family, so a model never approves its own mistake |

**How the models are used safely.**

- **Structured output only.** Every call must return JSON that matches a Zod schema. A wrong shape gets one retry with the exact validation errors, and reasoning text is stripped before parsing.
- **The model never decides a verdict.** Nemotron proposes tests, attacks and patches; deterministic oracles that run real code in a Nebius Sandbox decide pass or fail, and a repair counts only when the original failure replays as fixed.
- **Untrusted project text is data.** Source is wrapped in `<project_data>` tags, and secrets are redacted before any model sees them.
- **Hard spending caps.** Before each call, the gateway reserves the worst-case cost using the per-token prices Token Factory publishes in its `/models` list, so a run can never exceed its budget (`AI_RUN_BUDGET_USD`, `TESTING_RUN_BUDGET_USD`).

**Where Token Factory accelerated the work.** One OpenAI-compatible endpoint serves both NVIDIA Nemotron and an independent critic family, so trying a different model for a role is a configuration change (`TESTING_MODEL_*`, `NEBIUS_MODEL_*`), not new code. Published prices make the budget guard exact. Token Factory Sandboxes give each run a disposable, VM-isolated machine, so cybercheck can build and attack code it has never seen without running it on its own server.

Gemini remains an optional alternative provider (`TESTING_AI_PROVIDER=gemini`, `UNDERSTANDING_AI_PROVIDER=gemini`); the default is Nemotron on Token Factory.

## What the product does

### 1. Project understanding

Before a check runs, cybercheck analyzes the snapshot and creates a reusable project dossier:

- languages, frameworks, package managers, scripts, and runtime assumptions;
- routes, screens, entry points, integrations, environment variables, and deployment signals;
- data models, identity and authorization boundaries, and sensitive assets;
- AI components, prompts, retrieval, memory, model calls, and tool surfaces;
- source-grounded architecture diagrams, risks, and check recommendations.

Static analyzers establish facts first. AI synthesis is bounded to supplied code excerpts and must cite a real path, line, and symbol. An independent critic challenges risk claims before they become shared context.

### 2. Four assurance checks

| Check | What it examines | What the user receives |
|---|---|---|
| **Testing** | Install/build/typecheck/lint, existing suites, API behavior, database behavior, browser journeys, accessibility, load behavior, generated focused checks | Failures with exact inputs and outputs, coverage obligations, untested areas, release evidence, and repair options |
| **Security** | Secrets, vulnerable dependencies, static code rules, configuration, authorization, input boundaries, and safe runtime proofs | Confirmed or suspected findings, CWE/OWASP context, reproduction evidence, root cause, and remediation |
| **AI Evaluator** | AI applicability, versioned datasets, expected behavior, grounding, leakage, robustness, latency, cost, and provider failure behavior | Pass rates with denominators, per-case evidence, undecided cases, canary results, and suggested guardrails |
| **AI Adversarial** | Prompt injection, cross-tenant access, memory/retrieval isolation, unsafe tool paths, business logic, and attack chains | Bounded campaigns, minimum-impact proof, correlated attack chains, replay tests, and remaining risk |

### 3. Human review and bounded repair

A finding is not silently changed in the source project. The user can review the evidence, choose a finding, request a repair, inspect the plan, and explicitly approve sandbox work. Each repair starts from the immutable baseline and must pass targeted replay plus allowed regression checks. The output is a proposal and evidence trail; applying it to a real repository is a separate action.

## The 3-minute judge demo

The repository includes a synthetic e-commerce project with intentional issues across all four checks. It contains no real secrets or customer data.

1. Start cybercheck and sign in.
2. Create a project and upload [`test-projects/hackathon-demo-store-upload.zip`](test-projects/hackathon-demo-store-upload.zip).
3. Open **Architecture** to show that cybercheck found the Express routes, test suite, and local AI component.
4. Run **Testing** and show the checkout regression: discount and tax are applied in the wrong order.
5. Run **Security** and show the cross-tenant order-access defect.
6. Run **AI Evaluator** and show the assistant contradicting the documented 30-day refund policy.
7. Run **AI Adversarial** and show prompt leakage plus cross-tenant memory leakage.
8. Open a finding, walk through its evidence and root cause, then demonstrate the review/repair approval path.

The fixture can also prove its intended behavior independently:

```powershell
cd test-projects/hackathon-demo-store
npm ci
npm run verify:demo
```

Expected outcome: two ordinary tests pass, two planted regression tests fail, and the runtime probes reproduce the security and adversarial defects. The complete recording script is in [`DEMO_GUIDE.md`](test-projects/hackathon-demo-store/DEMO_GUIDE.md).

## System architecture

![cybercheck system architecture](images/readme-system-architecture.svg)

### Architectural boundaries

| Boundary | Responsibility | Trust level |
|---|---|---|
| Web application | Project intake, progress, evidence, review, approvals, and reports | Trusted presentation layer; never the authorization authority |
| API | Authentication, workspace scoping, validation, state transitions, and streaming endpoints | Trusted control plane |
| PostgreSQL | Projects, snapshots, dossiers, runs, findings, events, reviews, approvals, and worker leases | Trusted durable state |
| Object store | Immutable snapshot archives, manifests, reports, logs, screenshots, and patch artifacts | Trusted metadata; content may originate from untrusted projects |
| Worker | Claims runs, heartbeats, cancellation, fenced writes, budgets, and engine dispatch | Trusted orchestrator |
| Model gateway | Provider routing, structured responses, redaction, timeouts, and per-run cost budgets | Advisory; cannot grant authority or create evidence by itself |
| Sandbox | Installs, builds, tests, browsers, application boot, probes, and repair validation | Untrusted and disposable |

The worker increments a run generation when reclaiming abandoned work. Late writes from an older worker generation are rejected, preventing a timed-out process from overwriting the result of a newer run.

## Agent architecture

cybercheck uses a **controlled specialist pipeline**, not an unrestricted autonomous swarm. “Agent” means a versioned role with a narrow prompt, schema, context, allowed actions, and budget. Agents do not receive credentials for the assessed project, cannot expand scope, and cannot mark their own hypotheses as proven.

![cybercheck controlled specialist pipeline](images/readme-agent-pipeline.svg)

### Shared understanding specialists

| Specialist | Input | Output | Guardrail |
|---|---|---|---|
| Static analyzers | Snapshot files and manifests | Routes, data models, configuration, integrations, runtimes, deployment and structure facts | Parser/rule output only |
| Module synthesizer | Bounded source excerpts and verified facts | Concise module purpose and behavior | Every claim cites a visible file, line, and symbol |
| System synthesizer | Verified facts and module summaries | Architecture, data flow, sensitive assets, and check recommendations | Structured schema; cannot invent services or files |
| Risk critic | Candidate risks plus relevant code | Supported, partly supported, or unsupported decision | Independent review prompt; unsupported claims are not promoted |

### Testing specialists

| Specialist | Responsibility |
|---|---|
| Boot planner | Proposes how to start detected backends/frontends using synthetic settings in a clean Linux sandbox |
| Fixture planner | Creates the minimum setup graph for accounts, records, and dependencies required by a check |
| API scenario author | Writes route-specific probes with cited oracles and known identities |
| Unit-test author | Creates focused tests for business logic such as money, inventory, policy, and state transitions |
| Browser-journey author | Creates Playwright journeys grounded in actual screen code and visible outcomes |
| Failure triage | Explains one observed failure without changing the measured verdict |
| Independent critic | Challenges product-defect claims using evidence and a different model role |
| Repair specialist | Proposes the smallest coherent patch after approval; validation happens independently |

The engine also runs deterministic project commands, repeats suspicious failures to detect flakiness, checks APIs and databases, runs Chromium and axe-core when applicable, and records what could not be tested.

### Security specialists

| Stage | Responsibility |
|---|---|
| Static discovery | Run pinned secret, dependency, configuration, JavaScript/TypeScript, and Python rules |
| Obligation builder | Convert project facts and candidates into explicit controls that should be proved |
| Proof compiler | Turn only allowlisted proof types into minimum-impact runtime checks |
| Runtime proof engine | Execute safe requests in the isolated application and capture exact evidence |
| Correlator | Merge duplicate signals and connect cause, path, control, and impact |
| Optional evidence critic | Challenge the strength of an existing claim; it may downgrade or question, never independently confirm |
| Repair/replay | Patch an approved finding and rerun the original proof plus regressions |

Security does not equate “scanner returned nothing” with “secure.” Tool failures and unreachable controls are reported as blocked or inconclusive, and coverage always includes a denominator.

### AI Evaluator specialists

| Stage | Responsibility |
|---|---|
| Applicability detector | Decide whether the project exposes a testable AI component; otherwise return `NOT_APPLICABLE` with a reason |
| Dataset compiler | Normalize built-in and uploaded JSONL cases into versioned executable cases |
| Runtime adapter | Boot the AI-facing application in Nebius or local Docker where supported |
| Deterministic graders | Evaluate exact constraints, JSON shape, citations, leakage canaries, latency, and other objective behavior |
| Calibrated judge | Resolve meaning-dependent cases only after calibration; never override deterministic failures |
| Decision engine | Combine case evidence into passed, failed, undecided, blocked, or not-applicable outcomes |
| Repair/replay | Propose guardrail/code changes and replay the failed cases against a fresh baseline |

### AI Adversarial specialists

| Stage | Responsibility |
|---|---|
| Surface mapper | Connect routes, identities, retrieval, memory, tools, approvals, sinks, and protected assets using source evidence |
| Campaign catalog | Select deterministic attacks that apply to the observed surface |
| Optional attack planner | Rank known campaigns and propose bounded hypotheses using only supplied endpoints, identities, and techniques |
| Campaign runner | Exercise the isolated target with synthetic accounts and minimum-impact payloads |
| Oracle | Decide whether a protected boundary was actually crossed from recorded observations |
| Evidence critic | Challenge unsupported or overstated claims |
| Chain coordinator | Combine individually smaller weaknesses into a source-to-impact attack path |
| Replay specialist | Confirm an approved repair blocks the original attack without breaking expected behavior |

The adversarial engine is constrained by rules of engagement. It is intended for owned, isolated targets and synthetic data, not open-ended offensive use.

## How a project moves through the system

```mermaid
sequenceDiagram
    actor User
    participant Web
    participant API
    participant Intake
    participant Understanding
    participant Worker
    participant Sandbox
    participant DB

    User->>Web: Upload archive or choose authorized GitHub repository
    Web->>API: Create project and snapshot
    API->>Intake: Validate archive and enforce limits
    Intake->>DB: Save immutable digest, manifest, and exclusions
    Intake->>Understanding: Analyze snapshot
    Understanding->>DB: Store source-grounded dossier
    User->>Web: Select a check and profile
    Web->>API: Queue run
    API->>DB: Persist run and event stream
    Worker->>DB: Claim run with generation and heartbeat
    Worker->>Sandbox: Prepare dependencies and execute bounded plan
    Sandbox-->>Worker: Logs, responses, screenshots, measurements
    Worker->>DB: Store obligations, evidence, findings, and report
    Web->>API: Poll/stream events and fetch result
    API-->>Web: Progress, coverage, findings, limitations
    User->>Web: Review and optionally approve repair
    Worker->>Sandbox: Fresh baseline, patch, replay, regressions
    Sandbox-->>Worker: Validation evidence and patch artifact
```

Snapshot states are `RECEIVED → VALIDATING → BASELINED` or an explicit `REJECTED`/`FAILED`. A baselined snapshot is immutable; rerunning a check never silently changes its source.

## Repository structure

```text
cybercheck/
├── apps/
│   ├── web/                         # Next.js 16 + React 19 product UI
│   │   ├── src/app/                 # Marketing, auth, dashboard, project and run routes
│   │   ├── src/components/          # Intake, architecture and four check experiences
│   │   ├── e2e/                     # Playwright end-to-end tests
│   │   └── scripts/                 # Screenshot and visual inspection helpers
│   └── api/                         # Fastify API and background worker
│       ├── src/intake/              # Archive/GitHub validation and immutable snapshots
│       ├── src/understanding/       # Static analyzers, AI synthesis and diagrams
│       ├── src/testing/             # Testing engine, harnesses and sandbox adapters
│       ├── src/security/            # Rules, obligations, proofs, critic and reports
│       ├── src/ai-evaluator/        # Datasets, graders, judge, canaries and reports
│       ├── src/adversarial/         # Surface mapping, campaigns, chains and reports
│       ├── src/routes/              # Authenticated, tenant-scoped HTTP API
│       ├── src/db/                  # Drizzle schema, client, locks and migrations
│       └── test/                    # Unit, integration, frozen-benchmark and acceptance tests
├── packages/
│   └── contracts/                   # Shared Zod schemas and TypeScript API contracts
├── test-projects/
│   ├── hackathon-demo-store/        # Small video fixture with four intentional defects
│   └── cybercheck-mini-gauntlet/    # Broader synthetic stress/coverage fixture
├── images/                          # Architecture diagrams and design notes
├── design-system/                   # Visual language and page specifications
├── docker-compose.yml               # Local PostgreSQL 17
├── .env.example                     # Documented configuration template
└── package.json                     # npm workspace commands
```

Useful starting points for contributors:

- [`apps/api/src/app.ts`](apps/api/src/app.ts) registers the API modules.
- [`apps/api/src/worker.ts`](apps/api/src/worker.ts) starts the check worker.
- [`apps/api/src/testing/worker.ts`](apps/api/src/testing/worker.ts) owns claiming, heartbeat, cancellation, recovery, and engine dispatch.
- [`apps/web/src/lib/checks.ts`](apps/web/src/lib/checks.ts) defines the user-facing four-check model.
- [`packages/contracts/src/index.ts`](packages/contracts/src/index.ts) defines shared request/response contracts.
- [`images/system-design-blueprint.md`](images/system-design-blueprint.md) contains the deeper engineering blueprint and threat-boundary rationale.

## Technology choices

| Layer | Technology | Why it is used |
|---|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 | Typed product UI, route-based experiences, responsive dashboards, and same-origin API proxying |
| Visualization | Mermaid, Recharts | Architecture/data-flow diagrams and readable result summaries |
| API | Fastify 5, TypeScript, Zod | Fast request handling, explicit schemas, bounded payloads, and typed validation |
| Authentication | Better Auth | Email/password and optional Google/GitHub sign-in with server-side session enforcement |
| Database | PostgreSQL 17, Drizzle ORM | Transactional tenancy, run state, worker leases, findings, evidence lineage, and migrations |
| Contracts | npm workspace package + Zod | One source of truth shared by the browser and API |
| Worker | PostgreSQL-backed claiming with `SKIP LOCKED`, heartbeat and fencing | Durable concurrent work without adding a second queue system during the hackathon |
| Sandboxes | Nebius Sandboxes; bounded Docker fallback for supported checks | Disposable execution for untrusted builds, apps, probes, and repair validation |
| AI models | NVIDIA Nemotron 3 Super and Ultra on Nebius Token Factory, GLM-5.3 as the independent critic; Gemini optional | Right-sized models per role, structured output, model-role separation, timeouts, and budgets |
| Browser/accessibility | Playwright, Chromium, axe-core | Real user journeys, screenshots, and WCAG evidence |
| Testing | Vitest, Playwright, frozen benchmark fixtures | Unit/integration confidence plus regression measurement for the assurance engines themselves |
| Storage | Local filesystem object-store interface | Atomic local artifacts now, with a narrow interface for future S3-compatible storage |

## Run locally

### Prerequisites

- **Node.js 24 or newer**
- **npm** (included with Node)
- **Docker Desktop** or another Docker Compose-compatible runtime for PostgreSQL
- A Nebius Token Factory API key and project: NVIDIA Nemotron models for the AI roles, and Nebius Sandboxes for Testing execution
- Optional: a Gemini key, if you prefer Gemini for the AI roles

### 1. Clone and install

```powershell
git clone https://github.com/JIT78-gif/cybercheck.git
cd cybercheck
npm ci
```

### 2. Create local configuration

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the generated value into `BETTER_AUTH_SECRET` in `.env`. The default database URL and local ports already match `docker-compose.yml`.

For the complete four-check demo, also set:

```dotenv
NEBIUS_API_KEY=your_nebius_key
NEBIUS_PROJECT_ID=your_nebius_project_id
```

If you use Gemini for testing-agent roles:

```dotenv
TESTING_AI_PROVIDER=gemini
GEMINI_API_KEY=your_google_ai_studio_key
```

Never commit `.env` or embed credentials in a Git remote URL.

### 3. Start PostgreSQL and migrate

```powershell
npm run db:up
npm run db:migrate -w @cybercheck/api
```

PostgreSQL is exposed on `localhost:5433` to avoid colliding with a system installation on the default port.

### 4. Start the application

```powershell
npm run dev
```

This starts three processes:

| Process | Address / purpose |
|---|---|
| Web | [http://localhost:3000](http://localhost:3000) |
| API | `http://localhost:4000` (`GET /v1/health`) |
| Worker | Claims queued checks and approved repair jobs |

Without SMTP configuration, email verification codes are printed in the API terminal. This is intentional for local development.

### 5. Verify the installation

```powershell
Invoke-RestMethod http://localhost:4000/v1/health
npm run typecheck
npm test
```

The health endpoint should return `{ "ok": true }`.

## Use the application

1. Open `http://localhost:3000` and create an account.
2. Copy the verification code from the API terminal if SMTP is not configured.
3. Select **Add project**.
4. Upload a ZIP archive or connect the optional GitHub App and select an authorized repository.
5. Wait for intake and project understanding to finish.
6. Inspect **Architecture** before running checks; this shows what cybercheck believes the project contains.
7. Choose Testing, Security, AI Evaluator, or AI Adversarial and review the scope/profile.
8. Follow live events while the worker executes the run.
9. Read findings together with evidence, coverage, blocked areas, and limitations.
10. For a selected finding, submit a review or start the approval-gated repair workflow.

### Supported intake behavior

- ZIP/TAR-style project archives are normalized and validated before storage.
- Generated and dependency directories such as `node_modules`, `.git`, `.next`, `dist`, `build`, and `coverage` are excluded.
- Uploads are bounded by compressed size, expanded size, file count, individual file size, path depth, path length, and compression ratio.
- Archive traversal and object-store path escape are rejected.
- GitHub intake requires a repository installation and an explicit authorization attestation.

## Configuration

All options are documented in [`.env.example`](.env.example). The most important groups are below.

### Required core settings

| Variable | Purpose | Local default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://cybercheck:cybercheck_dev@localhost:5433/cybercheck` |
| `BETTER_AUTH_SECRET` | Session signing secret; use 32+ random characters | None; must be set |
| `BETTER_AUTH_URL` | Public authentication base URL | `http://localhost:3000` |
| `WEB_ORIGIN` | Allowed browser origin | `http://localhost:3000` |
| `API_PORT` | API listener port | `4000` |
| `API_INTERNAL_URL` | API target used by Next.js rewrites | `http://127.0.0.1:4000` |

### Optional integrations

| Variables | Enables |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG` | GitHub sign-in and read-only repository import |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Delivery of email verification codes |
| `NEBIUS_API_KEY`, `NEBIUS_PROJECT_ID` | Nemotron and other Token Factory models, and isolated sandbox execution |
| `GEMINI_API_KEY` | Optional Gemini alternative for the author, triage and critic roles |
| `OBJECT_STORE_DIR` | Override the local artifact-store directory |
| `TESTING_WORKER_CONCURRENCY` | Maximum concurrently claimed worker jobs; default `2` |

### Provider and budget controls

- `UNDERSTANDING_AI_PROVIDER` chooses `auto`, `nebius`, or `gemini`.
- `TESTING_AI_PROVIDER` chooses the model provider for Testing specialists independently of the execution sandbox.
- `AI_RUN_BUDGET_USD` and `TESTING_RUN_BUDGET_USD` cap model spend per run.
- Model names are configurable so the system can evolve without changing orchestration code: `TESTING_MODEL_AUTHOR`, `TESTING_MODEL_TRIAGE`, `TESTING_MODEL_CRITIC` and `NEBIUS_MODEL_FAST`, `NEBIUS_MODEL_STRONG`, `NEBIUS_MODEL_CRITIC` (defaults: Nemotron 3 Super, Nemotron 3 Ultra, GLM-5.3).
- `CC_LIVE_MODEL_*` variables are reserved for a future isolated live-model sidecar. Setting them does **not** enable live evaluation; the implementation fails closed until credential and network isolation can be guaranteed.

## Testing and evaluation

cybercheck tests both the product and the quality of its check engines.

### Standard quality gates

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

### Browser end-to-end tests

```powershell
npx playwright install chromium
npm run test:e2e -w @cybercheck/web
```

The web Playwright configuration starts the required local services for the suite. Tests cover dashboard navigation, project/check experiences, and critical user flows.

### Engine benchmark suites

```powershell
npm run eval:understanding -w @cybercheck/api
npm run eval:testing -w @cybercheck/api
npm run eval:security -w @cybercheck/api
npm run eval:ai -w @cybercheck/api
npm run eval:adversarial -w @cybercheck/api
```

The repository contains positive fixtures, clean controls, holdouts, and frozen expected reports. Important scoring rules include:

- high/critical precision must remain high rather than inflating the demo with false positives;
- clean controls must not produce severe findings;
- critical obligations must reach decisive evidence or be reported honestly as blocked/inconclusive;
- reports must state numerator and denominator, not unsupported “secure” percentages;
- AI judges cannot override deterministic failures and must pass calibration before resolving subjective cases;
- repair success requires reproduction before the change and replay after it.

### Demo fixture verification

```powershell
npm run verify:demo --prefix test-projects/hackathon-demo-store
```

This command intentionally exits successfully only when the fixture still contains the expected planted failures and exploitable synthetic paths. It protects the video demonstration from accidental “fixes” before recording.

## Security model

### Tenant and identity controls

- The web middleware performs an optimistic cookie check for user experience only.
- The API validates the real session and workspace membership on every protected request.
- Projects, snapshots, runs, findings, reviews, repairs, and artifacts are resolved through tenant-owned records.
- GitHub import is read-only and requires an installation scoped by the repository owner.

### Untrusted source controls

- Uploaded content is size-bounded, normalized, and path-validated.
- Snapshot content is addressed by digest and treated as immutable.
- Dependency installation and project commands occur in disposable sandboxes, not the API process.
- Runtime checks use synthetic identities, configuration, and test data.
- Network access is disabled by default during assessment steps and enabled only for explicit preparation/retry cases.
- Sandboxes impose time, process, CPU, memory, and output limits where supported.
- Repair attempts start from a fresh baseline and have a bounded attempt count.

### Evidence and AI controls

- A model response is never treated as runtime proof.
- Structured output is schema-validated before it enters a plan or report.
- Proposed routes, identities, tools, campaigns, and citations are checked against discovered project facts.
- Independent critics review high-value or ambiguous AI-generated claims.
- Secrets and personal data are redacted from prompts and user-facing evidence where applicable.
- Model calls have timeouts, role-specific models, token limits, and financial budgets.
- Cancellation and worker fencing prevent stale executors from publishing late results.

### Responsible use

Run security and adversarial checks only against projects and environments you are authorized to assess. Keep test data synthetic. Stop a campaign if it reaches unexpected real data or an out-of-scope system. A clean report means “no issue was proven within the completed scope,” never “the system cannot be hacked.”

If you discover a vulnerability in cybercheck itself, do not include live credentials or personal data in a public issue. Contact the project owner privately and provide the minimum reproducible evidence.

## API map

The browser normally calls these routes through the Next.js same-origin proxy. The list below is a contributor map, not a substitute for server-side authorization.

| Area | Representative routes |
|---|---|
| Health and identity | `GET /v1/health`, `GET /v1/me`, `/api/auth/*` |
| Projects and snapshots | `GET/POST /v1/workspaces/:wid/projects`, `GET /v1/projects/:id`, `POST /v1/projects/:id/snapshots/archive` |
| GitHub import | `GET /v1/github/status`, repository/branch discovery, `POST /v1/projects/:id/snapshots/github` |
| Understanding | `GET /v1/snapshots/:id/understanding`, rerun, export, and scoped file-view routes |
| Testing | Start/preview, list/get runs, events, cancel, rerun, export, reviewed report, artifacts, repair and approval routes |
| Security | Runtime status, start/list/get runs, events, cancel, rerun, export, reviews, repairs and approvals |
| AI Evaluator | Dataset upload/list, runtime status, start/list/get runs, events, cancel, rerun and export |
| AI Adversarial | Start/list/get runs, events, cancel, rerun, export, reviews, repairs and approvals |

Event endpoints accept an `after` cursor so the UI can resume without replaying the entire history.

## Current limitations

Hackathon credibility depends on saying what is **not** finished:

- Full Testing execution currently requires Nebius Sandboxes; it does not fall back to local Docker.
- Security, AI Evaluator, and AI Adversarial can use supported local Docker fallbacks, but capability and isolation differ from Nebius. Missing runtime support becomes an explicit blocked or analysis-only result.
- Intake uses an in-process concurrency queue; check execution is durable in PostgreSQL, but snapshot intake interrupted by an API restart must be uploaded again.
- The artifact store is local disk. Multi-host production deployment requires an S3-compatible implementation and lifecycle policy.
- Stack detection is broader than runtime execution support. The first-class sandbox path targets Node.js/TypeScript and Python projects.
- AI Evaluator needs a discoverable AI surface and suitable cases. Non-AI projects correctly receive `NOT_APPLICABLE`.
- Live third-party-model evaluation remains intentionally disabled until the target application can be isolated from both provider credentials and unrestricted outbound networking.
- Generated checks can misunderstand application intent. They are validated, cited, executed, independently reviewed when needed, and labeled with limitations, but human review remains important.
- No automated assessment proves the absence of defects or vulnerabilities.

## Roadmap

1. Replace local artifact storage with encrypted S3-compatible storage and retention controls.
2. Make intake resumable through the same durable job mechanism as checks.
3. Add more sandbox/runtime adapters while preserving the existing isolation contract.
4. Add a trusted live-model sidecar for AI evaluation with scoped credentials and egress allowlists.
5. Expand accessibility, performance, migration, queue, and recovery testing templates.
6. Add CI status checks and signed patch export to the GitHub App workflow.
7. Publish benchmark dashboards and versioned engine release notes.
8. Add organization policy packs and reusable rules-of-engagement templates.

## Troubleshooting

### `Invalid environment configuration`

Confirm `.env` exists at the repository root, `DATABASE_URL` is a valid URL, and `BETTER_AUTH_SECRET` contains at least 32 characters.

### Database connection refused

```powershell
npm run db:up
docker compose ps
npm run db:migrate -w @cybercheck/api
```

The expected host port is `5433`, not PostgreSQL's usual `5432`.

### I cannot receive a verification email

When SMTP credentials are absent, the API prints the verification code to its terminal. Use that code in the browser.

### A check stays queued

The worker must be running. `npm run dev` starts it automatically. In separate-process mode, run:

```powershell
npm run worker -w @cybercheck/api
```

### Testing says Nebius is not configured

Set both `NEBIUS_API_KEY` and `NEBIUS_PROJECT_ID`, then restart the worker. Model access and sandbox access are separate concerns; Testing still requires the sandbox even if Gemini is selected for AI roles.

### A security or AI run is analysis-only

Install and start Docker for supported local fallback, or configure Nebius. cybercheck intentionally reports missing execution capability instead of presenting static analysis as a completed runtime assessment.

### The build or browser suite cannot start

Verify Node 24+, run `npm ci`, install Chromium with `npx playwright install chromium`, and ensure ports `3000`, `4000`, and `5433` are free.

## Contributing

When extending an engine:

1. Add or update the shared Zod contract first.
2. Keep project facts separate from AI interpretation.
3. Define the obligation and what counts as decisive evidence.
4. Add a vulnerable fixture and a clean negative control.
5. Preserve `blocked`, `inconclusive`, and `not_applicable`; never convert missing evidence into a pass.
6. Add tests for tenant scoping, cancellation, and failure recovery where relevant.
7. Update the frozen benchmark only after reviewing the semantic report diff.
8. Document any new environment variable, external service, or trust boundary.

Before opening a change, run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

---

## License

cybercheck is open source under the [MIT License](LICENSE).

---

**cybercheck is built to make software assurance understandable:** one project model, four specialized checks, reproducible evidence, honest uncertainty, and fixes that must prove themselves.
