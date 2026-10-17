import { createHash } from "node:crypto";
import { AI_DATASET_LIMITS, AiDatasetCase, type AiDatasetValidationIssue } from "@cybercheck/contracts";
import { redactSecrets } from "../understanding/source.ts";

// Uploaded AI evaluation datasets: UTF-8 JSONL, one case per line, validated strictly and then frozen. A case that
// breaks a rule rejects the whole upload (nothing is silently dropped or ignored). Uploaded data must be synthetic:
// no external URLs, commands, credentials or real personal data, because cases are sent to the project's AI.

export type DatasetValidation = {
  ok: boolean;
  cases: AiDatasetCase[];
  issues: AiDatasetValidationIssue[];
  /** Canonical JSONL (defaults applied, keys sorted), the frozen artifact. */
  normalized: string;
  digest: string;
  byCategory: Record<string, number>;
};

/** Reserved names (RFC 2606 / 6761) are the only hosts and mail domains a dataset may mention. */
const RESERVED_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|([\w-]+\.)*(example|test|invalid|localhost)|([\w-]+\.)*example\.(com|org|net))$/i;
const URL_RE = /\b(?:https?|ftp|wss?):\/\/([^\s/:?#"'<>]+)/gi;
const EMAIL_RE = /\b[\w.+-]+@([\w-]+(?:\.[\w-]+)+)\b/g;
const COMMANDS: Array<[RegExp, string]> = [
  [/\brm\s+-[rf]{1,2}\b/i, "a file-deleting shell command"],
  [/\b(curl|wget|nc|ncat|netcat|powershell|certutil)\s+\S/i, "a network or shell tool invocation"],
  [/\b(ba|z)?sh\s+-c\b|\|\s*(ba|z)?sh\b/i, "a shell invocation"],
  [/\$\([^)]*\)|`[^`]*\b(cat|ls|id|whoami|uname|env)\b[^`]*`/i, "shell command substitution"],
  [/\b(child_process|subprocess|os\.system|Runtime\.getRuntime|eval\s*\(|exec\s*\(|new\s+Function\s*\()/i, "executable code"],
  [/<\s*script\b|javascript:/i, "executable script markup"],
];
const PII: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/, "a social security number"],
  [/\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}\b|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b/, "a phone number"],
];

/** Card-like digit runs that pass the Luhn check. */
function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** JSON Schema keywords the deterministic grader implements; anything else would be silently ignored, so it is refused. */
const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "const", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "description", "title"]);
function schemaProblems(schema: unknown, at = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${at} must be an object`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(k)) out.push(`${at} uses the unsupported keyword "${k}"`);
    else if (k === "properties" && v && typeof v === "object") for (const [p, s] of Object.entries(v)) out.push(...schemaProblems(s, `${at}.${p}`));
    else if (k === "items") out.push(...schemaProblems(v, `${at}[]`));
    else if (k === "additionalProperties" && typeof v === "object") out.push(...schemaProblems(v, `${at}{*}`));
    else if (k === "pattern" && typeof v === "string") {
      try {
        new RegExp(v);
      } catch {
        out.push(`${at}.pattern is not a valid regular expression`);
      }
    }
  }
  return out;
}

/** Every string inside a value. */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

/** Rule violations in one parsed case (content rules; the schema is already checked). */
export function contentProblems(c: AiDatasetCase): string[] {
  const out: string[] = [];
  const text = strings(c).join("\n");
  for (const m of text.matchAll(URL_RE)) if (!RESERVED_HOST.test(m[1]!)) out.push(`mentions the external host ${m[1]} (only example.com, .test, .example and localhost are allowed)`);
  for (const m of text.matchAll(EMAIL_RE)) if (!RESERVED_HOST.test(m[1]!)) out.push(`contains an email address on ${m[1]} (use example.com or .test addresses)`);
  for (const [re, what] of COMMANDS) if (re.test(text)) out.push(`contains ${what}`);
  for (const [re, what] of PII) if (re.test(text)) out.push(`contains what looks like ${what}`);
  if (hasCardNumber(text)) out.push("contains what looks like a card number");
  if (redactSecrets(text).count) out.push("contains what looks like a credential or secret");
  const e = c.expected;
  if (e.regex !== null) {
    try {
      new RegExp(e.regex);
    } catch {
      out.push("expected.regex is not a valid regular expression");
    }
  }
  if (e.jsonSchema) out.push(...schemaProblems(e.jsonSchema).map((p) => `expected.jsonSchema: ${p}`));
  if (e.citations.some((i) => i >= c.context.length)) out.push("expected.citations points past the end of context");
  if (e.tool !== null && !/^[\w.-]{1,80}$/.test(e.tool)) out.push("expected.tool is not a valid tool name");
  const hasOracle = e.answer !== null || e.contains.length || e.excludes.length || e.regex !== null || e.jsonSchema !== null || e.citations.length || e.tool !== null || e.refusal !== null || e.number !== null;
  if (!hasOracle) out.push("expected defines no behaviour to check");
  if (c.category === "structured_output" && !e.jsonSchema) out.push("a structured_output case needs expected.jsonSchema");
  if (c.category === "fairness" && e.answer === null) out.push("a fairness case needs expected.answer as its explicit rubric reference");
  // The answer key must never be sent to the application.
  const sent = [c.input.message, ...c.conversation.map((t) => t.content), ...Object.values(c.input).filter((v): v is string => typeof v === "string")].join("\n").toLowerCase();
  for (const k of [e.answer, ...e.contains].filter((x): x is string => typeof x === "string" && x.length >= 4)) if (sent.includes(k.toLowerCase())) out.push("the expected answer appears in the input sent to the application");
  return [...new Set(out)];
}

/** Keys sorted at every level, so the same content always has the same digest. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function validateDataset(content: string | Buffer): DatasetValidation {
  const issues: AiDatasetValidationIssue[] = [];
  const fail = (): DatasetValidation => ({ ok: false, cases: [], issues, normalized: "", digest: "", byCategory: {} });
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (bytes.length > AI_DATASET_LIMITS.maxBytes) {
    issues.push({ line: 0, caseId: null, problem: `the file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB` });
    return fail();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    issues.push({ line: 0, caseId: null, problem: "the file is not valid UTF-8" });
    return fail();
  }
  const cases: AiDatasetCase[] = [];
  const seen = new Map<string, number>();
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      issues.push({ line, caseId: null, problem: "not a JSON object (JSONL needs one JSON object per line)" });
      return;
    }
    const id = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string" ? (json as { id: string }).id : null;
    const parsed = AiDatasetCase.safeParse(json);
    if (!parsed.success) {
      for (const e of parsed.error.issues.slice(0, 5)) issues.push({ line, caseId: id, problem: `${e.path.join(".") || "case"}: ${e.message}` });
      return;
    }
    if (seen.has(parsed.data.id)) issues.push({ line, caseId: parsed.data.id, problem: `duplicate case id (first on line ${seen.get(parsed.data.id)})` });
    seen.set(parsed.data.id, line);
    for (const p of contentProblems(parsed.data)) issues.push({ line, caseId: parsed.data.id, problem: p });
    cases.push(parsed.data);
  });
  if (!cases.length && !issues.length) issues.push({ line: 0, caseId: null, problem: "the file has no cases" });
  if (cases.length > AI_DATASET_LIMITS.maxCases) issues.push({ line: 0, caseId: null, problem: `${cases.length} cases; the limit is ${AI_DATASET_LIMITS.maxCases}` });
  if (issues.length) return fail();
  const normalized = cases.map((c) => canonical(c)).join("\n") + "\n";
  const byCategory: Record<string, number> = {};
  for (const c of cases) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  return { ok: true, cases, issues: [], normalized, digest: createHash("sha256").update(normalized).digest("hex"), byCategory };
}

/** A frozen dataset read back from its artifact; the digest must still match or the dataset is refused. */
export function readFrozenDataset(normalized: string, digest: string): AiDatasetCase[] {
  if (createHash("sha256").update(normalized).digest("hex") !== digest) throw new Error("The stored dataset does not match its recorded digest.");
  return normalized.split("\n").filter(Boolean).map((l) => AiDatasetCase.parse(JSON.parse(l)));
}
