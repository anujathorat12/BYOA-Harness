import { expect, test } from "@playwright/test";
import { KEYS, signIn } from "./helpers";

test("rejects an unknown key and stores nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("API key").fill("definitely-not-a-key");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("not recognised");
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
});

test("admin sees role in the chrome, live health and overview data", async ({ page }) => {
  await signIn(page, "admin");
  await expect(page.getByTestId("whoami-name")).toHaveText("admin");
  await expect(page.locator("aside")).toContainText("admin");
  await expect(page.getByTestId("health-card")).toContainText("database");
  await expect(page.getByTestId("health-card")).toContainText("Docker daemon");
  await expect(page.getByTestId("stat-running")).toContainText("/8");
  await expect(page.getByTestId("decision-counts")).toBeVisible();
  // key is in sessionStorage only, never localStorage
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("byoa.console.apikey"))).toBe(KEYS.admin);
});

test("developer gets a restricted overview, not an error wall", async ({ page }) => {
  await signIn(page, "developer");
  await expect(page.getByText("limited to auditor and approver roles")).toBeVisible();
  await expect(page.getByTestId("whoami-name")).toHaveText("alice");
});

test("session survives reload and sign-out clears it", async ({ page }) => {
  await signIn(page, "auditor");
  await page.reload();
  await expect(page.getByTestId("whoami-name")).toHaveText("audrey");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("API key")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("byoa.console.apikey"))).toBeNull();
});
