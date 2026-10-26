import { createHash } from "node:crypto";
import type { Evidence } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

const words = (text: string) => (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((x) => !/^(const|let|var|final|string|export)$/.test(x));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash prompt n-grams so runtime replies can be compared to protected source context without persisting the prompt or
 *  any embedded secret in the campaign ledger. */
export function protectedPromptFingerprints(src: SnapshotSource, evidence: Evidence[], width = 5): string[] {
  const hashes = new Set<string>();
  for (const ev of evidence) {
    const lines = src.files.get(ev.path)?.text.split("\n") ?? [];
    const sample = lines.slice(Math.max(0, ev.line - 1), ev.line + 4).join(" ");
    const tokens = words(sample);
    for (let i = 0; i + width <= tokens.length; i++) hashes.add(digest(tokens.slice(i, i + width).join(" ")));
  }
  return [...hashes].slice(0, 80);
}

export function countProtectedFingerprintMatches(reply: string, hashes: string[], width = 5): number {
  const expected = new Set(hashes);
  const found = new Set<string>();
  const tokens = words(reply);
  for (let i = 0; i + width <= tokens.length; i++) {
    const hash = digest(tokens.slice(i, i + width).join(" "));
    if (expected.has(hash)) found.add(hash);
  }
  return found.size;
}
