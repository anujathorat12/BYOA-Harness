import { expect, test } from "@playwright/test";
import { apiCall, signIn } from "./helpers";

// These tests launch REAL hostile agents in REAL sandboxes (Docker must be running). Each verdict is read from a
// real session; nothing is mocked.
test.describe.serial("Attack Lab", () => {
  test.setTimeout(150_000);

  const ATTACKS = [
    { id: "internet", contains: "Every attempt failed" },
    { id: "memory", contains: "exceeded memory limit" },
    { id: "hang", contains: "timeout: exceeded 10s" },
    { id: "forge", contains: "protocol violation: unknown message type 'approval'" },
  ];

  for (const a of ATTACKS) {
    test(`"${a.id}" is BLOCKED by the real sandbox`, async ({ page }) => {
      await signIn(page, "developer");
      await page.goto("/attack-lab");
      await page.getByTestId(`attack-${a.id}`).click();
      const verdict = page.getByTestId(`verdict-${a.id}`);
      await expect(verdict).toBeVisible({ timeout: 100_000 });
      await expect(verdict).toHaveAttribute("data-outcome", "blocked");
      await expect(verdict).toContainText("BLOCKED");
      await expect(verdict).toContainText(a.contains);
      await expect(page.getByTestId("attack-summary")).toHaveText("Blocked 1 of 1 attack run");

      // the evidence is the actual session, one click away
      await verdict.getByText("Evidence from the real session").click();
      await expect(verdict).toContainText(/ses_[0-9a-f]{20}/);
    });
  }

  test("re-running reuses the registered test agent instead of piling up versions", async ({ page }) => {
    await signIn(page, "developer");
    const agent = await apiCall<{ version: number }>("developer", "GET", "/v1/agents/attack-lab-forge");
    expect(agent.version).toBe(1); // it has already run once (above); running again must not create v2
    await page.goto("/attack-lab");
    await page.getByTestId("attack-forge").click();
    await expect(page.getByTestId("verdict-forge")).toBeVisible({ timeout: 100_000 });
    expect((await apiCall<{ version: number }>("developer", "GET", "/v1/agents/attack-lab-forge")).version).toBe(1);
  });

  test("Run all four, one at a time, ends with 4 of 4 blocked", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, "developer");
    await page.goto("/attack-lab");
    await expect(page.getByTestId("attack-summary")).toHaveText("No attacks run yet");
    await page.getByTestId("run-all").click();
    await expect(page.getByTestId("attack-internet")).toBeDisabled(); // no piling on while one is running
    await expect(page.getByTestId("attack-summary")).toHaveText("Blocked 4 of 4 attacks run", { timeout: 200_000 });
    for (const a of ATTACKS) await expect(page.getByTestId(`verdict-${a.id}`)).toHaveAttribute("data-outcome", "blocked");
  });

  test("roles that cannot register or run agents are told so", async ({ page }) => {
    for (const role of ["auditor", "approver"] as const) {
      await signIn(page, role);
      await page.goto("/attack-lab");
      await expect(page.getByText("The Attack Lab is not available to your role")).toBeVisible();
      await page.getByRole("button", { name: "Sign out" }).click();
    }
  });

  test("a Stop button cancels a run that is still going", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/attack-lab");
    await page.getByTestId("attack-hang").click();
    await expect(page.getByTestId("running-hang")).toBeVisible();
    await page.getByTestId("stop-hang").click();
    const verdict = page.getByTestId("verdict-hang");
    await expect(verdict).toBeVisible({ timeout: 60_000 });
    await expect(verdict).toHaveAttribute("data-outcome", "unexpected"); // cancelled = no verdict, and it says so honestly
    await expect(verdict).toContainText("cancelled before it finished");
  });
});
