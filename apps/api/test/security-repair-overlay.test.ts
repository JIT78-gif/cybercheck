import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { overlayArchive, overlaySource } from "../src/security/repair-overlay.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";
import { makeTarGz } from "./fixtures.ts";

describe("Security repair validation overlay", () => {
  it("changes only the disposable source and archive copies", async () => {
    const original = sourceFromFiles({ "src/app.ts": "unsafe()\n", "README.md": "original\n" });
    const overlay = new Map([["src/app.ts", "safe()\n"]]);
    const source = overlaySource(original, overlay);
    expect(source.files.get("src/app.ts")?.text).toBe("safe()\n");
    expect(original.files.get("src/app.ts")?.text).toBe("unsafe()\n");

    const archive = await makeTarGz([{ name: "src/app.ts", data: "unsafe()\n" }, { name: "README.md", data: "original\n" }]);
    const patched = await overlayArchive(archive, overlay);
    const extract = tar.extract();
    const reading = pipeline(Readable.from([patched]), createGunzip(), extract);
    const files = new Map<string, string>();
    for await (const entry of extract) files.set(entry.header.name, (await buffer(entry)).toString("utf8"));
    await reading;
    expect(files).toEqual(new Map([["src/app.ts", "safe()\n"], ["README.md", "original\n"]]));
  });

  it("refuses an overlay for a path not owned by the snapshot", async () => {
    const archive = await makeTarGz([{ name: "src/app.ts", data: "unsafe()\n" }]);
    await expect(overlayArchive(archive, new Map([["src/other.ts", "x\n"]]))).rejects.toThrow(/not present/);
  });
});
