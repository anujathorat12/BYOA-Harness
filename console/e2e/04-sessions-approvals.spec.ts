import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { apiCall, signIn, waitSession, type RoleName } from "./helpers";

const stamp = Date.now();
const itAgent = `e2e-it-${stamp}`;
const sleeper = `e2e-sleep-${stamp}`;
const EX = path.resolve(import.meta.dirname, "../../examples");
const IT_SRC = readFileSync(path.join(EX, "agents/it-ops-agent/main.py"), "utf8");
const IT_POLICY = readFileSync(path.join(EX, "policies/enterprise-it.yaml"), "utf8");
const BASE = "http://localhost:5180";

async function asRole(browser: Browser, role: RoleName) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await signIn(page, role);
  return { ctx, page };
}

async function submit(role: RoleName, agent: string) {
  return apiCall<{ id: string }>(role, "POST", `/v1/agents/${agent}/sessions`, { task: {} });
}

test.describe.serial("Live sessions and approvals", () => {
  test.beforeAll(async () => {
    await apiCall("admin", "POST", "/v1/policies", { document: IT_POLICY });
    await apiCall("developer", "POST", "/v1/agents", {
      id: itAgent, shape: "package", package: { entrypoint: "main:run", files: { "main.py": IT_SRC } },
    });
    await apiCall("admin", "POST", `/v1/agents/${itAgent}/policies`, { policy_id: "enterprise-it" });
    await apiCall("developer", "POST", "/v1/agents", {
      id: sleeper, shape: "package",
      package: { entrypoint: "main:run", files: { "main.py": "import time\ndef run(ctx):\n    ctx.progress('sleeping')\n    time.sleep(300)\n" } },
    });
    await apiCall("admin", "POST", "/v1/policies", { document: "id: e2e-none\nrules: []" });
    await apiCall("admin", "POST", `/v1/agents/${sleeper}/policies`, { policy_id: "e2e-none" });
  });

  test("submit in the UI, watch it freeze, approve from ANOTHER user, watch it resume live", async ({ page, browser }) => {
    // --- developer alice submits from the console
    await signIn(page, "developer");
    await page.goto("/sessions");
    await page.getByTestId("submit-session").click();
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: new RegExp(itAgent) }).click();
    await page.getByTestId("submit-session-confirm").click();
    await expect(page).toHaveURL(/\/sessions\/ses_/);

    // allowed actions stream in with the rule and policy that decided them
    const readLogs = page.getByTestId("call-1");
    await expect(readLogs).toContainText("data.read");
    await expect(readLogs).toContainText("allow");
    await expect(readLogs.getByTestId("rule-chip")).toHaveText("rule allow-read-logs");
    await expect(readLogs).toContainText("enterprise-it@v1");

    // the session freezes on the production change
    await expect(page.getByTestId("frozen-banner")).toBeVisible();
    await expect(page.getByTestId("frozen-banner")).toContainText("production.modify");
    await expect(page.getByText("frozen · awaiting approval")).toBeVisible();
    await expect(page.getByTestId("call-3")).toContainText("frozen — waiting on a human decision");
    await expect(page.getByTestId("frozen-banner")).toContainText("Only an approver can decide"); // alice's role cannot

    // --- approver bob, a different person in a different browser, approves from the queue
    const bob = await asRole(browser, "approver");
    await bob.page.goto("/approvals");
    await expect(bob.page.getByTestId("pending-badge")).toBeVisible();
    const card = bob.page.locator('[data-testid^="approval-apr_"]', { hasText: itAgent });
    await expect(card).toContainText("production.modify");
    await expect(card.getByTestId("submitted-by")).toHaveText("alice");
    await expect(bob.page.getByTestId("live-panel").getByTestId("frozen-banner")).toBeVisible();
    await card.getByRole("button", { name: "Approve" }).click();
    await bob.page.getByLabel(/Comment/).fill("Change window confirmed with the on-call lead");
    await bob.page.getByTestId("confirm-decision").click();

    // --- alice's page, never reloaded, unfreezes and finishes
    await expect(page.getByTestId("frozen-banner")).toBeHidden();
    await expect(page.getByTestId("call-3").getByTestId("approval-line")).toContainText("approved by bob");
    await expect(page.getByTestId("call-3").getByTestId("approval-line")).toContainText("Change window confirmed");
    await expect(page.getByTestId("call-3")).toContainText("executed in");
    const del = page.getByTestId("call-4");
    await expect(del).toContainText("deny");
    await expect(del.getByTestId("rule-chip")).toHaveText("rule never-delete-prod");
    await expect(del).toContainText("never reached the resource");
    await expect(page.getByTestId("session-result")).toContainText("applied");
    await expect(page.getByTestId("session-result")).toContainText("blocked by rule never-delete-prod");

    // the audit chain for that session is intact
    const sid = page.url().split("/").pop()!;
    expect((await apiCall<{ valid: boolean }>("auditor", "GET", `/v1/audit/sessions/${sid}/verify`)).valid).toBe(true);
    await bob.ctx.close();
  });

  test("deny from the queue: the agent's call fails and the change never happens", async ({ browser }) => {
    const s = await submit("developer", itAgent);
    const bob = await asRole(browser, "approver");
    await bob.page.goto("/approvals");
    const card = bob.page.locator('[data-testid^="approval-apr_"]', { hasText: s.id.slice(0, 12) }).or(bob.page.locator('[data-testid^="approval-apr_"]').first());
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Deny" }).click();
    await bob.page.getByLabel(/Comment/).fill("Not during the freeze");
    await bob.page.getByTestId("confirm-decision").click();
    const done = await waitSession("developer", s.id);
    expect((done.result as { change: string }).change).toBe("not applied (approval_denied)");
    await bob.ctx.close();
  });

  test("separation of duties is visible: the submitter's approve button is disabled with the reason", async ({ browser }) => {
    const s = await submit("admin", itAgent); // admin can both submit and (by role) approve
    const adm = await asRole(browser, "admin");
    await adm.page.goto("/approvals");
    const card = adm.page.locator('[data-testid^="approval-apr_"]').filter({ has: adm.page.getByTestId("submitted-by").filter({ hasText: "admin" }) });
    await expect(card).toBeVisible();
    const gated = card.locator("[data-blocked-reason]").first();
    await expect(gated).toHaveAttribute("data-blocked-reason", /Separation of duties/);
    await expect(gated.getByRole("button")).toBeDisabled();
    // the server enforces it too
    const pending = await apiCall<{ id: string; session_id: string }[]>("admin", "GET", "/v1/approvals?status=pending");
    const mine = pending.find((a) => a.session_id === s.id)!;
    await expect(apiCall("admin", "POST", `/v1/approvals/${mine.id}/approve`, { comment: "self" })).rejects.toThrow(/403/);
    await apiCall("approver", "POST", `/v1/approvals/${mine.id}/deny`, { comment: "cleanup" });
    await waitSession("admin", s.id);
    await adm.ctx.close();
  });

  test("a developer cannot see the approval queue", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/approvals");
    await expect(page.getByText("The approval queue is not available to your role")).toBeVisible();
  });

  test("cancel a running session from the console", async ({ page }) => {
    const s = await submit("developer", sleeper);
    await signIn(page, "developer");
    await page.goto(`/sessions/${s.id}`);
    await expect(page.getByTestId("timeline")).toContainText("sleeping");
    await page.getByTestId("cancel-session").click();
    await expect(page.getByText("cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("cancel-session").locator("..")).toHaveAttribute("data-blocked-reason", /already finished/);
  });

  test("sessions list is live, filterable, and marks frozen sessions for privileged roles", async ({ page }) => {
    const s = await submit("developer", itAgent);
    await signIn(page, "auditor");
    await page.goto("/sessions");
    const row = page.getByRole("row", { name: new RegExp(s.id.slice(0, 12)) });
    await expect(row).toContainText("frozen · awaiting approval");
    await page.getByLabel("Agent filter").fill("no-such-agent");
    await expect(page.getByText("No sessions yet")).toBeVisible();
    // release the agent so the sandbox does not linger
    const pending = await apiCall<{ id: string; session_id: string }[]>("approver", "GET", "/v1/approvals?status=pending");
    await apiCall("approver", "POST", `/v1/approvals/${pending.find((a) => a.session_id === s.id)!.id}/deny`, { comment: "cleanup" });
  });
});
