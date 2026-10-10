import { createRequire } from "node:module";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type Lang = "typescript" | "tsx" | "javascript" | "python";

let ready: Promise<Record<Lang, Language>> | null = null;

/** Load the WASM grammars once per process. */
function languages() {
  ready ??= (async () => {
    await Parser.init();
    const [typescript, tsx, javascript, python] = await Promise.all([
      Language.load(require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm")),
      Language.load(require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm")),
      Language.load(require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm")),
      Language.load(require.resolve("tree-sitter-python/tree-sitter-python.wasm")),
    ]);
    return { typescript, tsx, javascript, python };
  })();
  return ready;
}

export function langFor(path: string): Lang | null {
  if (/\.(ts|mts|cts)$/i.test(path) && !/\.d\.ts$/i.test(path)) return "typescript";
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return "javascript";
  if (/\.pyi?$/i.test(path)) return "python";
  return null;
}

export type Parsed = { path: string; lang: Lang; tree: Tree; text: string };

/** Parses source files and caches compiled queries per language. Call dispose() when done. */
export class CodeParser {
  private parser: Parser | null = null;
  private langs: Record<Lang, Language> | null = null;
  private queries = new Map<string, Query>();
  private trees: Tree[] = [];

  async init() {
    this.langs = await languages();
    this.parser = new Parser();
    return this;
  }

  parse(path: string, text: string): Parsed | null {
    const lang = langFor(path);
    if (!lang || !this.parser || !this.langs) return null;
    this.parser.setLanguage(this.langs[lang]);
    const tree = this.parser.parse(text);
    if (!tree) return null;
    this.trees.push(tree);
    return { path, lang, tree, text };
  }

  /** Compiled query for a language (cached). Returns null if the pattern doesn't apply to that grammar. */
  query(lang: Lang, source: string): Query | null {
    const key = `${lang}\u0000${source}`;
    if (this.queries.has(key)) return this.queries.get(key)!;
    try {
      const q = new Query(this.langs![lang], source);
      this.queries.set(key, q);
      return q;
    } catch {
      this.queries.set(key, null as unknown as Query);
      return null;
    }
  }

  dispose() {
    for (const t of this.trees) t.delete();
    for (const q of this.queries.values()) q?.delete();
    this.parser?.delete();
    this.trees = [];
    this.queries.clear();
  }
}

// ---------- Node helpers ----------

export const line = (n: Node) => n.startPosition.row + 1;
export const endLine = (n: Node) => n.endPosition.row + 1;

/** The text of a string literal node without quotes; null for template strings with substitutions. */
export function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === "string") {
    const frag = n.namedChildren.filter((c) => c && (c.type === "string_fragment" || c.type === "string_content"));
    if (n.namedChildren.some((c) => c?.type === "interpolation")) return null;
    return frag.map((c) => c!.text).join("");
  }
  if (n.type === "template_string") {
    if (n.namedChildren.some((c) => c?.type === "template_substitution")) return null;
    return n.text.slice(1, -1);
  }
  return null;
}

export function* walk(node: Node): Generator<Node> {
  const cursor = node.walk();
  let visited = false;
  while (true) {
    if (!visited) {
      yield cursor.currentNode;
      if (cursor.gotoFirstChild()) continue;
    }
    if (cursor.gotoNextSibling()) {
      visited = false;
      continue;
    }
    if (!cursor.gotoParent()) break;
    visited = true;
  }
  cursor.delete();
}
