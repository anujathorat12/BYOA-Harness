import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCall, signIn } from "./helpers";

const POLICIES = path.resolve(import.meta.dirname, "../../examples/policies");

test.describe.serial("Policy in plain English", () => {
  test.beforeAll(async () => {
    for (const name of ["financial-ops", "enterprise-it"]) {
      await apiCall("admin", "POST", "/v1/policies", { document: readFileSync(path.join(POLICIES, `${name}.yaml`), "utf8") });
    }
  });

  test("a stored policy is shown as sentences next to its YAML", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies?policy=financial-ops");
    const pe = page.getByTestId("plain-english");
    await expect(pe).toBeVisible();
    await expect(pe.getByTestId("pe-require-approval")).toContainText("Transfer money when params.amount is more than 1000.");
    await expect(pe.getByTestId("pe-require-approval")).toContainText("rule high-value-transfer-needs-approval");
    await expect(pe.getByTestId("pe-deny")).toContainText("Read data on anything matching finance.accounts*.");
    await expect(pe.getByTestId("pe-deny")).toContainText("Why: Account master data is out of scope for this agent");
    await expect(pe.getByTestId("pe-allow")).toContainText("Transfer money when params.amount is at most 1000.");
    await expect(pe).toContainText("at most 20,000 AI tokens");
    await expect(pe).toContainText("Anything not listed here is denied");
    await expect(page.getByTestId("policy-yaml")).toContainText("high-value-transfer-needs-approval"); // the YAML is still there, side by side
  });

  test("the strictest group comes first, matching how the engine ranks decisions", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies?policy=enterprise-it");
    await expect(page.getByTestId("pe-allow")).toBeVisible(); // allTextContents() does not wait, so wait for the content first
    const order = await page.getByTestId("plain-english").locator("h3").allTextContents();
    expect(order.map((t) => t.trim())).toEqual(["Never allowed", "A human must approve first", "Allowed", "Limits"]);
  });

  test("the editor shows a live preview, and unreadable text degrades gracefully", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies");
    await page.getByTestId("new-policy").click();
    const editor = page.getByLabel("Policy document");
    await editor.fill("id: preview-demo\nrules:\n  - id: never-delete\n    decision: deny\n    match: { type: production.delete }\n    reason: Too dangerous\n");
    const pe = page.getByTestId("plain-english");
    await expect(pe.getByTestId("pe-deny")).toContainText("Delete things in production.");
    await expect(pe.getByTestId("pe-deny")).toContainText("Why: Too dangerous");

    await editor.fill("id: [");
    await expect(page.getByTestId("plain-english-unreadable")).toContainText("Not readable yet");
    await editor.fill("id: preview-demo\nrules: []\n");
    await expect(pe).toContainText("no rules, so everything is denied");
  });
});
