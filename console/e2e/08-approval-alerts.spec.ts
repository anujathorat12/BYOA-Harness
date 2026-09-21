import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { apiCall, signIn, waitSession, type RoleName } from "./helpers";

const stamp = Date.now();
const agentId = `e2e-alerts-${stamp}`;
const EX = path.resolve(import.meta.dirname, "../../examples");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5180";

/** Stand-ins for the two browser APIs, so the test can SEE that a ding and a notification were requested. */
function installFakes() {
  const w = globalThis as unknown as Record<string, unknown>;
  w.__dings = 0;
  w.__notes = [];
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() {
      return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() { w.__dings = (w.__dings as number) + 1; }, stop() {} };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  class FakeNotification {
    static permission = "granted";
    static requestPermission() { return Promise.resolve("granted"); }
    onclick: (() => void) | null = null;
    constructor(title: string, opts: { body?: string; tag?: string }) { (w.__notes as unknown[]).push({ title, body: opts?.body, tag: opts?.tag }); }
    close() {}
  }
  w.AudioContext = FakeAudioContext;
  w.Notification = FakeNotification;
}

const dings = (p: Page) => p.evaluate(() => (globalThis as unknown as { __dings: number }).__dings);
const notes = (p: Page) => p.evaluate(() => (globalThis as unknown as { __notes: { title: string; body: string; tag: string }[] }).__notes);

async function approverPage(browser: Browser, role: RoleName = "approver") {
  const ctx = await browser.newContext({ baseURL: BASE });
  await ctx.addInitScript(installFakes);
  const page = await ctx.newPage();
  await signIn(page, role);
  return { ctx, page };
}

async function submitFreezing(): Promise<string> {
  return (await apiCall<{ id: string }>("developer", "POST", `/v1/agents/${agentId}/sessions`, { task: {} })).id;
}

async function denyAllPending(sid: string) {
  for (let i = 0; i < 50; i++) {
    const pending = await apiCall<{ id: string; session_id: string }[]>("approver", "GET", "/v1/approvals?status=pending");
    const mine = pending.find((a) => a.session_id === sid);
    if (mine) {
      await apiCall("approver", "POST", `/v1/approvals/${mine.id}/deny`, { comment: "e2e cleanup" });
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await waitSession("developer", sid);
}

test.describe.serial("Approval alerts", () => {
  test.beforeAll(async () => {
    await apiCall("admin", "POST", "/v1/policies", { document: readFileSync(path.join(EX, "policies/enterprise-it.yaml"), "utf8") });
    await apiCall("developer", "POST", "/v1/agents", {
      id: agentId, shape: "package",
      package: { entrypoint: "main:run", files: { "main.py": readFileSync(path.join(EX, "agents/it-ops-agent/main.py"), "utf8") } },
    });
    await apiCall("admin", "POST", `/v1/agents/${agentId}/policies`, { policy_id: "enterprise-it" });
  });

  test("a new approval makes a toast, a ding, a desktop notification and a tab-title badge", async ({ browser }) => {
    const { ctx, page } = await approverPage(browser);
    const toggle = page.getByTestId("alerts-toggle");
    await expect(toggle).toContainText("off");

    await toggle.click(); // the click is what lets a browser play sound and ask for permission
    await expect(toggle).toContainText("Approval alerts on");
    expect(await dings(page)).toBe(2); // a test chime proves it works: two notes

    const sid = await submitFreezing();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Approval needed" })).toBeVisible();
    await expect.poll(() => dings(page)).toBe(4); // one more chime for the new approval
    const n = await notes(page);
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe("Approval needed");
    expect(n[0]!.body).toContain(agentId);
    expect(n[0]!.body).toContain("production.modify");
    await expect(page).toHaveTitle(/^\(1\) Approval needed/);

    await denyAllPending(sid);
    await expect(page).toHaveTitle(/^BYOA Harness/); // badge disappears once nothing is waiting
    await ctx.close();
  });

  test("approvals already waiting when you open the page stay silent", async ({ browser }) => {
    const sid = await submitFreezing();
    for (let i = 0; i < 50; i++) {
      const pending = await apiCall<{ session_id: string }[]>("approver", "GET", "/v1/approvals?status=pending");
      if (pending.some((a) => a.session_id === sid)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const { ctx, page } = await approverPage(browser);
    await page.getByTestId("alerts-toggle").click();
    expect(await dings(page)).toBe(2); // only the test chime
    await page.waitForTimeout(7000); // more than two polling cycles
    expect(await dings(page)).toBe(2);
    expect(await notes(page)).toHaveLength(0);
    await expect(page).toHaveTitle(/^\(1\) Approval needed/); // but the badge still tells the truth
    await denyAllPending(sid);
    await ctx.close();
  });

  test("with alerts off there is a toast but no sound and no notification", async ({ browser }) => {
    const { ctx, page } = await approverPage(browser);
    const sid = await submitFreezing();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Approval needed" })).toBeVisible();
    expect(await dings(page)).toBe(0);
    expect(await notes(page)).toHaveLength(0);
    await denyAllPending(sid);
    await ctx.close();
  });

  test("only people who can decide approvals get the alert control", async ({ page }) => {
    for (const role of ["developer", "auditor"] as const) {
      await signIn(page, role);
      await expect(page.getByTestId("alerts-toggle")).toHaveCount(0);
      await page.getByRole("button", { name: "Sign out" }).click();
    }
  });
});
