import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import type { ProviderHealth, SandboxFile, SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./provider.ts";
import { SandboxUnavailableError } from "./provider.ts";

// A local fallback sandbox that runs the project's code in disposable Docker containers, never on the host. Every
// scan or proof runs with the network off and with resources, capabilities and privileges locked down; the container
// is removed afterwards. It implements the same SandboxProvider contract as Nebius, so the orchestrator is unchanged.

type Exec = (file: string, args: string[], opts?: { input?: Buffer; timeoutMs?: number; maxBuffer?: number }) => Promise<{ stdout: Buffer; stderr: Buffer; code: number | null; timedOut: boolean; spawnError?: string }>;

const runDocker: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
      const spawnError = e && typeof e.code === "string" ? `${e.code}` : undefined; // ENOENT etc. (docker not installed)
      resolve({ stdout: stdout as Buffer, stderr: stderr as Buffer, code: typeof e?.code === "number" ? e.code : e ? (e.killed ? null : 1) : 0, timedOut: Boolean(e?.killed), spawnError });
    });
    if (opts.input) child.stdin?.end(opts.input);
  });

/** Build a tar (uncompressed) of the sandbox files at their absolute paths, for `docker cp - <id>:/`. */
async function filesTar(files: SandboxFile[], blobs: Map<string, Buffer>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res) => sink.on("end", res));
  pack.pipe(sink);
  for (const f of files) {
    const body = blobs.get(f.fileId);
    if (!body) continue;
    const name = f.path.replace(/^\/+/, "");
    await new Promise<void>((res, rej) => pack.entry({ name, size: body.length, mode: f.mode ? parseInt(f.mode, 8) : 0o644 }, body, (e) => (e ? rej(e) : res())));
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "local-docker";
  private readonly blobs = new Map<string, Buffer>();
  private readonly pulled = new Map<string, Promise<string>>();

  constructor(private readonly opts: { exec?: Exec; binary?: string } = {}) {}
  private get exec() {
    return this.opts.exec ?? runDocker;
  }
  private get bin() {
    return this.opts.binary ?? "docker";
  }

  async preflight(): Promise<ProviderHealth> {
    const r = await this.exec(this.bin, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    if (r.spawnError === "ENOENT") return { ok: false, status: "local_unavailable", detail: "The docker command was not found on this machine." };
    if (r.code !== 0) return { ok: false, status: "local_unavailable", detail: `The Docker daemon is not reachable: ${r.stderr.toString("utf8").trim().slice(0, 200) || "docker version failed"}` };
    return { ok: true, status: "available", detail: `Local Docker ${r.stdout.toString("utf8").trim()}.` };
  }

  image(ref: string): Promise<string> {
    let p = this.pulled.get(ref);
    if (!p) {
      p = (async () => {
        const r = await this.exec(this.bin, ["pull", ref], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new SandboxUnavailableError(`Could not pull image ${ref}: ${r.stderr.toString("utf8").slice(0, 200)}`);
        return ref;
      })();
      p.catch(() => this.pulled.delete(ref));
      this.pulled.set(ref, p);
    }
    return p;
  }

  async upload(bytes: Buffer): Promise<string> {
    const id = randomUUID();
    this.blobs.set(id, bytes);
    return id;
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const start = Date.now();
    const cid = `cc-${randomUUID()}`;
    const fail = (error: string): SandboxRunResult => ({ operationId: cid, status: "error", exitCode: null, stdout: "", stderr: "", truncated: false, resultImage: null, durationMs: Date.now() - start, cpuSeconds: null, maxRssKb: null, error });
    // Lock the container down: no network unless preparing dependencies, bounded memory/CPU/pids, no extra
    // capabilities, no privilege escalation. The project's code never touches the host.
    const limits = ["--memory=4g", "--memory-swap=4g", "--cpus=2", "--pids-limit=512", "--cap-drop=ALL", "--security-opt=no-new-privileges"];
    const createArgs = ["create", "--name", cid, req.network ? "--network=bridge" : "--network=none", ...limits, ...(req.cwd ? ["-w", req.cwd] : []), ...Object.entries(req.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), req.image, "bash", "-lc", req.command];
    const created = await this.exec(this.bin, createArgs, { timeoutMs: 60_000 });
    if (created.spawnError === "ENOENT") throw new SandboxUnavailableError("The docker command was not found on this machine.");
    if (created.code !== 0) return fail(`docker create failed: ${created.stderr.toString("utf8").slice(0, 300)}`);
    try {
      if (req.files?.length) {
        const r = await this.exec(this.bin, ["cp", "-", `${cid}:/`], { input: await filesTar(req.files, this.blobs), timeoutMs: 120_000 });
        if (r.code !== 0) return fail(`docker cp failed: ${r.stderr.toString("utf8").slice(0, 300)}`);
      }
      const started = await this.exec(this.bin, ["start", cid], { timeoutMs: 60_000 });
      if (started.code !== 0) return fail(`docker start failed: ${started.stderr.toString("utf8").slice(0, 300)}`);
      // Wait for exit, bounded by the per-run timeout; on timeout, kill the container.
      const waited = await this.exec(this.bin, ["wait", cid], { timeoutMs: req.timeoutSec * 1000 });
      let timedOut = false;
      if (waited.timedOut) {
        timedOut = true;
        await this.exec(this.bin, ["kill", cid], { timeoutMs: 30_000 });
      }
      const logs = await this.exec(this.bin, ["logs", cid], { timeoutMs: 30_000 });
      const inspect = await this.exec(this.bin, ["inspect", "-f", "{{.State.ExitCode}}", cid], { timeoutMs: 30_000 });
      const exitCode = timedOut ? null : Number(inspect.stdout.toString("utf8").trim()) || 0;
      let resultImage: string | null = null;
      if (req.keep && !timedOut && exitCode === 0) {
        const committed = await this.exec(this.bin, ["commit", cid], { timeoutMs: 120_000 });
        if (committed.code === 0) resultImage = committed.stdout.toString("utf8").trim();
      }
      const maxOut = 4 * 1024 * 1024;
      const stdout = logs.stdout.toString("utf8");
      return {
        operationId: cid,
        status: timedOut ? "timed_out" : "ok",
        exitCode,
        stdout: stdout.slice(0, maxOut),
        stderr: logs.stderr.toString("utf8").slice(0, maxOut),
        truncated: stdout.length > maxOut,
        resultImage,
        durationMs: Date.now() - start,
        cpuSeconds: null,
        maxRssKb: null,
        error: null,
      };
    } finally {
      await this.exec(this.bin, ["rm", "-f", cid], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async readFile(image: string, path: string): Promise<Buffer | null> {
    // Read one file from a committed image by running a throwaway, network-off container that prints it.
    const r = await this.exec(this.bin, ["run", "--rm", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", image, "cat", path], { timeoutMs: 60_000 });
    return r.code === 0 ? r.stdout : null;
  }
}
