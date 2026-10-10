import { expect, test } from "@playwright/test";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

test("an email user can start connecting GitHub from Settings", async ({ page, request }) => {
  const providers = await (await request.get("/v1/auth/providers")).json();
  test.skip(!providers.github, "GitHub OAuth keys are not configured in .env");

  await signedInUser(page, "Link Tester");
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Sign-in methods and connected accounts" })).toBeVisible();
  await expect(page.getByText("Sign in with your email and a password.")).toBeVisible();

  // Stub GitHub so the test never talks to a real account.
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "github stub" }));
  const authorize = page.waitForRequest((r) => r.url().startsWith("https://github.com/login/oauth/authorize"));
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  const url = new URL((await authorize).url());

  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/github");
  expect(url.searchParams.get("client_id")).toBeTruthy();
  expect(url.searchParams.get("state")).toBeTruthy(); // ties the callback to this signed-in session
  // Linking asks only for identity; repository access is requested separately on import.
  expect(url.searchParams.get("scope")).not.toContain("repo");
});

test("linking requires a signed-in session", async ({ request }) => {
  const res = await request.post("/api/auth/link-social", {
    data: { provider: "github", callbackURL: "http://localhost:3000/app/settings" },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(res.status()).toBe(401);
});
