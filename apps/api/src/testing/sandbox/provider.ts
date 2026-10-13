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

export interface SandboxProvider {
  readonly name: string;
  /** Image id for an OCI reference such as docker.io/library/node:22-bookworm (imported once). */
  image(ref: string): Promise<string>;
  upload(bytes: Buffer): Promise<string>;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  /** A file from an image produced by a kept run; null when it doesn't exist. */
  readFile(image: string, path: string): Promise<Buffer | null>;
}

export class SandboxUnavailableError extends Error {}
