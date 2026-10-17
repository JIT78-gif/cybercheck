import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { parse } from "yaml";
import { db } from "../db/client.ts";
import { sandboxImageCache } from "../db/schema.ts";
import type { SandboxProvider } from "../testing/sandbox/provider.ts";

// The Security tools, installed once in a trusted preparation stage (network on) and cached as a sandbox image.
// Every release is pinned and checked against its own published checksums before it is unpacked; Semgrep is pinned on
// PyPI. Scans then run from this image with the network off. The image is rebuilt each week, so the offline
// vulnerability databases baked into it are never older than that, and their download time is recorded.

export const SECURITY_TOOLS = {
  base: "docker.io/library/python:3.12-bookworm",
  semgrep: "1.95.0",
  // Semgrep 1.95 imports pkg_resources, which newer setuptools no longer ship.
  setuptools: "75.8.0",
  gitleaks: "8.21.2",
  osvScanner: "1.9.1",
  // Releases between 0.26 and 0.69.2 were removed upstream; 0.74.0 is checked against its release checksums.
  trivy: "0.74.0",
} as const;

export const TOOL_ROOT = "/opt/cc-sec";
export const OSV_DB = `${TOOL_ROOT}/osv-db`;
export const TRIVY_CACHE = `${TOOL_ROOT}/trivy-cache`;

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** What the tool image records about itself: exact versions and when the vulnerability data was downloaded. */
export type ToolVersions = { semgrep: string; gitleaks: string; osvScanner: string; trivy: string; osvDatabaseAt: string; trivyChecksAt: string };

/** The install script of the preparation stage. It stops on the first failed download or checksum. */
export function installScript() {
  const T = SECURITY_TOOLS;
  const gh = "https://github.com";
  // The sandbox runs commands with /bin/sh; the script itself needs bash (pipefail).
  return `bash <<'CC_INSTALL'
set -euo pipefail
mkdir -p ${TOOL_ROOT}/bin && cd ${TOOL_ROOT}
verify() { grep -E "$2" "$1" | head -1 | cut -d' ' -f1 > want; sha256sum "$3" | cut -d' ' -f1 > got; cmp -s want got || { echo "checksum mismatch for $3"; exit 1; }; }
python3 -m venv venv
venv/bin/pip install --quiet --no-cache-dir --disable-pip-version-check "semgrep==${T.semgrep}" "setuptools==${T.setuptools}"
curl -fsSL -o gl.tgz ${gh}/gitleaks/gitleaks/releases/download/v${T.gitleaks}/gitleaks_${T.gitleaks}_linux_x64.tar.gz
curl -fsSL -o gl.sums ${gh}/gitleaks/gitleaks/releases/download/v${T.gitleaks}/gitleaks_${T.gitleaks}_checksums.txt
verify gl.sums 'linux_x64\\.tar\\.gz$' gl.tgz && tar xzf gl.tgz --no-same-owner -C bin gitleaks
curl -fsSL -o bin/osv-scanner ${gh}/google/osv-scanner/releases/download/v${T.osvScanner}/osv-scanner_linux_amd64
curl -fsSL -o osv.sums ${gh}/google/osv-scanner/releases/download/v${T.osvScanner}/osv-scanner_SHA256SUMS
verify osv.sums ' osv-scanner_linux_amd64$' bin/osv-scanner && chmod +x bin/osv-scanner
curl -fsSL -o tv.tgz ${gh}/aquasecurity/trivy/releases/download/v${T.trivy}/trivy_${T.trivy}_Linux-64bit.tar.gz
curl -fsSL -o tv.sums ${gh}/aquasecurity/trivy/releases/download/v${T.trivy}/trivy_${T.trivy}_checksums.txt
verify tv.sums 'Linux-64bit\\.tar\\.gz$' tv.tgz && tar xzf tv.tgz --no-same-owner -C bin trivy
rm -f gl.tgz tv.tgz want got
export PATH=${TOOL_ROOT}/venv/bin:${TOOL_ROOT}/bin:$PATH
# Offline vulnerability databases for npm and PyPI: a tiny lockfile of each kind makes OSV-Scanner download them.
mkdir -p ${OSV_DB} /tmp/seed
printf '{"name":"seed","lockfileVersion":3,"packages":{"":{"name":"seed"},"node_modules/lodash":{"version":"4.17.21"}}}' > /tmp/seed/package-lock.json
echo 'requests==2.32.3' > /tmp/seed/requirements.txt
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=${OSV_DB} osv-scanner scan --experimental-offline --experimental-download-offline-databases --format json --output /tmp/seed.json -r /tmp/seed >/dev/null 2>&1 || true
test -s ${OSV_DB}/osv-scanner/npm/all.zip && test -s ${OSV_DB}/osv-scanner/PyPI/all.zip
OSV_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Trivy's misconfiguration checks bundle, cached for offline scans.
mkdir -p /tmp/iac && printf 'FROM scratch\\n' > /tmp/iac/Dockerfile
trivy config --quiet --skip-version-check --cache-dir ${TRIVY_CACHE} -f json -o /tmp/iac.json /tmp/iac >/dev/null
TRIVY_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$OSV_AT" "$TRIVY_AT" <<'PY'
import json, subprocess, sys
def out(cmd): return subprocess.run(cmd, capture_output=True, text=True).stdout.strip().splitlines()[0]
v = {"semgrep": out(["semgrep", "--version"]), "gitleaks": out(["gitleaks", "version"]), "osvScanner": out(["osv-scanner", "--version"]).split(":")[-1].strip(), "trivy": out(["trivy", "--version"]).split(":")[-1].strip(), "osvDatabaseAt": sys.argv[1], "trivyChecksAt": sys.argv[2]}
json.dump(v, open("${TOOL_ROOT}/versions.json", "w"))
print(json.dumps(v))
PY
CC_INSTALL`;
}

/** The rule pack: our own Semgrep rules (not the fixtures), with a hash that pins exactly what ran. */
export function rulePack(): { files: Array<{ name: string; text: string }>; hash: string; rules: Array<{ id: string; obligation: string; category: string; cwe: string[]; mode: "taint" | "search"; message: string; severity: string }> } {
  const dir = new URL("./rules/", import.meta.url);
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".yml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));
  const rules = files.flatMap((f) =>
    ((parse(f.text) as { rules: Array<{ id: string; message: string; severity: string; metadata: { obligation: string; category: string; cwe: string[]; mode: "taint" | "search" } }> }).rules ?? []).map((r) => ({ id: r.id, message: r.message, severity: r.severity, ...r.metadata })),
  );
  return { files, hash: sha(files.map((f) => `${f.name}\n${f.text}`).join("\n")).slice(0, 16), rules };
}

/** ISO year and week: the tool image (and its vulnerability data) is rebuilt every week. */
export function weekOf(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const toolImageKey = (week = weekOf()) => `security-tools:${sha(JSON.stringify({ tools: SECURITY_TOOLS, week })).slice(0, 24)}`;

export type ToolImageRun = (label: string, req: { image: string; command: string; network: boolean; keep: boolean; timeoutSec: number }) => Promise<{ ok: boolean; image: string | null; stdout: string; executionId: string | null }>;

/**
 * The tool image for this week: reused when cached and verified, otherwise built with the network on. Returns the
 * image and the recorded versions, or null with the reason when the tools could not be installed.
 */
export async function securityToolImage(provider: SandboxProvider, run: ToolImageRun): Promise<{ image: string; versions: ToolVersions; cached: boolean; executionIds: string[] } | { image: null; reason: string; executionIds: string[] }> {
  const key = toolImageKey();
  const ids: string[] = [];
  const [cached] = await db.select().from(sandboxImageCache).where(eq(sandboxImageCache.key, key));
  if (cached && cached.provider === provider.name) {
    const v = await run("Verify the security tool image", { image: cached.imageId, command: `test -x ${TOOL_ROOT}/bin/gitleaks && test -x ${TOOL_ROOT}/bin/osv-scanner && test -x ${TOOL_ROOT}/bin/trivy && test -x ${TOOL_ROOT}/venv/bin/semgrep && cat ${TOOL_ROOT}/versions.json`, network: false, keep: false, timeoutSec: 120 });
    if (v.executionId) ids.push(v.executionId);
    const versions = v.ok ? parseVersions(v.stdout) : null;
    if (versions) return { image: cached.imageId, versions, cached: true, executionIds: ids };
    await db.delete(sandboxImageCache).where(eq(sandboxImageCache.key, key));
  }
  const base = await provider.image(SECURITY_TOOLS.base);
  const r = await run("Install the security tools (pinned, checksums verified)", { image: base, command: installScript(), network: true, keep: true, timeoutSec: 1200 });
  if (r.executionId) ids.push(r.executionId);
  const versions = parseVersions(r.stdout);
  if (!r.ok || !r.image || !versions) return { image: null, reason: `The security tools could not be installed: ${r.stdout.trim().split("\n").slice(-3).join(" ").slice(0, 300) || "no output"}`, executionIds: ids };
  await db.insert(sandboxImageCache).values({ key, provider: provider.name, imageId: r.image }).onConflictDoNothing();
  return { image: r.image, versions, cached: false, executionIds: ids };
}

/** The versions line the install and verify steps print (the last JSON object in the output). */
export function parseVersions(stdout: string): ToolVersions | null {
  const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    const v = JSON.parse(line) as ToolVersions;
    return v.semgrep && v.gitleaks && v.osvScanner && v.trivy && v.osvDatabaseAt ? v : null;
  } catch {
    return null;
  }
}
