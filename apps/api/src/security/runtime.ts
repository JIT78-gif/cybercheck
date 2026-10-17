import { DockerSandboxProvider } from "../testing/sandbox/docker.ts";
import type { ProviderHealth, SandboxProvider } from "../testing/sandbox/provider.ts";

// Chooses which runtime executes the Security proofs, from the run's `runtime` policy and a live preflight. The
// project's code never runs on the host: it is Nebius, a locked-down local Docker container, or nothing (an
// analysis-only report). A provider is used only after its preflight says it is healthy.

export type RuntimeChoice = "auto" | "nebius" | "local" | "static";
export type RuntimeSelection = {
  /** null means no runtime is available: produce an analysis-only report (never count runtime obligations as passed). */
  provider: SandboxProvider | null;
  selected: "nebius" | "local" | "static";
  health: { nebius?: ProviderHealth; local?: ProviderHealth };
  /** Why the chosen runtime differs from the preferred one, for the report and the UI. */
  fallbackReason: string | null;
};

/**
 * @param runtime the run's policy choice.
 * @param nebius the configured Nebius provider (or a test double), or null when Nebius is not configured.
 * @param makeLocal builds a local Docker provider; injectable for tests.
 */
export async function selectSecurityRuntime(runtime: RuntimeChoice, nebius: SandboxProvider | null, makeLocal: () => SandboxProvider = () => new DockerSandboxProvider()): Promise<RuntimeSelection> {
  const health: RuntimeSelection["health"] = {};
  if (runtime === "static") return { provider: null, selected: "static", health, fallbackReason: "Analysis only was requested; no code was executed." };

  const checkNebius = async (): Promise<SandboxProvider | null> => {
    if (!nebius) {
      health.nebius = { ok: false, status: "not_configured", detail: "Nebius is not configured (NEBIUS_API_KEY and NEBIUS_PROJECT_ID)." };
      return null;
    }
    health.nebius = await nebius.preflight();
    return health.nebius.ok ? nebius : null;
  };
  const checkLocal = async (): Promise<SandboxProvider | null> => {
    const local = makeLocal();
    health.local = await local.preflight();
    return health.local.ok ? local : null;
  };

  if (runtime === "nebius") {
    const ok = await checkNebius();
    return ok ? { provider: ok, selected: "nebius", health, fallbackReason: null } : { provider: null, selected: "static", health, fallbackReason: `Nebius is unavailable (${health.nebius!.status}): ${health.nebius!.detail} Analysis only.` };
  }
  if (runtime === "local") {
    const ok = await checkLocal();
    return ok ? { provider: ok, selected: "local", health, fallbackReason: null } : { provider: null, selected: "static", health, fallbackReason: `Local Docker is unavailable (${health.local!.status}): ${health.local!.detail} Analysis only.` };
  }

  // auto: prefer Nebius, fall back to local Docker, then to analysis only.
  const n = await checkNebius();
  if (n) return { provider: n, selected: "nebius", health, fallbackReason: null };
  const l = await checkLocal();
  if (l) return { provider: l, selected: "local", health, fallbackReason: `Nebius unavailable (${health.nebius!.status}); using local Docker.` };
  return { provider: null, selected: "static", health, fallbackReason: `No runtime is available (Nebius ${health.nebius!.status}, local Docker ${health.local!.status}); analysis only.` };
}
