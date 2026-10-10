import type { Evidence } from "@cybercheck/contracts";
import { redactSecrets, type SnapshotSource } from "../source.ts";

export type CitedEvidence = { path: string; line: number; symbol: string };
export type Verification = "verified" | "relocated" | "unverified";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The part of a cited symbol worth searching for: identifiers, routes, table names, short phrases. */
function needles(symbol: string): string[] {
  const s = symbol.trim().replace(/^["'`]|["'`]$/g, "");
  if (!s) return [];
  const out = [s];
  // "src/db/schema.ts#leads" or "config.meta.verifyToken" -> also the last part.
  const last = s.split(/[#.:/]/).filter(Boolean).at(-1);
  if (last && last !== s && last.length >= 3) out.push(last);
  // "app.post('/webhook')" -> "/webhook"
  const route = s.match(/["'`](\/[^"'`]+)["'`]/)?.[1];
  if (route) out.push(route);
  return [...new Set(out)].filter((x) => x.length >= 3);
}

/**
 * Check one citation against the frozen snapshot: the file exists and the named symbol appears at
 * (or just after) the cited line. A citation to the wrong line is moved to the symbol's actual line.
 */
export function checkCitation(src: SnapshotSource, e: CitedEvidence): { evidence: Evidence; status: "verified" | "relocated" } | null {
  const path = e.path.replace(/^\.?\//, "");
  const f = src.files.get(path);
  if (!f) return null;
  const lines = f.text.split("\n");
  const keys = needles(e.symbol).map(norm);
  if (!keys.length) return null;
  const at = (i: number) => norm(lines[i] ?? "");
  const line = Math.max(1, Math.min(Math.floor(e.line) || 1, lines.length));
  for (let i = Math.max(0, line - 4); i < Math.min(lines.length, line + 12); i++) {
    if (keys.some((k) => at(i).includes(k))) return { evidence: { path, line: i + 1 }, status: Math.abs(i + 1 - line) <= 3 ? "verified" : "relocated" };
  }
  for (let i = 0; i < lines.length; i++) {
    if (keys.some((k) => at(i).includes(k))) return { evidence: { path, line: i + 1 }, status: "relocated" };
  }
  return null;
}

/** Verify all citations of a claim; the claim keeps only citations that hold. */
export function verifyClaim(src: SnapshotSource, cited: CitedEvidence[]): { evidence: Evidence[]; verification: Verification; checked: number; failed: number } {
  const results = cited.slice(0, 6).map((c) => checkCitation(src, c));
  const ok = results.filter((r): r is NonNullable<typeof r> => Boolean(r));
  const evidence = [...new Map(ok.map((r) => [`${r.evidence.path}:${r.evidence.line}`, r.evidence])).values()];
  const verification: Verification = !ok.length ? "unverified" : ok.every((r) => r.status === "verified") ? "verified" : "relocated";
  return { evidence, verification, checked: results.length, failed: results.length - ok.length };
}

/** Lines around each citation, for the critic. */
export function excerpt(src: SnapshotSource, evidence: Evidence[], radius = 8): string {
  return evidence
    .slice(0, 3)
    .map((e) => {
      const f = src.files.get(e.path);
      if (!f) return "";
      const lines = redactSecrets(f.text).text.split("\n");
      const from = Math.max(1, e.line - radius);
      const to = Math.min(lines.length, e.line + radius);
      return `<file path="${e.path}" lines="${from}-${to}">\n${lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n")}\n</file>`;
    })
    .join("\n");
}
