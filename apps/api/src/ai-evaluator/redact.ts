import type { AiEvaluationRunDetail } from "@cybercheck/contracts";
import { redactDeep, redactSecrets } from "../understanding/source.ts";

// What leaves the engine (stored samples, exports, the UI) never carries credentials, tokens, cybercheck's canary
// values or long private responses. Canaries are synthetic markers cybercheck plants (prefix CCAI-); a report says
// which kind of canary appeared, never its value, so a report cannot be used to replay the test.

export const CANARY_PREFIX = "CCAI";
const CANARY_RE = /CCAI-([A-Z]+)-[\w-]+/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g;

/** Redact one text: secrets, bearer/basic credentials, JWTs, canary values, and any extra values given. */
export function redactText(text: string, extra: string[] = [], max = 2000): string {
  let out = redactSecrets(text).text.replace(BEARER_RE, "$1 [hidden]").replace(JWT_RE, "[token]").replace(CANARY_RE, "[canary:$1]");
  for (const v of extra) if (v && v.length >= 6) out = out.split(v).join("[hidden]");
  return out.length > max ? `${out.slice(0, max)}… [truncated ${out.length - max} characters]` : out;
}

const deep = <T>(v: T, extra: string[]): T => {
  if (typeof v === "string") return redactText(v, extra, 100_000) as T;
  if (Array.isArray(v)) return v.map((x) => deep(x, extra)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, extra)])) as T;
  return v;
};

/** A run as it may be shown or exported. */
export function redactAiRun(run: AiEvaluationRunDetail, extra: string[] = []): AiEvaluationRunDetail {
  return deep(redactDeep(run), extra);
}
