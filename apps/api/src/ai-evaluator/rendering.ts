import type { Evidence } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

// Detecting whether the AI component's output is rendered as HTML in a browser. Output rendering is only a concern
// when a page takes the assistant's reply and injects it as markup (innerHTML, dangerouslySetInnerHTML, v-html,
// insertAdjacentHTML, document.write). When no such sink exists, the reply is consumed as data and the lane does not
// apply. When one does, the lane is required and the browser canary (a later step) confirms whether it executes.

const SINK = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|dangerouslySetInnerHTML|\bv-html\b|document\.write(?:ln)?\s*\(/;
const CLIENT_FILE = /\.(html?|htm|[cm]?jsx?|tsx|vue|svelte|astro)$/i;

/** The last segment of a response selector, e.g. "data.answer" -> "answer". */
function replyField(selector: string | undefined): string | null {
  if (!selector) return null;
  const f = selector.replace(/^\$\.?/, "").split(/[.[]/).filter(Boolean).pop();
  return f && /^[\w-]+$/.test(f) ? f : null;
}

/**
 * Lines where a page renders the assistant's reply as HTML. A file qualifies when it both talks to the AI route (so
 * the markup it injects can carry the model's output) and injects markup; a sink line that names the reply field is a
 * strong hit, otherwise every sink line in a file that fetches the route is reported.
 */
export function detectRenderSinks(src: SnapshotSource, opts: { routePaths: string[]; replySelector?: string }): Evidence[] {
  const out: Evidence[] = [];
  const field = replyField(opts.replySelector);
  const routes = opts.routePaths.map((p) => p.replace(/\{[^}]*\}|:[\w]+/g, "")).filter((p) => p.length >= 3);
  for (const [path, file] of src.files) {
    if (!CLIENT_FILE.test(path) || /node_modules|\.next\/|dist\/|build\//.test(path)) continue;
    const text = file.text;
    if (!SINK.test(text)) continue;
    const talksToRoute = routes.some((r) => text.includes(r)) || /\/(chat|assistant|ai|message|conversation|completion)/i.test(text);
    if (!talksToRoute) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (!SINK.test(l)) continue;
      // Prefer a sink that clearly carries the reply (innerHTML = x.reply); otherwise accept any sink in a routed file.
      const namesReply = field ? new RegExp(`\\b${field}\\b`).test(l) || new RegExp(`\\b${field}\\b`).test(lines[i - 1] ?? "") : false;
      if (field && !namesReply && /\binnerHTML\b|dangerouslySetInnerHTML|v-html/.test(l) === false) continue;
      out.push({ path, line: i + 1 });
    }
  }
  // Deduplicate by path:line.
  return out.filter((e, i) => out.findIndex((x) => x.path === e.path && x.line === e.line) === i).slice(0, 8);
}
