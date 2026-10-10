import { expect, test, type Page } from "@playwright/test";
import { giveEachTestItsOwnIp, latestCode } from "./helpers";

giveEachTestItsOwnIp(test);


async function typeCode(page: Page, code: string) {
  await page.getByLabel("Digit 1").click();
  await page.keyboard.type(code);
}

const password = "correct-horse-battery-9";

test("unauthenticated visitors are sent from /app to /login", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  await expect(page.getByRole("heading", { name: "Sign in to cybercheck" })).toBeVisible();
});

test("sign up, verify with emailed code, sign out, sign in again", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Ada Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill(password);
  const sentAt = Date.now() - 1000;
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByText(email)).toBeVisible();

  // A wrong code is rejected with a clear message.
  await typeCode(page, "000000");
  await expect(page.getByRole("alert").filter({ hasText: "isn't right" })).toBeVisible();

  await typeCode(page, await latestCode(email, "email-verification", sentAt));
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByText("Ada Tester").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Personal/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Wrong password shows an actionable error.
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "don't match" })).toBeVisible();

  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("reset a forgotten password with an emailed code", async ({ page, request }) => {
  const email = `e2e-reset-${Date.now()}@example.test`;
  // Create and verify an account through the API directly.
  const t0 = Date.now() - 1000;
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { name: "Reset Tester", email, password },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(signUp.ok()).toBeTruthy();
  const verify = await request.post("/api/auth/email-otp/verify-email", {
    data: { email, otp: await latestCode(email, "email-verification", t0) },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(verify.ok()).toBeTruthy();

  await page.goto("/forgot-password");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const t1 = Date.now() - 1000;
  await page.getByRole("button", { name: "Send reset code" }).click();
  await typeCode(page, await latestCode(email, "forget-password", t1));
  const newPassword = "brand-new-password-42";
  await page.getByLabel("New password").fill(newPassword);
  await page.getByRole("button", { name: "Set new password" }).click();

  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await expect(page.getByText("Your password was changed")).toBeVisible();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).filter({ visible: true }).fill(newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("no password stays in the page after signing up", async ({ page }) => {
  const email = `e2e-hygiene-${Date.now()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Hygiene Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  const leftovers = await page.evaluate(
    () => [...document.querySelectorAll<HTMLInputElement>("input[type=password]")].filter((i) => i.value).length,
  );
  expect(leftovers).toBe(0);
});
