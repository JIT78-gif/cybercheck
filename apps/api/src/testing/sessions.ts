import type { SnapshotSource } from "../understanding/source.ts";
import type { FixtureNode } from "./plan.ts";

/**
 * How the frontend keeps a signed-in session, so the browser worker can give a page the session the API setup
 * already created (an admin login, a customer check-in) instead of showing "Session expired".
 * token: the bare token · json: the whole sign-in answer as JSON (some apps keep the login or check-in response).
 */
export type BrowserSession = {
  identity: string;
  area: "localStorage" | "sessionStorage" | "cookie";
  key: string;
  form: "token" | "json";
  encode: "uri" | null;
  evidence: { path: string; line: number };
};

type Write = { area: BrowserSession["area"]; key: string; form: BrowserSession["form"]; encode: BrowserSession["encode"]; path: string; line: number; context: string };

const FRONTEND_FILE = /\.(tsx?|jsx?|vue|svelte)$/;

/** A string key: a literal, or a constant defined in the same file. */
function resolveKey(expr: string, text: string): string | null {
  const lit = expr.trim().match(/^["'`]([\w.:-]{2,80})["'`]$/);
  if (lit) return lit[1]!;
  const id = expr.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
  if (!id) return null;
  const def = text.match(new RegExp(`(?:const|let|var)\\s+${id}\\s*(?::\\s*\\w+\\s*)?=\\s*["'\`]([\\w.:-]{2,80})["'\`]`));
  return def?.[1] ?? null;
}

/** Every place the frontend stores something that looks like a session. */
export function storageWrites(src: Pick<SnapshotSource, "files">, frontendDir: string): Write[] {
  const out: Write[] = [];
  for (const [path, f] of src.files) {
    if ((frontendDir !== "." && !path.startsWith(`${frontendDir}/`)) || !FRONTEND_FILE.test(path) || /node_modules|\.next\/|(\.|\/)(test|spec)\./.test(path)) continue;
    const lines = f.text.split("\n");
    lines.forEach((l, i) => {
      // The write's own function (saveStaffSession, handleLogin...), not unrelated lines around it.
      let from = i;
      while (from > 0 && i - from < 15 && !/\bfunction\s+\w+|\b\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*(=>|\{)|\basync\s+\w+\s*\(/.test(lines[from]!)) from--;
      const around = lines.slice(from, i + 1).join("\n");
      const storage = l.match(/(localStorage|sessionStorage)\.setItem\(\s*([^,]+?)\s*,\s*(.+?)\)\s*;?\s*$/);
      if (storage) {
        const key = resolveKey(storage[2]!, f.text);
        if (key) out.push({ area: storage[1] as Write["area"], key, form: /JSON\.stringify/.test(storage[3]!) ? "json" : "token", encode: null, path, line: i + 1, context: around });
        return;
      }
      const cookie = l.match(/document\.cookie\s*=\s*`(?:\$\{(\w+)\}|([\w.:-]+))=([^;`]*)/);
      if (cookie && !/max-age=0|expires=Thu, 01 Jan 1970/i.test(l) && cookie[3]!.trim() !== "") {
        const key = cookie[2] ?? resolveKey(cookie[1]!, f.text);
        if (key) out.push({ area: "cookie", key, form: /JSON\.stringify/.test(around) ? "json" : "token", encode: /encodeURIComponent/.test(around) ? "uri" : null, path, line: i + 1, context: around });
      }
    });
  }
  return out;
}

/** Which identity a stored session belongs to: named after it, or the kind of session it is (a login vs a check-in). */
function score(w: Write, id: FixtureNode): number {
  const ctx = `${w.key} ${w.context}`.toLowerCase();
  const name = id.id.toLowerCase();
  let s = 0;
  if (ctx.includes(name)) s += 3;
  const guestish = /customer|guest|session_token|checkin|check_in|table|cart|visitor/.test(ctx);
  const loginish = /login|signin|sign_in|access_token|jwt|auth|staff|admin|user/.test(ctx);
  if (id.auth?.kind === "header" && guestish) s += 2;
  if ((id.auth?.kind === "login" || id.auth?.kind === "bearer") && loginish && !/customer|guest|visitor/.test(ctx.replace(name, ""))) s += 2;
  if (/token|session|auth/.test(w.key.toLowerCase())) s += 1;
  return s;
}

/** For every sign-in of the fixture graph, how the frontend would have stored it (best match, if any). */
export function browserSessions(src: Pick<SnapshotSource, "files">, frontendDir: string, graph: FixtureNode[]): BrowserSession[] {
  const writes = storageWrites(src, frontendDir);
  const out: BrowserSession[] = [];
  for (const id of graph.filter((n) => n.kind === "identity" && n.auth && n.auth.kind !== "basic")) {
    const best = writes.map((w) => ({ w, s: score(w, id) })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s)[0];
    if (best) out.push({ identity: id.id, area: best.w.area, key: best.w.key, form: best.w.form, encode: best.w.encode, evidence: { path: best.w.path, line: best.w.line } });
  }
  return out;
}
