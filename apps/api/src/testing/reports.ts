import type { TestCaseResult } from "@cybercheck/contracts";

/** Results parsed from one suite execution. `source` says how much to trust the numbers. */
export type ParsedSuite = {
  source: "report" | "log_summary" | "none";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCaseResult[];
  /** Failure detail per failed case (assertion message and the first stack lines), bounded. */
  failures: Array<{ name: string; file: string | null; detail: string }>;
};

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]!) : null;
};
const clip = (s: string, n = 1800) => (s.length > n ? `${s.slice(0, n)}\n[...]` : s);

/** JUnit XML from vitest, node:test, mocha, pytest and jest-junit. Tolerant, no XML library. */
export function parseJunit(xml: string): ParsedSuite {
  const cases: TestCaseResult[] = [];
  const failures: ParsedSuite["failures"] = [];
  // Attribute values may contain an unescaped ">" (node:test writes names like "POST /todos > creates"), so quoted values are skipped whole.
  const re = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const head = m[1]!;
    const body = m[3] ?? "";
    const name = attr(head, "name") ?? "(unnamed test)";
    const classname = attr(head, "classname");
    const file = attr(head, "file") ?? (classname && /[\\/]|\.(t|j)sx?$|\.py$/.test(classname) ? classname : null);
    const time = Number(attr(head, "time"));
    const failed = /<(failure|error)\b/.test(body) || attr(head, "failure") != null;
    const skipped = /<skipped\b/.test(body);
    const status: TestCaseResult["status"] = failed ? (/<error\b/.test(body) && !/<failure\b/.test(body) ? "error" : "failed") : skipped ? "skipped" : "passed";
    const fm = body.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/);
    const message = fm ? unescape(attr(fm[2] ?? fm[5] ?? "", "message") ?? "") : null;
    const full = classname && !file && classname !== name ? `${classname} > ${name}` : name;
    cases.push({ name: full, file, status, durationMs: Number.isFinite(time) ? Math.round(time * 1000) : null, message: message ? clip(message, 300) : null });
    if (failed) failures.push({ name: full, file, detail: clip(unescape((fm?.[3] ?? message ?? "").trim())) });
  }
  // node:test reports a file-level case that only says "test failed" when an inner test fails; drop it if inner cases exist.
  return summarize(cases, failures, "report");
}

type JestJson = { numTotalTests?: number; testResults?: Array<{ name?: string; message?: string; assertionResults?: Array<{ fullName?: string; title?: string; status?: string; duration?: number | null; failureMessages?: string[] }> }> };

export function parseJestJson(text: string): ParsedSuite {
  const j = JSON.parse(text) as JestJson;
  const cases: TestCaseResult[] = [];
  const failures: ParsedSuite["failures"] = [];
  for (const file of j.testResults ?? []) {
    const path = file.name ?? null;
    const asserts = file.assertionResults ?? [];
    if (asserts.length === 0 && file.message) {
      // The file failed to load (syntax error, missing module): one failed case for it.
      cases.push({ name: `${path ?? "test file"} (failed to load)`, file: path, status: "error", durationMs: null, message: clip(file.message, 300) });
      failures.push({ name: `${path ?? "test file"} (failed to load)`, file: path, detail: clip(file.message) });
    }
    for (const a of asserts) {
      const name = a.fullName ?? a.title ?? "(unnamed test)";
      const status: TestCaseResult["status"] = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      const msg = (a.failureMessages ?? []).join("\n");
      cases.push({ name, file: path, status, durationMs: a.duration ?? null, message: msg ? clip(msg, 300) : null });
      if (status === "failed") failures.push({ name, file: path, detail: clip(msg) });
    }
  }
  return summarize(cases, failures, "report");
}

function summarize(cases: TestCaseResult[], failures: ParsedSuite["failures"], source: ParsedSuite["source"]): ParsedSuite {
  // A suite-level wrapper case ("a.test.js" with failure "test failed") duplicates its children.
  const wrapper = (c: TestCaseResult) => c.message === "test failed" && (/.[cm]?[jt]sx?$/.test(c.name) || c.file === null);
  const real = cases.filter((c) => !(wrapper(c) && cases.some((o) => o !== c && o.status === "failed" && !wrapper(o))));
  const count = (s: TestCaseResult["status"]) => real.filter((c) => c.status === s).length;
  return { source, total: real.length, passed: count("passed"), failed: count("failed") + count("error"), skipped: count("skipped"), cases: real, failures: failures.filter((f) => real.some((c) => c.name === f.name)) };
}

/** Last resort for suites we can't attach a reporter to: read the runner's own summary line. */
export function parseLogSummary(log: string): ParsedSuite {
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp) => {
    const m = plain.match(re);
    return m ? Number(m[1]) : 0;
  };
  const tryOne = (): Omit<ParsedSuite, "cases" | "failures" | "source"> | null => {
    // vitest: "Tests  1 failed | 9 passed (10)"
    let m = plain.match(/Tests\s+((?:\d+\s+\w+\s*\|?\s*)+)\((\d+)\)/);
    if (m) return { total: Number(m[2]), failed: num(/Tests\s+.*?(\d+)\s+failed/), passed: num(/Tests\s+.*?(\d+)\s+passed/), skipped: num(/Tests\s+.*?(\d+)\s+skipped/) };
    // jest: "Tests:       1 failed, 9 passed, 10 total"
    m = plain.match(/Tests:\s+.*?(\d+)\s+total/);
    if (m) return { total: Number(m[1]), failed: num(/Tests:\s+.*?(\d+)\s+failed/), passed: num(/Tests:\s+.*?(\d+)\s+passed/), skipped: num(/Tests:\s+.*?(\d+)\s+skipped/) };
    // node:test: "# tests 3 ... # pass 2 ... # fail 1"
    if (/^# tests \d+/m.test(plain)) return { total: num(/^# tests (\d+)/m), passed: num(/^# pass (\d+)/m), failed: num(/^# fail (\d+)/m), skipped: num(/^# skipped (\d+)/m) };
    // mocha: "9 passing", "1 failing"
    if (/\d+ passing/.test(plain)) {
      const p = num(/(\d+) passing/), f = num(/(\d+) failing/), s = num(/(\d+) pending/);
      return { total: p + f + s, passed: p, failed: f, skipped: s };
    }
    // pytest: "1 failed, 7 passed in 0.12s"
    m = plain.match(/=+ (.*?) in [\d.]+s/);
    if (m && /passed|failed|error/.test(m[1]!)) {
      const p = num(/(\d+) passed/), f = num(/(\d+) failed/) + num(/(\d+) errors?/), s = num(/(\d+) skipped/);
      return { total: p + f + s, passed: p, failed: f, skipped: s };
    }
    if (/No test files found|no tests ran|collected 0 items/i.test(plain)) return { total: 0, passed: 0, failed: 0, skipped: 0 };
    return null;
  };
  const r = tryOne();
  return r ? { ...r, source: "log_summary", cases: [], failures: [] } : { source: "none", total: 0, passed: 0, failed: 0, skipped: 0, cases: [], failures: [] };
}

/** Test names that a runner printed as passed or failed in its log before it stopped (for timeouts). */
export function progressFromLog(log: string): { passed: string[]; failed: string[] } {
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  const passed: string[] = [];
  const failed: string[] = [];
  for (const line of plain.split("\n")) {
    const ok = line.match(/^\s*(?:✓|√|✔|ok \d+ -)\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$/);
    const bad = line.match(/^\s*(?:×|✗|✖|not ok \d+ -)\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$/);
    if (ok) passed.push(ok[1]!.trim());
    else if (bad) failed.push(bad[1]!.trim());
  }
  return { passed, failed };
}
