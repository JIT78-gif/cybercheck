import { sourceFromFiles, type SnapshotSource } from "../src/understanding/source.ts";
import * as acceptance from "./acceptance-fixtures.ts";
import * as fixtures from "./fixtures.ts";

/** Named fixture projects available to tests and the evaluation script. */
const ALL: Record<string, { files: Record<string, string | Buffer>; excluded?: Record<string, string> }> = {
  expressShop: { files: fixtures.expressShop },
  demoProject: { files: fixtures.demoProject },
  ...acceptance.ACCEPTANCE,
};

export function fixtureSource(name: string): SnapshotSource {
  const f = ALL[name];
  if (!f) throw new Error(`Unknown fixture ${name}`);
  return sourceFromFiles(f.files, f.excluded);
}
