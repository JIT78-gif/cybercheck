import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { browserSessions, storageWrites } from "../src/testing/sessions.ts";
import type { FixtureNode } from "../src/testing/plan.ts";

const files = (entries: Record<string, string>) => ({ files: new Map(Object.entries(entries).map(([p, text]) => [p, { path: p, text, lines: text.split("\n").length }])) }) as never;
const id = (name: string, kind: "login" | "header" | "bearer"): FixtureNode => ({ id: name, label: name, kind: "identity", dependsOn: [], origin: "plan", auth: { kind } });

describe("where the frontend keeps its session", () => {
  it("reads token and JSON sessions from localStorage and cookies, with constant keys", () => {
    const src = files({
      "frontend/lib/auth.ts": [
        'const STAFF_COOKIE = "hc_staff";',
        'const CUSTOMER_KEY = "hc_session";',
        "export function saveStaffSession(login: LoginResponse) {",
        "  const value = encodeURIComponent(JSON.stringify(login));",
        "  document.cookie = `${STAFF_COOKIE}=${value}; path=/; max-age=2592000; SameSite=Lax`;",
        "}",
        "export function logoutStaff() {",
        "  document.cookie = `${STAFF_COOKIE}=; path=/; max-age=0`;",
        "}",
        "export function saveCustomerSession(s: CustomerSession) {",
        "  window.localStorage.setItem(CUSTOMER_KEY, JSON.stringify(s));",
        "}",
      ].join("\n"),
      "frontend/app/login/page.jsx": '      localStorage.setItem("cafe_token", token);',
      "backend/app.py": 'localStorage.setItem("not_frontend", x)',
    });
    const w = storageWrites(src, "frontend");
    expect(w.map((x) => [x.area, x.key, x.form, x.encode])).toEqual([
      ["cookie", "hc_staff", "json", "uri"],
      ["localStorage", "hc_session", "json", null],
      ["localStorage", "cafe_token", "token", null],
    ]);
    const s = browserSessions(src, "frontend", [id("admin", "login"), id("staff", "login"), id("customer", "header")]);
    expect(s.map((x) => [x.identity, x.key])).toEqual([
      ["admin", "hc_staff"],
      ["staff", "hc_staff"],
      ["customer", "hc_session"],
    ]);
  });

  it("finds the bench projects' sessions", () => {
    const load = (dir: string) => {
      const out: Record<string, string> = {};
      const walk = (d: string, rel: string) => {
        for (const n of readdirSync(d)) {
          if (n === "node_modules" || n === ".next") continue;
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
          else if (/\.(jsx?|tsx?)$/.test(n)) out[`${rel}${n}`] = readFileSync(p, "utf8");
        }
      };
      walk(dir, "");
      return files(out);
    };
    const shop = "test/testing-holdout/node-shop-ui/project";
    if (existsSync(shop)) expect(browserSessions(load(shop), "frontend", [id("admin", "login")]).map((x) => x.key)).toEqual(["shop_token"]);
    const cafe = "test/testing-bench/cafe-fullstack/project";
    if (existsSync(cafe)) expect(browserSessions(load(cafe), "frontend", [id("admin", "login")]).map((x) => [x.key, x.form])).toEqual([["cafe_token", "token"]]);
  });
});
