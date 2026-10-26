import { describe, expect, it } from "vitest";
import { withLocalImports } from "../src/testing/repair.ts";
import type { SnapshotSource } from "../src/understanding/source.ts";

// A repair may also change the project's own modules that the evidence file imports directly, so a defect that lives
// in a helper (an auth module, a retrieval filter) can be fixed where it is, not patched around.

const source = (files: Record<string, string>) => ({ files: new Map(Object.entries(files).map(([path, text]) => [path, { path, text }])) }) as unknown as SnapshotSource;

describe("repair scope: direct local imports", () => {
  it("adds required and imported local modules, resolving extensions and index files", () => {
    const src = source({
      "src/app.js": 'const { requireUser } = require("./auth");\nconst store = require("./store.js");\nimport tools from "./tools";\nimport "./lib";\nconst x = await import("../shared/util");\nconst express = require("express");',
      "src/auth.js": "", "src/store.js": "", "src/tools.ts": "", "src/lib/index.js": "", "shared/util.mjs": "",
    });
    expect(withLocalImports(["src/app.js"], src)).toEqual(["src/app.js", "src/auth.js", "src/store.js", "src/tools.ts", "src/lib/index.js", "shared/util.mjs"]);
  });

  it("follows Python relative imports", () => {
    const src = source({ "app/routes.py": "from .auth import require_user\nfrom . import tenancy\nfrom ..core.db import q\nimport os", "app/auth.py": "", "app/tenancy.py": "", "core/db.py": "" });
    expect(withLocalImports(["app/routes.py"], src)).toEqual(["app/routes.py", "app/auth.py", "app/tenancy.py", "core/db.py"]);
  });

  it("never adds tests, config or files that do not exist, and goes only one hop", () => {
    const src = source({ "src/app.js": 'require("./app.test");\nrequire("../package.json");\nrequire("./missing");\nrequire("./auth");', "src/app.test.js": "", "package.json": "{}", "src/auth.js": 'require("./deep");', "src/deep.js": "" });
    expect(withLocalImports(["src/app.js"], src)).toEqual(["src/app.js", "src/auth.js"]);
  });

  it("adds the files that import the evidence file (the route that hands its data out), never their tests", () => {
    const src = source({ "src/ai.js": "module.exports = { history: [] };", "src/app.js": 'const assistant = require("./ai");', "src/ai.test.js": 'require("./ai");', "src/other.js": "" });
    expect(withLocalImports(["src/ai.js"], src)).toEqual(["src/ai.js", "src/app.js"]);
  });

  it("adds at most four importers of a widely used module", () => {
    const files: Record<string, string> = { "src/util.js": "" };
    for (let i = 0; i < 9; i++) files[`src/r${i}.js`] = 'require("./util");';
    expect(withLocalImports(["src/util.js"], source(files))).toHaveLength(5);
  });
});
