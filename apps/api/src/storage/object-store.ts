import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where snapshot archives and manifests live. Swap for S3/MinIO later without touching callers. */
export interface ObjectStore {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Readable): Promise<void>;
  get(key: string): Readable;
}

export class LocalDiskObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string) {
    if (!/^[a-z0-9][a-z0-9/._-]*$/.test(key) || key.includes("..")) throw new Error(`invalid object key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root) + sep)) throw new Error(`object key escapes store: ${key}`);
    return full;
  }

  async exists(key: string) {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, body: Readable) {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    // Write to a temp name then rename, so readers never see a half-written object.
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  get(key: string) {
    return createReadStream(this.pathFor(key));
  }
}

const DEFAULT_ROOT = fileURLToPath(new URL("../../../../.data/objects", import.meta.url));
export const objectStore: ObjectStore = new LocalDiskObjectStore(process.env.OBJECT_STORE_DIR ?? DEFAULT_ROOT);
