import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCall, runSession, signIn } from "./helpers";

const stamp = Date.now();
const agentId = `e2e-sim-${stamp}`;
const polId = `e2e-pol-${stamp}`;
const FIN = readFileSync(path.resolve(import.meta.dirname, "../../examples/policies/financial-ops.yaml"), "utf8");

test.describe.serial("Policy Studio", () => {
  test.beforeAll(async () => {
    // Real recorded traffic: a declarative agent (no LLM) that reads data and makes one 200 transfer.
    await apiCall("admin", "POST", "/v1/policies", { document: FIN }); // idempotent: unchanged if already stored
    await apiCall("developer", "POST", "/v1/agents", {
      id: agentId, shape: "declarative",
      spec: { steps: [
        { id: "t", call: "data.read", args: { dataset: "finance.transactions" } },
        { id: "pay", call: "payment.transfer", args: { to: "${task.to}", amount: "${task.amount}" }, on_denied: "continue" },
        { return: { pay: "${pay}" } },
      ] },
    });
    await apiCall("admin", "POST", `/v1/agents/${agentId}/policies`, { policy_id: "financial-ops" });
    const s = await runSession("developer", agentId, { to: "vendor-1", amount: 200 });
    expect(s.status).toBe("succeeded");
  });

  test("developer is told the studio is restricted", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/policies");
    await expect(page.getByText("Policy Studio is not available to your role")).toBeVisible();
  });

  test("live validation shows the server's own errors, then success", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto("/policies");
    await page.getByTestId("new-policy").click();
    const editor = page.getByLabel("Policy document");
    await editor.fill("id: p\nrules:\n  - id: r\n    desicion: allow\n");
    await expect(page.getByTestId("validation-error")).toContainText("Extra inputs are not permitted");
    await editor.fill(`id: ${polId}\nrules:\n  - id: r\n    decision: allow\n    match: { type: data.read }\n`);
    await expect(page.getByTestId("validation-ok")).toContainText(polId);
  });

  test("admin saves v1, then v2; identical content is a no-op; history shows both", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto("/policies");
    await page.getByTestId("new-policy").click();
    const editor = page.getByLabel("Policy document");
    const v1 = `id: ${polId}\nrules:\n  - id: r\n    decision: allow\n    match: { type: data.read }\n`;
    await editor.fill(v1);
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await page.getByTestId("save-policy").click();
    await expect(page.getByRole("heading", { name: new RegExp(`${polId} v1`) })).toBeVisible();

    await page.getByTestId("edit-as-new").click();
    await page.getByLabel("Policy document").fill(v1.replace("data.read", "data.*"));
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await page.getByTestId("save-policy").click();
    await expect(page.getByRole("heading", { name: new RegExp(`${polId} v2`) })).toBeVisible();
    await expect(page.getByRole("row", { name: /v1/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /v2 latest/ })).toBeVisible();

    await page.getByTestId("edit-as-new").click(); // saving identical content again
    await page.getByTestId("save-policy").click();
    await expect(page.getByText(/No change — identical to/)).toBeVisible();
  });

  test("auditor can draft and dry-run but the save button is disabled with the reason", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies");
    await page.getByTestId("new-policy").click();
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await expect(page.locator("[data-blocked-reason]", { hasText: "Save as new version" })).toHaveAttribute("data-blocked-reason", /Requires role: admin/);
  });

  test("evaluate one action: the backend engine decides, the UI only displays", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies?policy=financial-ops");
    await page.getByRole("tab", { name: "Dry-run" }).click();
    await page.getByTestId("evaluate-run").click(); // defaults: payment.transfer to vendor-1, amount 5000
    const res = page.getByTestId("evaluate-result");
    await expect(res).toContainText("require-approval");
    await expect(res).toContainText("high-value-transfer-needs-approval");
  });

  test("dry-run: a stricter draft is replayed against real history and the diff is shown", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/policies?policy=financial-ops");
    await page.getByTestId("edit-as-new").click();
    const editor = page.getByLabel("Policy document");
    await editor.fill(FIN.replaceAll("value: 1000", "value: 100"));
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await page.getByRole("tab", { name: "Dry-run" }).click();
    await page.getByLabel("Agent (optional)").fill(agentId);
    await page.getByTestId("simulate-run").click();
    await expect(page.getByTestId("sim-changed")).toHaveText("1");
    await expect(page.getByTestId("sim-total")).not.toHaveText("0");
    const row = page.getByRole("row", { name: /payment\.transfer/ });
    await expect(row).toContainText("allow");
    await expect(row).toContainText("require-approval");
    await expect(row).toContainText("small-transfer-allowed");
    await expect(row).toContainText("high-value-transfer-needs-approval");
  });
});
