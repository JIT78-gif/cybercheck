import { createHash } from "node:crypto";
import { AiDatasetCase, AiDatasetExpected, type AiEvaluationTarget, type AiReplayTurn } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";
import type { CaseSpec } from "./catalog.ts";
import { contentProblems } from "./datasets.ts";
import { AI_CATALOG_VERSION } from "./version.ts";

// Repository-derived cases: the project's OWN tests, fake-model fixtures and documentation examples read as a source
// of evaluation cases. Everything here is untrusted input; it can only supply a message, a frozen model reply and an
// expected substring, and it is compiled into the same typed case and grader catalogue as any other case (never into
// executable logic). A case that would carry a command, an external host, a secret or personal data is dropped.

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/i;
const DOC_FILE = /\.m/;
const str = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\]){2,400})\1`;
const strBody = (m: RegExpMatchArray | null) => (m ? m[2]!.replace(/\\(.)/g, "$1").trim() : null);

/** Split a JS/TS test file into blocks: the body of each test()/it() call (approximate, by the next test/it). */
function testBlocks(text: string): Array<{ line: number; name: string; body: string }> {
  const out: Array<{ line: number; name: string; body: string }> = [];
  const starts = [...text.matchAll(/\b(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : Math.min(text.length, from + 4000);
    out.push({ line: text.slice(0, from).split("\n").length, name: starts[i]![2] ?? "", body: text.slice(from, to) });
  }
  return out;
}

const expected = (e: Partial<AiDatasetExpected>) => AiDatasetExpected.parse(e);
const turn = (content: string): AiReplayTurn => ({ content, toolCalls: [], status: null, malformed: false, hang: false });

/** One case from a block of test code that talks to the AI route. */
function fromBlock(block: { line: number; name: string; body: string }, file: string, routeHit: boolean): CaseSpec | null {
  const b = block.body;
  // The user message sent to the assistant.
  const message = strBody(b.match(new RegExp(`\\bask\\(\\s*[^,]+,\\s*${str}`))) ?? strBody(b.match(new RegExp(`\\b(?:message|prompt|question|query|input)\\s*:\\s*${str}`)));
  if (!message || message.length < 2) return null;
  // A frozen model reply the test scripts (content: "...").
  const reply = strBody(b.match(new RegExp(`\\bcontent\\s*:\\s*${str}`)));
  // Positive and negative substring assertions on the reply.
  const contains = [...b.matchAll(new RegExp(`(?<![!])\\b(?:reply|answer|text|body\\.reply|data\\.reply|res\\.reply)\\b[^;\\n]{0,40}?\\.(?:includes|contains|toContain|toMatch)\\(\\s*${str}`, "g"))].map((m) => m[2]!.replace(/\\(.)/g, "$1").trim()).filter((x) => x.length >= 2);
  const excludes = [...b.matchAll(new RegExp(`!\\s*[^;\\n]{0,40}?\\.(?:includes|contains)\\(\\s*${str}`, "g"))].map((m) => m[2]!.replace(/\\(.)/g, "$1").trim()).filter((x) => x.length >= 2);
  if (!contains.length && !excludes.length) return null;
  const e = expected({ contains: contains.slice(0, 5), excludes: excludes.slice(0, 5) });
  const grounding = /\[doc:|cit(e|ation)|refund|retriev|ground|source/i.test(b);
  const sig = createHash("sha256").update(`${file}|${message}|${reply ?? ""}|${contains.join()}|${excludes.join()}`).digest("hex");
  const id = `repo.${file.split("/").pop()!.replace(/[^\w.-]/g, "")}.${block.line}.${sig.slice(0, 8)}`;
  const spec: CaseSpec = {
    id,
    category: grounding ? "grounding" : "functional",
    priority: "medium",
    tags: ["repository"],
    title: `From this project's tests: ${block.name.slice(0, 80) || file.split("/").pop()!}`,
    inputClass: `a ${grounding ? "grounding" : "functional"} case taken from the project's own test "${block.name.slice(0, 60)}"`,
    source: { kind: "repository", datasetId: null, version: AI_CATALOG_VERSION, digest: sig },
    evidence: { path: file, line: block.line },
    message,
    extra: {},
    conversation: [],
    context: [],
    replay: reply ? [turn(reply)] : [],
    expected: e,
    expectedText: `The reply ${[contains.length && `contains ${contains.map((c) => `"${c}"`).join(", ")}`, excludes.length && `avoids ${excludes.map((c) => `"${c}"`).join(", ")}`].filter(Boolean).join(" and ")}, as the project's own test expects.`,
    graders: [
      { id: "reply_present", hard: false },
      ...(contains.length ? [{ id: "contains" as const, hard: true, params: { values: contains } }] : []),
      ...(excludes.length ? [{ id: "excludes" as const, hard: true, params: { values: excludes } }] : []),
    ],
    modes: ["replay", "direct"],
    profiles: ["quick", "standard", "deep"],
    requires: [],
    timeoutMs: 30_000,
  };
  void routeHit;
  return spec;
}

/** Q/A example pairs in documentation ("Ask: ... / Answer: ..."). */
function fromDoc(text: string, file: string): CaseSpec[] {
  const out: CaseSpec[] = [];
  const re = /(?:^|\n)\s*(?:[*>-]\s*)?(?:\*\*)?(?:Q|Question|Ask|User|Prompt)(?:\*\*)?\s*[:.]\s*(.{3,300}?)\s*\n\s*(?:[*>-]\s*)?(?:\*\*)?(?:A|Answer|Response|Assistant|Reply|Bot)(?:\*\*)?\s*[:.]\s*(.{3,400}?)\s*(?:\n\n|\n\s*(?:Q|Question|Ask)|$)/gis;
  for (const m of text.matchAll(re)) {
    const message = m[1]!.replace(/[*`]/g, "").trim();
    const answer = m[2]!.replace(/[*`]/g, "").trim();
    if (message.length < 3 || answer.length < 3) continue;
    const key = answer.split(/[.!?]/)[0]!.trim().slice(0, 80);
    const line = text.slice(0, m.index).split("\n").length;
    const sig = createHash("sha256").update(`${file}|${message}|${answer}`).digest("hex");
    out.push({
      id: `repo.${file.split("/").pop()!.replace(/[^\w.-]/g, "")}.${line}.${sig.slice(0, 8)}`,
      category: "functional",
      priority: "low",
      tags: ["repository", "docs"],
      title: `From the docs: ${message.slice(0, 70)}`,
      inputClass: "a question and answer taken from the project's documentation",
      source: { kind: "repository", datasetId: null, version: AI_CATALOG_VERSION, digest: sig },
      evidence: { path: file, line },
      message,
      extra: {},
      conversation: [],
      context: [],
      replay: [turn(answer)],
      expected: expected({ contains: [key] }),
      expectedText: `The reply reflects the documented answer ("${key}").`,
      graders: [{ id: "reply_present", hard: false }, { id: "contains", hard: true, params: { values: [key] } }],
      modes: ["replay", "direct"],
      profiles: ["quick", "standard", "deep"],
      requires: [],
      timeoutMs: 30_000,
    });
  }
  return out;
}

/** Every repository-derived case, deduped, safe (adversarial or secret-bearing content is dropped) and answer-key clean. */
export function extractRepositoryCases(src: SnapshotSource, opts: { target: AiEvaluationTarget; routePaths: string[] }, max = 40): { cases: CaseSpec[]; limitations: string[] } {
  const routes = opts.routePaths.map((p) => p.replace(/\{[^}]*\}|:\w+/g, "")).filter((p) => p.length >= 3);
  const mentionsRoute = (t: string) => routes.some((r) => t.includes(r)) || /\/(assistant|chat|ai|message|conversation)|\bask\(/i.test(t);
  const out: CaseSpec[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const push = (c: CaseSpec | null) => {
    if (!c || seen.has(c.id) || out.length >= max) return;
    // The project is untrusted: a case that would send a command, an external host, a secret or personal data, or
    // that does not fit the typed case schema, is dropped. The answer key must never reach the application.
    const parsed = AiDatasetCase.safeParse({ id: "repo-check", category: c.category, input: { message: c.message || "x" }, conversation: c.conversation.map((content) => ({ role: "user", content })), context: c.context, expected: { ...c.expected, refusal: c.expected.refusal ?? false }, replay: c.replay });
    if (!parsed.success || contentProblems(parsed.data).length) {
      dropped++;
      return;
    }
    seen.add(c.id);
    out.push(c);
  };
  for (const [path, file] of src.files) {
    if (/node_modules|\.next\/|dist\/|build\//.test(path)) continue;
    if (TEST_FILE.test(path) && /\.[cm]?[jt]sx?$/.test(path) && mentionsRoute(file.text)) {
      for (const block of testBlocks(file.text)) if (mentionsRoute(block.body)) push(fromBlock(block, path, true));
    } else if (DOC_FILE.test(path) && /\.(md|mdx|markdown)$/i.test(path)) {
      for (const c of fromDoc(file.text, path)) push(c);
    }
  }
  const limitations: string[] = [];
  if (out.length) limitations.push("Repository-derived cases use the project's own tests and documentation as the source of truth; their expectations are the project's, not cybercheck's.");
  if (dropped) limitations.push(`${dropped} repository-derived case(s) were dropped because their text contained a command, an external host, a secret or personal data.`);
  return { cases: out, limitations };
}
