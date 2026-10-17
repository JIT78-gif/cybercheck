/**
 * Isolated execution for untrusted project code. Every command runs in a fresh sandbox started
 * from an image; nothing persists unless the run is kept (`keep`), which produces a new image.
 * The orchestrator never runs project code on the host.
 */

export type SandboxFile = { path: string; fileId: string; mode?: string };

export type SandboxRunRequest = {
  image: string;
  /** Shell command (bash -c). */
  command: string;
  /** Network on only while installing dependencies; off for everything that runs the project. */
  network: boolean;
  /** Keep the resulting filesystem as a new image (needed to read report files afterwards). */
  keep: boolean;
  timeoutSec: number;
  env?: Record<string, string>;
  files?: SandboxFile[];
  cwd?: string;
  signal?: AbortSignal;
  /** Called with partial output while the command runs (best effort). */
  onOutput?: (stdout: string) => void;
};

export type SandboxRunResult = {
  operationId: string | null;
  /** ok: the command ran to completion (any exit code) · timed_out · cancelled · error: the platform failed */
  status: "ok" | "timed_out" | "cancelled" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** The new image when `keep` was set and the operation succeeded. */
  resultImage: string | null;
  durationMs: number;
  cpuSeconds: number | null;
  maxRssKb: number | null;
  error: string | null;
};

/** Why a provider can or cannot run right now, classified so the UI and the selector can act on it. */
export type ProviderStatus =
  | "available"
  | "billing_unavailable" // HTTP 402: out of credit / billing not set up
  | "access_denied" // HTTP 401/403: bad key or project
  | "rate_limited" // HTTP 429
  | "temporarily_unavailable" // network error or 5xx
  | "not_configured" // required settings are absent
  | "local_unavailable"; // the local Docker daemon is not reachable
export type ProviderHealth = { ok: boolean; status: ProviderStatus; detail: string };

export interface SandboxProvider {
  readonly name: string;
  /** A cheap, side-effect-free check of whether this provider can run now, with the reason when it cannot. */
  preflight(): Promise<ProviderHealth>;
  /** Image id for an OCI reference such as docker.io/library/node:22-bookworm (imported once). */
  image(ref: string): Promise<string>;
  upload(bytes: Buffer): Promise<string>;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  /** A file from an image produced by a kept run; null when it doesn't exist. */
  readFile(image: string, path: string): Promise<Buffer | null>;
}

export class SandboxUnavailableError extends Error {}
