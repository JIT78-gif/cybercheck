import { routeKey } from "./scenarios.ts";

// The order AI-written checks are authored in (the review of rounds 43 to 45): the most important work first, so a
// later step can never starve an earlier one of the authoring share. Steps in one tier run in parallel; a tier starts
// only after the one before it has finished. A step that is skipped or cut short is reported, never silent.

export type AuthoringStep = { name: string; status: "done" | "partial" | "skipped"; reason?: string };
export type AuthoringBudget = {
  /** The authoring share of the run's AI budget, in USD (Infinity when there is none). */
  shareUsd: number;
  /** What authoring has spent so far. */
  spent: () => number;
  /** How many authoring calls the gateway has refused so far for lack of budget. */
  refused: () => number;
};

/** Below this part of the share left, a later tier is not started: one call could not finish within it. */
export const MIN_SHARE_LEFT = 0.1;

const usd = (n: number) => `$${n.toFixed(3)}`;

export async function authorInOrder(budget: AuthoringBudget, tiers: Array<Array<{ name: string; run: () => Promise<void> }>>): Promise<AuthoringStep[]> {
  const out: AuthoringStep[] = [];
  const done = () => out.filter((s) => s.status !== "skipped").map((s) => s.name);
  for (const [i, tier] of tiers.entries()) {
    if (!tier.length) continue;
    const left = budget.shareUsd - budget.spent();
    // The first tier always starts: it is what the run most needs.
    if (i > 0 && left < MIN_SHARE_LEFT * budget.shareUsd) {
      const after = done();
      for (const s of tier) out.push({ name: s.name, status: "skipped", reason: `the authoring share (${usd(budget.shareUsd)}) was used up${after.length ? ` after ${after.join(", ")}` : ""}` });
      continue;
    }
    const refusedBefore = budget.refused();
    await Promise.all(tier.map((s) => s.run()));
    const refused = budget.refused() - refusedBefore;
    for (const s of tier) out.push(refused ? { name: s.name, status: "partial", reason: `${refused} AI call(s) in this step were refused: the authoring share (${usd(budget.shareUsd)}) or the run's budget was used up` } : { name: s.name, status: "done" });
  }
  return out;
}

/** Endpoints no requirement scenario sends a request to come first, so ordinary probes fill the gaps before repeating them. */
export function gapsFirst<T extends { method: string; path: string }>(targets: T[], proposals: unknown[]): T[] {
  // Proposals are unchecked AI output: anything that is not a list of requests covers nothing.
  const requestsOf = (p: unknown) => {
    const r = (p as { requests?: unknown } | null)?.requests;
    return Array.isArray(r) ? (r as Array<{ method?: unknown; path?: unknown } | null>) : [];
  };
  const covered = new Set(proposals.flatMap((p) => requestsOf(p).flatMap((r) => (typeof r?.method === "string" && typeof r.path === "string" ? [routeKey(r.method, r.path)] : []))));
  const gap = (t: T) => (covered.has(routeKey(t.method, t.path)) ? 1 : 0);
  return [...targets].sort((a, b) => gap(a) - gap(b));
}
