import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCall, runSession, signIn } from "./helpers";

const stamp = Date.now();
const agentId = `e2e-audit-${stamp}`;
const IT_POLICY = readFileSync(path.resolve(import.meta.dirname, "../../examples/policies/enterprise-it.yaml"), "utf8");
const DB = process.env.E2E_DB_CONTAINER ?? "sunday-harness-db-1";
let sessionId = "";

const psql = (sql: string) => execFileSync("docker", ["exec", DB, "psql", "-U", "harness", "-d", "harness", "-At", "-c", sql], { encoding: "utf8" }).trim();
const dbAvailable = (() => { try { return psql("select 1") === "1"; } catch { return false; } })();

test.describe.serial("Audit log", () => {
  test.beforeAll(async () => {
    await apiCall("admin", "POST", "/v1/policies", { document: IT_POLICY });
    await apiCall("developer", "POST", "/v1/agents", {
      id: agentId, shape: "declarative",
      spec: { steps: [
        { id: "logs", call: "data.read", args: { dataset: "prod.logs" } },
        { id: "del", call: "production.delete", args: { service: "payments-db" }, on_denied: "continue" },
        { return: { del: "${del}" } },
      ] },
    });
    await apiCall("admin", "POST", `/v1/agents/${agentId}/policies`, { policy_id: "enterprise-it" });
    const s = await runSession("developer", agentId);
    expect(s.status).toBe("succeeded");
    sessionId = s.id;
  });

  test("newest first; filter by decision; drill down to the exact rule and policy version", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto(`/audit?agent_id=${agentId}`);
    const firstRow = page.getByRole("row").nth(1);
    await expect(firstRow).toContainText("session.finished"); // newest first

    await page.getByRole("combobox", { name: "Decision" }).click();
    await page.getByRole("option", { name: "deny" }).click();
    await page.getByTestId("apply-filters").click();
    await expect(page).toHaveURL(/effect=deny/);
    const rows = page.getByRole("row").filter({ hasText: "production.delete" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("never-delete-prod");
    await expect(rows.first()).toContainText("enterprise-it@v1");
    await expect(page.getByRole("row").filter({ hasText: "allow" })).toHaveCount(0);

    await rows.first().click();
    const drill = page.getByTestId("audit-drilldown");
    await expect(drill.getByTestId("drill-rule")).toHaveText("never-delete-prod");
    await expect(drill.getByTestId("drill-policy")).toHaveText("enterprise-it@v1");
    await expect(drill).toContainText("Destructive production operations are not permitted");
    await expect(drill).toContainText("payments-db"); // canonical action
    await drill.getByRole("link", { name: /view this exact version/ }).click();
    await expect(page).toHaveURL(/\/policies\?policy=enterprise-it&version=1/);
    await expect(page.getByRole("heading", { name: /enterprise-it v1/ })).toBeVisible();
  });

  test("verify the hash chain from a session-scoped link", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto(`/audit?session_id=${sessionId}`);
    await page.getByTestId("verify-chain").click();
    await expect(page.getByTestId("chain-result")).toContainText("Chain intact");
  });

  test("tampering with a stored row is detected and shown as BROKEN (row restored afterwards)", async ({ page }) => {
    test.skip(!dbAvailable, `database container ${DB} not reachable via docker exec`);
    const original = psql(`select payload::text from audit_events where session_id='${sessionId}' and seq=2`);
    try {
      psql(`update audit_events set payload='{"tampered":true}' where session_id='${sessionId}' and seq=2`);
      await signIn(page, "auditor");
      await page.goto(`/audit?session_id=${sessionId}`);
      await page.getByTestId("verify-chain").click();
      await expect(page.getByTestId("chain-result")).toContainText("Chain BROKEN");
      await expect(page.getByTestId("chain-result")).toContainText("sequence 2");
    } finally {
      psql(`update audit_events set payload='${original.replaceAll("'", "''")}' where session_id='${sessionId}' and seq=2`);
    }
    await page.getByTestId("verify-chain").click();
    await expect(page.getByTestId("chain-result")).toContainText("Chain intact"); // restored: valid again
  });

  test("cursor paging: older events load on demand", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/audit");
    const count = () => page.getByRole("row").count();
    await expect(page.getByTestId("load-older")).toBeVisible();
    const before = await count();
    await page.getByTestId("load-older").click();
    await expect.poll(count).toBeGreaterThan(before);
  });

  test("approver may read the log but cannot verify chains; developer cannot open it", async ({ page }) => {
    await signIn(page, "approver");
    await page.goto(`/audit?session_id=${sessionId}`);
    await expect(page.getByRole("row").nth(1)).toBeVisible();
    await expect(page.locator("[data-blocked-reason]", { hasText: "Verify hash chain" })).toHaveAttribute("data-blocked-reason", /auditor/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, "developer");
    await page.goto("/audit");
    await expect(page.getByText("The audit log is not available to your role")).toBeVisible();
  });
});
