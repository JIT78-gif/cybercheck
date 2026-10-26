import type { AdversarialCampaign, AdversarialDecision, AdversarialFinding, AdversarialReport } from "@cybercheck/contracts";

// The plain-language layer for AI Adversarial results. It turns engine terms (failed, passed, blocked, lanes,
// techniques, oracles) into language a business owner can act on, and derives the counters, categories, blocked-attack
// groups and "what to do next" list the results page needs. Kept separate from the view so the comprehension tests and
// the UI share exactly the same wording.

export type Tone = "good" | "bad" | "warn" | "muted" | "info";

// Defence in depth: runtime notes are already masked server-side, but the UI never renders a raw credential, token or
// canary. This strips the common secret shapes from any runtime text before it is shown.
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{6,}/g, /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, /\bCC[A-Z]*(?:MARK|CANARY)[-_][A-Za-z0-9]+/g, /\b[A-Za-z0-9+/_=-]{40,}/g];
export function redactText(s: string): string {
  let out = s;
  for (const re of SECRET_SHAPES) out = out.replace(re, "[redacted]");
  return out;
}

/** A campaign's user-facing status. `ran` distinguishes "we tested it" from "we could not test it". */
export const STATUS: Record<AdversarialCampaign["status"], { label: string; tone: Tone; ran: boolean; meaning: string }> = {
  failed: { label: "Vulnerability found", tone: "bad", ran: true, meaning: "The attack succeeded and exposed a real weakness." },
  passed: { label: "Protected in this test", tone: "good", ran: true, meaning: "The attack ran in full and the application resisted it." },
  blocked: { label: "Could not test", tone: "warn", ran: false, meaning: "The attack could not be sent, so this is not a safety result." },
  inconclusive: { label: "Result unclear", tone: "warn", ran: true, meaning: "The attack ran but did not reach a clear yes or no." },
  planned: { label: "Not started", tone: "muted", ran: false, meaning: "The attack was planned but has not run yet." },
  running: { label: "In progress", tone: "info", ran: false, meaning: "The attack is running now." },
};

export const DECISION: Record<AdversarialDecision, { label: string; tone: Tone }> = {
  not_applicable: { label: "Not relevant to this project", tone: "muted" },
  ready_with_evidence: { label: "Looks good in this test", tone: "good" },
  not_ready_adversarial_findings: { label: "Not ready to release", tone: "bad" },
  not_ready_insufficient_evidence: { label: "Not enough was tested", tone: "warn" },
  not_ready_environment_blocked: { label: "Could not run the test", tone: "warn" },
};

type CategoryKey = "signin" | "admin" | "customer-data" | "business" | "injection" | "dos" | "chains" | "ai";
export const CATEGORY: Record<CategoryKey, { title: string; blurb: string }> = {
  signin: { title: "Sign-in and account takeover", blurb: "Can an attacker break into accounts or forge a login?" },
  admin: { title: "Administrator access", blurb: "Can an ordinary user reach administrator-only features?" },
  "customer-data": { title: "Access to another customer's data", blurb: "Can one customer read or change another customer's records?" },
  business: { title: "Orders, payments and business rules", blurb: "Can an attacker abuse money, bookings or business logic?" },
  injection: { title: "Injection and unsafe input", blurb: "Can crafted input reach the database or break the app?" },
  dos: { title: "Denial of service and resource abuse", blurb: "Can an attacker overload the service with repeated requests?" },
  chains: { title: "Multi-step attack chains", blurb: "Can several smaller weaknesses be combined into a full break-in?" },
  ai: { title: "AI assistant manipulation", blurb: "Can the AI assistant be tricked into unsafe actions or disclosures?" },
};
export const CATEGORY_ORDER: CategoryKey[] = ["signin", "admin", "customer-data", "business", "injection", "dos", "chains", "ai"];

type Meta = { name: string; category: CategoryKey; explanation: string; attempted: string; expected: string };
/** Friendly description per attack technique. Falls back to the lane when a technique is not listed. */
const TECHNIQUE: Record<string, Meta> = {
  "function-authz": { name: "Ordinary user tried to open an administrator page", category: "admin", explanation: "A normal customer account tried to use an administrator-only feature.", attempted: "Sign in as a normal customer and call an administrator-only endpoint.", expected: "The application should refuse the request for anyone who is not an administrator." },
  "escalate-to-admin-action": { name: "Ordinary user tried to change an administrator setting", category: "admin", explanation: "A normal customer tried to make a privileged change reserved for administrators.", attempted: "Sign in as a customer and send a privileged change to an administrator endpoint.", expected: "The application should reject privileged changes from non-administrators." },
  "mass-assignment": { name: "User tried to grant itself a privileged field", category: "admin", explanation: "A customer tried to set a protected field (such as its own role) that only the system should control.", attempted: "Send a normal update that also includes a privileged field like \"role\": \"admin\".", expected: "The application should ignore fields the caller is not allowed to set." },
  "token-forgery": { name: "Attacker forged a login token", category: "signin", explanation: "An attacker tampered with a login token to pretend to be an administrator.", attempted: "Take a normal token, change the role to administrator, and reuse it.", expected: "The application should reject any token that was tampered with." },
  "login-throttling": { name: "Attacker guessed passwords repeatedly", category: "signin", explanation: "An attacker tried many passwords quickly to see if sign-in is rate limited.", attempted: "Send many failed sign-in attempts in a row.", expected: "The application should slow down or lock out repeated failed sign-ins." },
  "object-authz": { name: "Customer tried to read another customer's record", category: "customer-data", explanation: "One customer tried to open a record that belongs to a different customer.", attempted: "Sign in as one customer and request another customer's record by its id.", expected: "The application should only return records that belong to the signed-in customer." },
  "cross-tenant-order-read": { name: "Customer tried to read another customer's order", category: "customer-data", explanation: "A customer tried to read an order that belongs to a different account.", attempted: "Request another account's order while signed in as a different customer.", expected: "The application should refuse to return another account's order." },
  "invalid-quantity": { name: "Attacker sent an invalid amount", category: "business", explanation: "An attacker sent a negative or oversized amount to abuse the business rules.", attempted: "Submit a payment or booking with a negative or unrealistic amount.", expected: "The application should reject invalid amounts before changing anything." },
  "duplicate-action": { name: "Attacker replayed the same action twice", category: "business", explanation: "An attacker repeated the same consequential action to see if it applies twice.", attempted: "Send the same request (same key) twice in a row.", expected: "The application should apply a consequential action only once." },
  "race-condition": { name: "Attacker sent simultaneous requests", category: "business", explanation: "An attacker sent many requests at once to try to double-spend or double-book.", attempted: "Fire several copies of the same money or inventory request together.", expected: "The application should never let a value be spent or booked twice." },
  "injection-differential": { name: "Attacker sent crafted input to the database", category: "injection", explanation: "An attacker sent database tricks in a search box to see if the input is treated as code.", attempted: "Send a true clause and a false clause and compare the results.", expected: "Crafted clauses should not change the results, because input is handled as data." },
  "unbounded-requests": { name: "Attacker hammered an expensive page", category: "dos", explanation: "An attacker repeatedly called an expensive endpoint to try to overload the service.", attempted: "Call an expensive endpoint many times quickly.", expected: "The application should bound or rate-limit expensive requests." },
  "direct-prompt-injection": { name: "Attacker tried to override the AI's instructions", category: "ai", explanation: "An attacker sent instructions trying to make the AI ignore its rules.", attempted: "Send a message that tells the assistant to ignore its instructions.", expected: "The assistant should keep following its real instructions." },
  "indirect-rag-injection": { name: "Attacker planted instructions in a document", category: "ai", explanation: "An attacker hid instructions inside a document the AI later reads.", attempted: "Upload a document containing hidden instructions, then ask a question.", expected: "The assistant should treat document content as data, not commands." },
  "system-prompt-leak": { name: "Attacker tried to extract the AI's hidden instructions", category: "ai", explanation: "An attacker tried to make the AI reveal its secret system prompt.", attempted: "Ask the assistant to reveal its hidden instructions or secrets.", expected: "The assistant should never disclose its hidden instructions or secrets." },
  "cross-tenant-memory-leak": { name: "One user tried to read another user's AI memory", category: "customer-data", explanation: "A user tried to read the private AI conversation memory of another user.", attempted: "Read assistant memory while signed in as a different user.", expected: "AI memory should stay private to its owner." },
  "citation-spoofing": { name: "AI cited a document it never read", category: "ai", explanation: "The AI was checked for inventing citations to documents it was not given.", attempted: "Ask a question and check whether the assistant cites a made-up source.", expected: "The assistant should only cite documents it actually retrieved." },
  "unsafe-output-rendering": { name: "AI output ran as code in the browser", category: "injection", explanation: "The AI's reply was checked to see if it can inject active content into the page.", attempted: "Make the assistant return content that a browser might execute.", expected: "The page should display AI output as text, never run it." },
};

const LANE_CATEGORY: Record<string, CategoryKey> = {
  auth_takeover: "signin", broken_access: "admin", data_exposure: "customer-data", identity_tenant: "customer-data",
  business_logic: "business", injection_pivot: "injection", resource_abuse: "dos", resource_concurrency: "dos", multi_stage: "chains",
  prompt: "ai", leakage: "ai", rag_memory: "ai", tools_approval: "ai", mcp_agent: "ai", output_handling: "injection", recon: "admin",
};

export function attackMeta(c: Pick<AdversarialCampaign, "techniqueId" | "lane" | "title">): Meta {
  const t = TECHNIQUE[c.techniqueId];
  if (t) return t;
  const category = LANE_CATEGORY[c.lane] ?? "admin";
  return { name: c.title, category, explanation: c.title, attempted: "Run the planned attack against the target feature.", expected: "The application should resist the attack." };
}

export type Counters = { planned: number; executed: number; vulnerabilities: number; protected: number; couldNotTest: number; unclear: number; coveragePct: number };
export function counters(campaigns: AdversarialCampaign[], accounting?: AdversarialReport["accounting"]): Counters {
  const planned = accounting?.selected ?? campaigns.length;
  const n = (s: AdversarialCampaign["status"]) => campaigns.filter((c) => c.status === s).length;
  const vulnerabilities = n("failed");
  const protectedN = n("passed");
  const unclear = n("inconclusive");
  const couldNotTest = accounting ? accounting.blocked + accounting.compilerRejected : n("blocked") + n("planned") + n("running");
  const executed = accounting?.attempted ?? vulnerabilities + protectedN + unclear;
  return { planned, executed, vulnerabilities, protected: protectedN, couldNotTest, unclear, coveragePct: planned ? Math.round((executed / planned) * 100) : 0 };
}

/** Group attacks that could not run by the real reason, using the setup (identity sign-in) results when they explain it. */
export function blockedGroups(campaigns: AdversarialCampaign[], setup: AdversarialReport["setup"]): Array<{ reason: string; count: number; campaignIds: string[]; setupFailures: AdversarialReport["setup"] }> {
  const blocked = campaigns.filter((c) => c.status === "blocked");
  if (!blocked.length) return [];
  const failedSetup = (setup ?? []).filter((s) => !s.ok);
  const byReason = new Map<string, AdversarialCampaign[]>();
  for (const c of blocked) {
    const raw = c.reason || "The attacker could not establish the campaign prerequisites.";
    const legacyGeneric = /campaign did not run|could not establish the campaign prerequisites/i.test(raw);
    const reason = legacyGeneric && failedSetup.length
      ? `${blocked.length} attack${blocked.length === 1 ? "" : "s"} could not run because Cybercheck could not create or sign in the required synthetic test ${failedSetup.length === 1 ? "account" : "accounts"}.`
      : redactText(raw);
    byReason.set(reason, [...(byReason.get(reason) ?? []), c]);
  }
  return [...byReason].map(([reason, items]) => {
    const relevant = failedSetup.filter((s) => reason.includes(s.name) || reason.includes(s.detail));
    return { reason, count: items.length, campaignIds: items.map((c) => c.id), setupFailures: relevant.length ? relevant : /could not create or sign in/i.test(reason) ? failedSetup : [] };
  });
}

export type NextStep = { priority: "Fix now" | "Fix soon" | "Review manually" | "Rerun after setup is corrected"; tone: Tone; title: string; detail: string; campaignId: string | null };
/** A prioritized, plain-language action list drawn from confirmed findings, unclear results and blocked attacks. */
export function nextSteps(findings: AdversarialFinding[], campaigns: AdversarialCampaign[], setup: AdversarialReport["setup"]): NextStep[] {
  const out: NextStep[] = [];
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const confirmed = findings.filter((f) => f.status === "confirmed");
  const sev = (f: AdversarialFinding) => (f.severity === "critical" ? 0 : f.severity === "high" ? 1 : f.severity === "medium" ? 2 : 3);
  for (const f of [...confirmed].sort((a, b) => sev(a) - sev(b))) {
    const c = f.campaignIds.map((id) => byId.get(id)).find(Boolean);
    const meta = c ? attackMeta(c) : { name: f.title } as ReturnType<typeof attackMeta>;
    const now = f.severity === "critical" || f.severity === "high";
    out.push({ priority: now ? "Fix now" : "Fix soon", tone: now ? "bad" : "warn", title: meta.name, detail: f.remediation, campaignId: f.campaignIds[0] ?? null });
  }
  const failed = (setup ?? []).filter((s) => !s.ok);
  if (campaigns.some((c) => c.status === "blocked") && failed.length) out.push({ priority: "Rerun after setup is corrected", tone: "warn", title: "Repair the test setup before rerunning", detail: `The setup plan must be changed or the project must provide the missing seed, activation, account, or configuration step. Failed: ${failed.map((s) => `${s.name} (${redactText(s.detail)})`).join("; ")}.`, campaignId: null });
  for (const c of campaigns.filter((c) => c.status === "inconclusive")) out.push({ priority: "Review manually", tone: "warn", title: attackMeta(c).name, detail: "This attack ran but the result was unclear. A person should review this feature manually.", campaignId: c.id });
  return out;
}

export const PRIORITY_ORDER: NextStep["priority"][] = ["Fix now", "Fix soon", "Review manually", "Rerun after setup is corrected"];
