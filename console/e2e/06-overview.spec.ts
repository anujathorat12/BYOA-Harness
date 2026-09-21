import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCall, signIn, waitSession } from "./helpers";

const stamp = Date.now();
const agentId = `e2e-ops-${stamp}`;
const EX = path.resolve(import.meta.dirname, "../../examples");

test.describe.serial("Overview / Ops", () => {
  test.beforeAll(async () => {
    await apiCall("admin", "POST", "/v1/policies", { document: readFileSync(path.join(EX, "policies/enterprise-it.yaml"), "utf8") });
    await apiCall("developer", "POST", "/v1/agents", {
      id: agentId, shape: "package",
      package: { entrypoint: "main:run", files: { "main.py": readFileSync(path.join(EX, "agents/it-ops-agent/main.py"), "utf8") } },
    });
    await apiCall("admin", "POST", `/v1/agents/${agentId}/policies`, { policy_id: "enterprise-it" });
  });

  test("a frozen session shows up as approval backlog and as a frozen active session, then clears", async ({ page }) => {
    const s = await apiCall<{ id: string }>("developer", "POST", `/v1/agents/${agentId}/sessions`, { task: {} });
    await signIn(page, "approver");
    await page.goto("/");

    await expect(page.getByTestId("stat-approvals")).not.toHaveText("0");
    const mine = page.getByTestId("active-sessions").getByRole("row", { name: new RegExp(s.id.slice(0, 12)) });
    await expect(mine).toContainText("frozen · awaiting approval");
    await expect(mine).toContainText(agentId);
    await expect(mine).toContainText("MB"); // resource limits of the sandbox

    // deny it through the API (as bob); the overview updates on its own without a reload
    const pending = await apiCall<{ id: string; session_id: string }[]>("approver", "GET", "/v1/approvals?status=pending");
    await apiCall("approver", "POST", `/v1/approvals/${pending.find((a) => a.session_id === s.id)!.id}/deny`, { comment: "overview e2e" });
    await waitSession("developer", s.id);
    await expect(mine).toBeHidden();
  });

  test("recent denials list the rule that blocked the action", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/");
    const denials = page.getByTestId("recent-denials");
    await expect(denials).toContainText("never-delete-prod");
    await expect(denials).toContainText("enterprise-it@v1");
    await denials.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/sessions\/ses_/);
  });

  test("decision counters and health reflect the live platform", async ({ page }) => {
    await signIn(page, "admin");
    const counts = page.getByTestId("decision-counts");
    await expect(counts).toContainText("deny");
    await expect(counts).toContainText("require-approval");
    await expect(page.getByTestId("health-card")).toContainText("ok");
    await expect(page.locator("aside")).toContainText("Harness ready");
  });
});
