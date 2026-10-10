import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

// Codes are read from the API's development outbox (written when SMTP is not configured).
const OUTBOX = resolve(__dirname, "../../../.data/dev-outbox.jsonl");

export async function latestCode(email: string, purpose: string, after: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = await readFile(OUTBOX, "utf8").catch(() => "");
    const match = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { at: string; to: string; purpose: string; otp: string })
      .filter((m) => m.to === email && m.purpose === purpose && Date.parse(m.at) >= after)
      .at(-1);
    if (match) return match.otp;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${purpose} code found for ${email}`);
}

/** Creates and verifies an account through the API; the page's browser context ends up signed in. */
export async function signedInUser(page: Page, name = "Dash Tester") {
  const email = `e2e-dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const headers = { Origin: "http://localhost:3000" };
  const t0 = Date.now() - 1000;
  const signUp = await page.request.post("/api/auth/sign-up/email", {
    data: { name, email, password: "dashboard-test-password-1" },
    headers,
  });
  expect(signUp.ok()).toBeTruthy();
  const verify = await page.request.post("/api/auth/email-otp/verify-email", {
    data: { email, otp: await latestCode(email, "email-verification", t0) },
    headers,
  });
  expect(verify.ok()).toBeTruthy(); // sets the session cookie in this browser context
  return email;
}

/**
 * Give each test its own client IP (from the 198.18.0.0/15 benchmarking range) so
 * per-client auth rate limits don't make tests interfere with each other. The API
 * only honours this because the request arrives through our trusted local proxy.
 */
export function giveEachTestItsOwnIp(test: typeof import("@playwright/test").test) {
  test.beforeEach(async ({ context }) => {
    const ip = `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
    await context.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  });
}
