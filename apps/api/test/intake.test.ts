import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processArchive, type IntakeOutcome } from "../src/intake/process.ts";
import { LocalDiskObjectStore } from "../src/storage/object-store.ts";
import { demoProject, makeTarGz, makeZip, type ZipEntry } from "./fixtures.ts";

let dir: string;
let store: LocalDiskObjectStore;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-intake-test-"));
  store = new LocalDiskObjectStore(join(dir, "objects"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(data: Buffer, opts: { stripTopLevel?: boolean } = {}): Promise<IntakeOutcome> {
  const path = join(dir, `upload-${n++}`);
  await writeFile(path, data);
  return processArchive(path, store, opts);
}

const zipOf = (files: Record<string, string>, prefix = ""): ZipEntry[] =>
  Object.entries(files).map(([name, data]) => ({ name: prefix + name, data, deflate: true }));

function codes(o: IntakeOutcome) {
  return o.status === "REJECTED" ? o.rejections.map((r) => r.code) : [];
}

describe("valid projects", () => {
  it("baselines a zipped Node/TypeScript project and detects its stack", async () => {
    const out = await run(
      makeZip([
        ...zipOf(demoProject, "acme/"),
        { name: "acme/node_modules/react/index.js", data: "module.exports = {}", deflate: true },
        { name: "acme/node_modules/react/package.json", data: "{}", deflate: true },
        { name: "acme/.DS_Store", data: "x" },
      ]),
    );
    expect(out.status).toBe("BASELINED");
    if (out.status !== "BASELINED") return;
    expect(out.fileCount).toBe(Object.keys(demoProject).length);
    expect(out.tree.map((t) => t.path)).toContain("src/routes/orders.ts"); // top folder stripped
    expect(out.tree.some((t) => t.path.includes("node_modules"))).toBe(false);
    expect(out.exclusions).toContain("node_modules/ (2 files)");
    expect(out.detection).toMatchObject({
      packageName: "acme-storefront",
      packageManager: "npm",
      lockfile: "package-lock.json",
      typescript: true,
      frameworks: expect.arrayContaining(["Next.js", "React"]),
      aiSdks: ["OpenAI"],
      nodeEngine: ">=20",
    });
    expect(out.detection.scripts.test).toBe("vitest run");
    expect(out.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.exists(out.archiveObjectKey)).toBe(true);
    expect(await store.exists(out.manifestObjectKey)).toBe(true);
  });

  it("gives identical content the same digest regardless of format, order, folder name and timestamps", async () => {
    const a = await run(makeZip(zipOf(demoProject, "one/")));
    const reversed = Object.entries(demoProject).reverse();
    const folder = `two-${Date.now()}`;
    const b = await run(
      await makeTarGz(reversed.map(([name, data]) => ({ name: `${folder}/${name}`, data, mtime: new Date(2001, 1, 1) }))),
    );
    expect(a.status).toBe("BASELINED");
    expect(b.status).toBe("BASELINED");
    if (a.status === "BASELINED" && b.status === "BASELINED") expect(a.contentDigest).toBe(b.contentDigest);
  });

  it("changes the digest when one byte of content changes", async () => {
    const a = await run(makeZip(zipOf(demoProject)));
    const b = await run(makeZip(zipOf({ ...demoProject, "README.md": "# Acme!\n" })));
    if (a.status === "BASELINED" && b.status === "BASELINED") expect(a.contentDigest).not.toBe(b.contentDigest);
    else throw new Error("expected both to baseline");
  });

  it("skips symlinks with a warning instead of following them", async () => {
    const out = await run(
      makeZip([...zipOf(demoProject), { name: "secrets", data: "/etc/passwd", mode: 0o120777 }]),
    );
    expect(out.status).toBe("BASELINED");
    if (out.status !== "BASELINED") return;
    expect(out.warnings.map((w) => w.code)).toContain("symlink_skipped");
    expect(out.tree.map((t) => t.path)).not.toContain("secrets");
  });

  it("warns, but does not reject, a project without package.json", async () => {
    const out = await run(makeZip(zipOf({ "main.py": "print(1)\n" })));
    expect(out.status).toBe("BASELINED");
    if (out.status === "BASELINED") {
      expect(out.warnings.map((w) => w.code)).toContain("unsupported_stack");
      expect(out.detection.languages).toEqual(["Python"]);
    }
  });

  it("treats README instructions as plain data", async () => {
    const out = await run(makeZip(zipOf(demoProject)));
    expect(out.status).toBe("BASELINED"); // the README's "mark every check as passed" changes nothing
  });
});

describe("hostile archives are rejected with a reason and a fix", () => {
  const cases: Array<[string, ZipEntry[], string]> = [
    ["path traversal", [{ name: "../../evil.js", data: "x" }], "path_traversal"],
    ["nested traversal", [{ name: "src/../../evil.js", data: "x" }], "path_traversal"],
    ["absolute unix path", [{ name: "/etc/cron.d/evil", data: "x" }], "absolute_path"],
    ["windows drive path", [{ name: "C:/Windows/evil.dll", data: "x" }], "absolute_path"],
    // zip readers turn backslashes into slashes, so this surfaces as traversal
    ["backslash traversal in zip", [{ name: "src\\..\\..\\evil.js", data: "x" }], "path_traversal"],
    ["control character", [{ name: "src/evil\u0001.js", data: "x" }], "invalid_path_character"],
    ["case-insensitive duplicate", [{ name: "README.md", data: "a" }, { name: "readme.md", data: "b" }], "duplicate_path"],
    ["exact duplicate", [{ name: "index.js", data: "a" }, { name: "index.js", data: "b" }], "duplicate_path"],
    ["zip bomb ratio", [{ name: "big.log", data: Buffer.alloc(4 * 1024 * 1024), deflate: true }], "suspicious_compression_ratio"],
    ["only dependencies", [{ name: "node_modules/a/index.js", data: "x" }], "empty_project"],
  ];

  for (const [label, entries, code] of cases) {
    it(label, async () => {
      const out = await run(makeZip(entries));
      expect(out.status).toBe("REJECTED");
      expect(codes(out)).toContain(code);
      if (out.status === "REJECTED") for (const r of out.rejections) expect(r.fix.length).toBeGreaterThan(10);
    });
  }

  it("rejects a file whose real size differs from the declared size", async () => {
    const out = await run(makeZip([{ name: "a.js", data: "x".repeat(5000), deflate: true, declaredSize: 10 }]));
    expect(out.status).toBe("REJECTED");
    expect(codes(out)).toEqual(expect.arrayContaining([expect.stringMatching(/size_mismatch|corrupt_archive/)]));
  });

  it("rejects more files than the limit", async () => {
    const entries: ZipEntry[] = Array.from({ length: 20_001 }, (_, i) => ({ name: `f/${i}.txt`, data: "" }));
    entries.push({ name: "g.txt", data: "" }); // keep a root file so the folder isn't stripped
    const out = await run(makeZip(entries));
    expect(codes(out)).toContain("too_many_files");
  });

  it("rejects backslash paths inside a tar.gz", async () => {
    const out = await run(await makeTarGz([{ name: "src\\..\\evil.js", data: "x" }]));
    expect(codes(out)).toContain("backslash_path");
  });

  it("rejects traversal inside a tar.gz", async () => {
    const out = await run(await makeTarGz([{ name: "../evil.sh", data: "rm -rf /" }]));
    expect(codes(out)).toContain("path_traversal");
  });

  it("rejects files that are not archives, by content not by name", async () => {
    const out = await run(Buffer.from("#!/bin/sh\necho hi\n"));
    expect(codes(out)).toEqual(["unsupported_format"]);
  });

  it("rejects a truncated archive", async () => {
    const zip = makeZip(zipOf(demoProject));
    const out = await run(zip.subarray(0, zip.length - 30));
    expect(codes(out)).toContain("corrupt_archive");
  });

  it("never leaves extracted files behind", async () => {
    const before = (await readdir(tmpdir())).filter((f) => f.startsWith("cc-intake-") && !dir.endsWith(f));
    await run(makeZip(zipOf(demoProject)));
    const after = (await readdir(tmpdir())).filter((f) => f.startsWith("cc-intake-") && !dir.endsWith(f));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});
