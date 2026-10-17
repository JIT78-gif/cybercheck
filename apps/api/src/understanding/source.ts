import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import tar from "tar-stream";
import type { ObjectStore } from "../storage/object-store.ts";

/** A text file from a frozen snapshot. Content is data, never instructions. */
export type SourceFile = { path: string; text: string; lines: number };

export type SnapshotSource = {
  files: Map<string, SourceFile>;
  /** Every path stored in the snapshot (including skipped ones), for structure and test mapping. */
  allPaths: string[];
  /** Stored but not read: path -> reason (one of SKIP). */
  skipped: Map<string, string>;
  /** Left out at intake and never stored (secret files): path -> reason. Counted in coverage. */
  excluded: Map<string, string>;
};

/** Why a stored file was not read. Used verbatim in coverage. */
export const SKIP = {
  secret: "secret file (never read)",
  notText: "not a source or config file",
  tooLarge: "larger than 512 KB",
  budget: "analysis size budget reached",
  binary: "binary content",
} as const;

const MAX_TEXT_FILE = 512 * 1024;
const MAX_TOTAL_TEXT = 150 * 1024 * 1024;

/** Files whose content is never read or shown (credentials, keys, local env). */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|\.npmrc|\.pypirc|id_[rd]sa|id_ecdsa|id_ed25519|credentials\.json|service-account[\w.-]*\.json|[\w.-]+\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;
const DOC_ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/i;

const TEXT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|json|jsonc|ya?ml|toml|cfg|ini|prisma|sql|graphql|gql|md|txt|html|vue|svelte|astro|tf|hcl|sh|env\.example|lock)$/i;
const TEXT_NAMES = /(^|\/)(Dockerfile(\.[\w-]+)?|Containerfile|Procfile|Makefile|Caddyfile|[\w.-]+\.conf|\.dockerignore|\.gitignore|requirements[\w.-]*\.txt|Pipfile|\.env\.(example|sample|template)|Gemfile|go\.mod|\.nvmrc|\.python-version|\.tool-versions)$/i;
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock|bun\.lockb?)$|\.min\.(js|css)$|\.map$/i;

export function isSecretFile(path: string) {
  return SECRET_FILE.test(path);
}

/** Decide whether a stored file is read, before looking at its bytes. */
function skipReason(path: string, size: number, total: number): string | null {
  if (isSecretFile(path)) return SKIP.secret;
  if (!TEXT_EXT.test(path) && !TEXT_NAMES.test(path)) return SKIP.notText;
  if (size > MAX_TEXT_FILE) return SKIP.tooLarge;
  if (total + size > MAX_TOTAL_TEXT) return SKIP.budget;
  return null;
}

/** Builds a SnapshotSource with the same rules for the archive loader, tests and evaluation. */
class SourceBuilder {
  readonly src: SnapshotSource = { files: new Map(), allPaths: [], skipped: new Map(), excluded: new Map() };
  private total = 0;
  /** Records the path; returns false when its content should not be read. */
  wants(path: string, size: number) {
    this.src.allPaths.push(path);
    const reason = skipReason(path, size, this.total);
    if (reason) this.src.skipped.set(path, reason);
    return !reason;
  }
  add(path: string, buf: Buffer) {
    if (buf.includes(0)) {
      this.src.skipped.set(path, SKIP.binary);
      return;
    }
    this.total += buf.length;
    const text = buf.toString("utf8");
    this.src.files.set(path, { path, text, lines: text.split("\n").length });
  }
}

/** Read the snapshot's normalized archive and keep the text files we can analyse. */
export async function loadSnapshotSource(store: ObjectStore, archiveKey: string): Promise<SnapshotSource> {
  const b = new SourceBuilder();
  const extract = tar.extract();
  const reading = pipeline(store.get(archiveKey), createGunzip(), extract);
  for await (const entry of extract) {
    if (!b.wants(entry.header.name, entry.header.size ?? 0)) {
      entry.resume();
      continue;
    }
    b.add(entry.header.name, await buffer(entry));
  }
  await reading;
  return b.src;
}

/** In-memory snapshot from path -> content (tests, fixtures and evaluation). */
export function sourceFromFiles(files: Record<string, string | Buffer>, excluded: Record<string, string> = {}): SnapshotSource {
  const b = new SourceBuilder();
  for (const [path, data] of Object.entries(files)) {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (b.wants(path, buf.length)) b.add(path, buf);
  }
  for (const [path, reason] of Object.entries(excluded)) b.src.excluded.set(path, reason);
  return b.src;
}

/** Small LRU of recently loaded snapshots (the code viewer reads the same snapshot repeatedly). */
const cache = new Map<string, Promise<SnapshotSource>>();
const CACHE_SIZE = 3;

export function getSnapshotSource(store: ObjectStore, archiveKey: string): Promise<SnapshotSource> {
  const hit = cache.get(archiveKey);
  if (hit) {
    cache.delete(archiveKey);
    cache.set(archiveKey, hit);
    return hit;
  }
  const p = loadSnapshotSource(store, archiveKey).catch((err) => {
    cache.delete(archiveKey);
    throw err;
  });
  cache.set(archiveKey, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}

export function isGenerated(path: string) {
  return GENERATED.test(path);
}

export function isEnvExample(path: string) {
  return DOC_ENV_EXAMPLE.test(path);
}

// ---------- Redaction ----------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /((?:password|passwd|secret|api[_-]?key|token|auth)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi,
];

/** Replace secret-looking strings. Returns the redacted text and how many were replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...m: string[]) => {
      count += 1;
      // Keep the key name for "key = 'value'" patterns so the line stays readable.
      return m.length > 4 && typeof m[1] === "string" && typeof m[3] === "string" && (m[0] ?? "").includes(m[2]!)
        ? `${m[1]}[redacted]${m[3]}`
        : "[redacted]";
    });
  }
  return { text: out, count };
}

/**
 * Redact every string inside a value before it is serialized. Redacting serialized JSON can swallow an
 * escaped quote and leave invalid JSON, so structured data is redacted field by field instead.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

/** Redact text that may be JSON: field by field when it parses, as plain text when it does not. */
export function redactJsonText(text: string): string {
  try {
    return JSON.stringify(redactDeep(JSON.parse(text)), null, 2);
  } catch {
    return redactSecrets(text).text;
  }
}

/** For .env.example-style files: keep variable names, drop values. */
export function envExampleNames(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  text.split("\n").forEach((l, i) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) out.push({ name: m[1]!, line: i + 1 });
  });
  return out;
}
