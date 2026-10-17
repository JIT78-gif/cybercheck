import { describe, expect, it } from "vitest";
import { DockerSandboxProvider } from "../src/testing/sandbox/docker.ts";
import { NebiusSandboxProvider } from "../src/testing/sandbox/nebius.ts";
import { SandboxUnavailableError, type ProviderHealth, type SandboxProvider } from "../src/testing/sandbox/provider.ts";
import { selectSecurityRuntime } from "../src/security/runtime.ts";

const fakeProvider = (name: string, health: ProviderHealth): SandboxProvider => ({ name, preflight: async () => health, image: async () => "i", upload: async () => "f", run: async () => ({ operationId: null, status: "ok", exitCode: 0, stdout: "", stderr: "", truncated: false, resultImage: null, durationMs: 0, cpuSeconds: null, maxRssKb: null, error: null }), readFile: async () => null });
const healthy = (s: ProviderHealth["status"] = "available"): ProviderHealth => ({ ok: s === "available", status: s, detail: s });

/** A fake docker CLI that records argv and returns scripted results keyed by the subcommand. */
function fakeDocker(script: Record<string, { stdout?: string; code?: number | null; timedOut?: boolean; spawnError?: string }>) {
  const calls: string[][] = [];
  const exec = async (_file: string, args: string[]) => {
    calls.push(args);
    const s = script[args[0]!] ?? {};
    return { stdout: Buffer.from(s.stdout ?? ""), stderr: Buffer.from(""), code: s.code === null ? null : s.code ?? 0, timedOut: Boolean(s.timedOut), spawnError: s.spawnError };
  };
  return { exec: exec as never, calls };
}

// The provider preflight classifies why a sandbox can or cannot run, so the selector and the UI can act on it
// (notably: HTTP 402 means billing/credit, not a crash).

const provider = (status: number | "network") =>
  new NebiusSandboxProvider({
    apiKey: "k",
    projectId: "p",
    fetchImpl: (async () => {
      if (status === "network") throw new Error("ECONNREFUSED");
      return new Response("{}", { status });
    }) as unknown as typeof fetch,
  });

describe("Nebius preflight classification", () => {
  it.each([
    [402, "billing_unavailable"],
    [401, "access_denied"],
    [403, "access_denied"],
    [429, "rate_limited"],
    [500, "temporarily_unavailable"],
    [503, "temporarily_unavailable"],
  ] as const)("maps HTTP %i to %s", async (code, expected) => {
    const h = await provider(code).preflight();
    expect(h).toMatchObject({ ok: false, status: expected });
  });

  it("maps a 404 for the probe operation to available (auth and project work)", async () => {
    expect(await provider(404).preflight()).toMatchObject({ ok: true, status: "available" });
  });

  it("maps a network error to temporarily_unavailable", async () => {
    expect(await provider("network").preflight()).toMatchObject({ ok: false, status: "temporarily_unavailable" });
  });

  it("surfaces a mid-run HTTP 402 as a billing SandboxUnavailableError", async () => {
    await expect(provider(402).image("docker.io/library/node:22-bookworm")).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(provider(402).image("docker.io/library/node:22-bookworm")).rejects.toThrow(/billing or credits/i);
  });
});

describe("local Docker provider", () => {
  it("reports local_unavailable when the docker command is missing", async () => {
    const { exec } = fakeDocker({ version: { spawnError: "ENOENT", code: 1 } });
    expect(await new DockerSandboxProvider({ exec }).preflight()).toMatchObject({ ok: false, status: "local_unavailable" });
  });

  it("reports available when the daemon answers", async () => {
    const { exec } = fakeDocker({ version: { stdout: "29.1.3" } });
    expect(await new DockerSandboxProvider({ exec }).preflight()).toMatchObject({ ok: true, status: "available" });
  });

  it("runs a scan with the network off and the lockdown flags, and commits on keep", async () => {
    const { exec, calls } = fakeDocker({ create: { stdout: "cid" }, start: {}, wait: {}, logs: { stdout: "clean" }, inspect: { stdout: "0" }, commit: { stdout: "sha256:abc" }, rm: {} });
    const r = await new DockerSandboxProvider({ exec }).run({ image: "img", command: "scan", network: false, keep: true, timeoutSec: 60 });
    const create = calls.find((c) => c[0] === "create")!;
    expect(create).toContain("--network=none");
    expect(create).toContain("--cap-drop=ALL");
    expect(create).toContain("--security-opt=no-new-privileges");
    expect(create.some((a) => a.startsWith("--pids-limit"))).toBe(true);
    expect(r).toMatchObject({ status: "ok", exitCode: 0, resultImage: "sha256:abc" });
    expect(calls.some((c) => c[0] === "rm")).toBe(true); // the container is always removed
  });

  it("uses the bridge network only when preparing dependencies (network: true)", async () => {
    const { exec, calls } = fakeDocker({ create: { stdout: "cid" }, start: {}, wait: {}, logs: {}, inspect: { stdout: "0" }, rm: {} });
    await new DockerSandboxProvider({ exec }).run({ image: "img", command: "npm install", network: true, keep: true, timeoutSec: 60 });
    expect(calls.find((c) => c[0] === "create")!).toContain("--network=bridge");
  });

  it("marks a timed-out run timed_out and kills the container, without committing", async () => {
    const { exec, calls } = fakeDocker({ create: { stdout: "cid" }, start: {}, wait: { timedOut: true, code: null }, kill: {}, logs: {}, inspect: { stdout: "0" }, rm: {} });
    const r = await new DockerSandboxProvider({ exec }).run({ image: "img", command: "sleep", network: false, keep: true, timeoutSec: 1 });
    expect(r.status).toBe("timed_out");
    expect(r.resultImage).toBeNull();
    expect(calls.some((c) => c[0] === "kill")).toBe(true);
  });
});

describe("runtime selection", () => {
  const nebius = (ok: boolean) => fakeProvider("nebius", ok ? healthy() : healthy("billing_unavailable"));
  const localOk = () => fakeProvider("local-docker", healthy());
  const localDown = () => fakeProvider("local-docker", healthy("local_unavailable"));

  it("auto prefers Nebius when healthy", async () => {
    const s = await selectSecurityRuntime("auto", nebius(true), localOk);
    expect(s).toMatchObject({ selected: "nebius", provider: expect.anything(), fallbackReason: null });
  });

  it("auto falls back to local Docker when Nebius is out of credit (402)", async () => {
    const s = await selectSecurityRuntime("auto", nebius(false), localOk);
    expect(s.selected).toBe("local");
    expect(s.health.nebius?.status).toBe("billing_unavailable");
    expect(s.fallbackReason).toMatch(/Nebius unavailable.*local Docker/i);
  });

  it("auto falls back to analysis-only when neither runtime is available", async () => {
    const s = await selectSecurityRuntime("auto", nebius(false), localDown);
    expect(s).toMatchObject({ selected: "static", provider: null });
    expect(s.fallbackReason).toMatch(/No runtime is available/i);
  });

  it("static always skips execution; explicit nebius failing goes analysis-only not local", async () => {
    expect(await selectSecurityRuntime("static", nebius(true), localOk)).toMatchObject({ selected: "static", provider: null });
    expect(await selectSecurityRuntime("nebius", nebius(false), localOk)).toMatchObject({ selected: "static", provider: null });
  });

  it("local uses Docker and reports not_configured Nebius under auto with no Nebius", async () => {
    expect(await selectSecurityRuntime("local", null, localOk)).toMatchObject({ selected: "local" });
    const s = await selectSecurityRuntime("auto", null, localOk);
    expect(s.selected).toBe("local");
    expect(s.health.nebius?.status).toBe("not_configured");
  });
});
