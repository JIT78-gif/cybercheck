import { BotMessageSquare, FlaskConical, ShieldCheck, Swords, type LucideIcon } from "lucide-react";
import type { CheckId } from "@cybercheck/contracts";

export type CheckInfo = {
  id: CheckId;
  name: string;
  icon: LucideIcon;
  tagline: string;
  does: string[];
  youGet: string;
  note?: string;
};

export const CHECK_INFO: Record<CheckId, CheckInfo> = {
  testing: {
    id: "testing",
    name: "Testing",
    icon: FlaskConical,
    tagline: "Know exactly what works, and what was never tested.",
    does: [
      "Finds and runs your existing unit, integration, API and end-to-end tests in a clean sandbox",
      "Maps coverage of features and risks, not just lines of code",
      "Flags flaky tests instead of counting them as passes",
    ],
    youGet: "A report with every failure's exact step, input and output, plus a list of untested areas.",
  },
  security: {
    id: "security",
    name: "Security",
    icon: ShieldCheck,
    tagline: "Find the doors attackers would try first.",
    does: [
      "Reviews logins, permissions and account checks on sensitive routes",
      "Detects leaked secrets and vulnerable dependencies",
      "Checks risky configuration and missing security controls",
    ],
    youGet: "Confirmed findings with a safe reproduction, the root cause and the exact file.",
  },
  "ai-evaluator": {
    id: "ai-evaluator",
    name: "AI Evaluator",
    icon: BotMessageSquare,
    tagline: "Make sure your AI does its job and nothing else.",
    does: [
      "Checks that answers reach users and citations match what was retrieved",
      "Tests how the AI copes with provider errors, timeouts and unusual input",
      "Checks every reply for leaked credentials and the system prompt",
      "Runs your own JSONL test cases against the running app",
    ],
    youGet: "Pass rates with the denominator, failing cases with evidence, and suggested guardrails.",
    note: "Only applies to projects that contain an AI model, chatbot, agent or document search.",
  },
  adversarial: {
    id: "adversarial",
    name: "AI Adversarial",
    icon: Swords,
    tagline: "See your app the way an attacker would.",
    does: [
      "Attacks an isolated copy of your app, never your live system",
      "Combines small weaknesses into complete attack chains",
      "Replays the original attack after every fix to prove it's blocked",
    ],
    youGet: "Attack chains with minimum safe evidence, root causes and a replay test for each fix.",
    note: "Runs only inside rules of engagement you approve.",
  },
};

export const CHECK_ORDER: CheckId[] = ["testing", "security", "ai-evaluator", "adversarial"];

/** The API path segment for a check differs from its route/id only for the AI Evaluator (ai-evaluation). Used to build
 *  the per-project run list (`/v1/projects/:id/${slug}-runs`) and cross-project status (`/v1/workspaces/:wid/${slug}-status`). */
export const CHECK_API_SLUG: Record<CheckId, string> = {
  testing: "testing",
  security: "security",
  "ai-evaluator": "ai-evaluation",
  adversarial: "adversarial",
};

/** The web route for one finished (or running) check run. The route segment is the check id itself. */
export const runHref = (check: CheckId, projectId: string, runId: string) => `/app/projects/${projectId}/${check}/${runId}`;
