import type { ProviderHealth, SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./provider.ts";
import { SandboxUnavailableError } from "./provider.ts";

/**
 * Nebius Sandboxes (Token Factory): each command is an operation that boots a fresh VM-isolated
 * container from an image. Docs: https://docs.tokenfactory.nebius.com/sandboxes/overview
 * Platform errors (HTTP 5xx, 429, network) are retried here; test retries are the orchestrator's
 * business and never happen at this layer.
 */

type Stream = { value?: string; encoding?: "ascii" | "base64"; truncated?: boolean } | null | undefined;
type Operation = {
  uuid: string;
  status: "PENDING" | "ASSIGNED" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";
  error: unknown;
  duration: number | null;
  consumed_cpu: number | null;
  consumed_memory: number | null;
  result_image_uuid: string | null;
  result?: { image?: string | null } | null;
  metadata?: { result?: { state?: { exit_code?: number | null; timed_out?: boolean; signal?: number | null }; stdout?: Stream; stderr?: Stream } | null } | null;
};

const decode = (s: Stream) => (s?.value ? (s.encoding === "base64" ? Buffer.from(s.value, "base64").toString("utf8") : s.value) : "");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class NebiusSandboxProvider implements SandboxProvider {
  readonly name = "nebius-sandboxes";
  private readonly images = new Map<string, Promise<string>>();

  constructor(
    private readonly opts: { apiKey: string; projectId: string; baseUrl?: string; fetchImpl?: typeof fetch },
  ) {}

  private get base() {
    return (this.opts.baseUrl ?? "https://api.tokenfactory.nebius.com/sandboxes/v1").replace(/\/$/, "");
  }

  private async call(method: string, path: string, body?: string | Uint8Array, contentType = "application/json", attempt = 0): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, Project: this.opts.projectId, ...(body ? { "content-type": contentType } : {}) },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        return this.call(method, path, body, contentType, attempt + 1);
      }
      throw new SandboxUnavailableError(`Sandbox service unreachable: ${(err as Error).message}`);
    }
    if ((res.status >= 500 || res.status === 429) && attempt < 4) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt);
      return this.call(method, path, body, contentType, attempt + 1);
    }
    if (res.status === 402) throw new SandboxUnavailableError("Nebius billing or credits are unavailable (HTTP 402).");
    if (res.status === 401 || res.status === 403) throw new SandboxUnavailableError(`Sandbox access denied (HTTP ${res.status}). Check NEBIUS_API_KEY and NEBIUS_PROJECT_ID.`);
    return res;
  }

  /** Classify whether Nebius can run now, from a cheap authenticated probe (a GET for an operation that does not exist). */
  async preflight(): Promise<ProviderHealth> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(`${this.base}/operations/cc-preflight-probe`, { method: "GET", headers: { Authorization: `Bearer ${this.opts.apiKey}`, Project: this.opts.projectId }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 402) return { ok: false, status: "billing_unavailable", detail: "Nebius billing or credits are unavailable (HTTP 402)." };
      if (res.status === 401 || res.status === 403) return { ok: false, status: "access_denied", detail: `Nebius denied access (HTTP ${res.status}). Check NEBIUS_API_KEY and NEBIUS_PROJECT_ID.` };
      if (res.status === 429) return { ok: false, status: "rate_limited", detail: "Nebius is rate limiting requests (HTTP 429)." };
      if (res.status >= 500) return { ok: false, status: "temporarily_unavailable", detail: `Nebius returned HTTP ${res.status}.` };
      // Any other status (a 404 for the unknown operation, or a 2xx) means the key and project work and the service answers.
      return { ok: true, status: "available", detail: "Nebius sandboxes are reachable." };
    } catch (err) {
      return { ok: false, status: "temporarily_unavailable", detail: `Nebius is unreachable: ${(err as Error).message}` };
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body === undefined ? undefined : JSON.stringify(body));
    const text = await res.text();
    if (!res.ok) throw new Error(`Sandbox API ${method} ${path.split("?")[0]} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private async waitFor(id: string, opts: { signal?: AbortSignal; deadline: number; onOutput?: (s: string) => void }): Promise<Operation> {
    let lastOut = "";
    for (;;) {
      if (opts.signal?.aborted || Date.now() > opts.deadline) {
        await this.call("DELETE", `/operations/${id}`).catch(() => undefined);
        const final = await this.json<Operation>("GET", `/operations/${id}`).catch(() => null);
        return final && ["SUCCESS", "FAILED", "CANCELLED"].includes(final.status) ? { ...final, status: final.status === "SUCCESS" ? "SUCCESS" : "CANCELLED" } : ({ uuid: id, status: "CANCELLED" } as Operation);
      }
      const live = Boolean(opts.onOutput);
      const op = await this.json<Operation>("GET", `/operations/${id}${live ? "?inflight=1" : ""}`);
      if (op.status === "SUCCESS" || op.status === "FAILED" || op.status === "CANCELLED") return op;
      if (live) {
        const out = decode(op.metadata?.result?.stdout);
        if (out && out !== lastOut) opts.onOutput!((lastOut = out));
      }
      await sleep(op.status === "EXECUTING" ? 2000 : 1000, opts.signal);
    }
  }

  image(ref: string): Promise<string> {
    let p = this.images.get(ref);
    if (!p) {
      p = (async () => {
        // Re-importing an unchanged image returns the same id, so this is cheap after the first time.
        const op = await this.json<{ uuid: string }>("POST", "/images/import", { registry: { url: `docker://${ref}` }, timeout: 1800 });
        const done = await this.waitFor(op.uuid, { deadline: Date.now() + 1_900_000 });
        const id = done.result?.image;
        if (done.status !== "SUCCESS" || !id) throw new SandboxUnavailableError(`Could not import image ${ref}: ${JSON.stringify(done.error ?? done.status).slice(0, 200)}`);
        return id;
      })();
      p.catch(() => this.images.delete(ref));
      this.images.set(ref, p);
    }
    return p;
  }

  async upload(bytes: Buffer): Promise<string> {
    const res = await this.call("POST", "/files", new Uint8Array(bytes), "application/octet-stream");
    const text = await res.text();
    if (!res.ok) throw new Error(`Sandbox upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return (JSON.parse(text) as { uuid: string }).uuid;
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const started = Date.now();
    const files = req.files?.length ? Object.fromEntries(req.files.map((f) => [f.path, { uuid: f.fileId, uid: 0, gid: 0, mode: f.mode ?? "0644" }])) : undefined;
    let op: { uuid: string };
    try {
      op = await this.json<{ uuid: string }>("POST", "/instances", {
        image: req.image,
        command: req.command,
        shell: true,
        env: req.env,
        cwd: req.cwd ?? "",
        disposable: !req.keep,
        networking: { enabled: req.network },
        timeout: req.timeoutSec,
        truncate_output_at: 4 * 1024 * 1024,
        files,
      });
    } catch (err) {
      return { operationId: null, status: "error", exitCode: null, stdout: "", stderr: "", truncated: false, resultImage: null, durationMs: Date.now() - started, cpuSeconds: null, maxRssKb: null, error: (err as Error).message };
    }
    // The platform enforces `timeout`; our own deadline only guards against a stuck operation.
    const done = await this.waitFor(op.uuid, { signal: req.signal, deadline: started + (req.timeoutSec + 180) * 1000, onOutput: req.onOutput });
    const r = done.metadata?.result;
    const out = decode(r?.stdout);
    const err = decode(r?.stderr);
    const timedOut = Boolean(r?.state?.timed_out);
    const status: SandboxRunResult["status"] = done.status === "CANCELLED" ? (req.signal?.aborted ? "cancelled" : "timed_out") : timedOut ? "timed_out" : done.status === "SUCCESS" ? "ok" : r?.state ? "ok" : "error";
    return {
      operationId: op.uuid,
      status,
      exitCode: r?.state?.exit_code ?? null,
      stdout: out,
      stderr: err,
      truncated: Boolean(r?.stdout?.truncated || r?.stderr?.truncated),
      resultImage: done.status === "SUCCESS" ? (done.result_image_uuid ?? done.result?.image ?? null) : null,
      durationMs: Date.now() - started,
      cpuSeconds: done.consumed_cpu ?? null,
      maxRssKb: done.consumed_memory ?? null,
      error: status === "error" ? JSON.stringify(done.error ?? done.status).slice(0, 300) : null,
    };
  }

  async readFile(image: string, path: string): Promise<Buffer | null> {
    const res = await this.call("GET", `/inspect/${image}/download?path=${encodeURIComponent(path)}`);
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new Error(`Sandbox download failed (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}
