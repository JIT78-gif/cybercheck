const fs = require("node:fs");
const path = require("node:path");
const store = require("./store");

// A safe knowledge directory the file tool is confined to.
const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");

// The assistant's tool registry. Tool descriptions are plain capability text (no instructions). Authorization,
// ownership and approval are enforced by the agent before a consequential tool runs; these primitives stay pure.
const TOOLS = {
  get_order: {
    description: "Look up an order by id.",
    run: ({ orderId }) => store.get().orders.find((o) => o.id === orderId) ?? { error: "not found" },
  },
  issue_refund: {
    description: "Refund an order. Consequential: the agent must confirm ownership and an approval first.",
    consequential: true,
    run: ({ orderId }) => {
      const o = store.get().orders.find((x) => x.id === orderId);
      if (!o) return { error: "not found" };
      o.refunded = true;
      o.status = "refunded";
      return { refunded: orderId };
    },
  },
  read_file: {
    description: "Read a file from the knowledge directory.",
    // Confined to the knowledge directory: a resolved path outside it is refused.
    run: ({ filePath }) => {
      const resolved = path.resolve(KNOWLEDGE_DIR, String(filePath ?? ""));
      if (resolved !== KNOWLEDGE_DIR && !resolved.startsWith(KNOWLEDGE_DIR + path.sep)) return { error: "path outside the knowledge directory" };
      try {
        return fs.readFileSync(resolved, "utf8");
      } catch {
        return { error: "not found" };
      }
    },
  },
  fetch_url: {
    description: "Fetch a catalog URL (disabled: outbound fetch is not permitted in this assistant).",
    run: () => ({ error: "outbound fetch is disabled" }),
  },
  catalog_search: {
    description: "Search the product catalog by keyword.",
    run: () => ({ results: [] }),
  },
};

module.exports = { TOOLS, KNOWLEDGE_DIR };
