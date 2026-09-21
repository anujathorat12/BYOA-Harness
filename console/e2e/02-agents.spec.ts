import { expect, test } from "@playwright/test";
import { apiCall, signIn } from "./helpers";

const stamp = Date.now();
const pkgId = `e2e-pkg-${stamp}`;
const declId = `e2e-decl-${stamp}`;
const policyId = `e2e-pol-${stamp}`;

test.describe.serial("Agent Registry", () => {
  test("developer registers a package agent; it shows as deny-all", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/agents");
    await page.getByTestId("register-agent").click();
    await page.getByLabel("Agent id").fill(pkgId);
    await page.getByLabel("Description").fill("registered from the console e2e");
    await page.getByTestId("register-submit").click();
    const row = page.getByRole("row", { name: new RegExp(pkgId) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("package");
    await expect(row).toContainText("deny-all");
    await expect(row).toContainText("alice");
  });

  test("developer sees policy controls disabled with the reason, and the server agrees", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/agents");
    await page.getByRole("row", { name: new RegExp(pkgId) }).click();
    await expect(page.getByTestId("deny-all-note")).toBeVisible();
    const gated = page.locator("[data-blocked-reason]", { hasText: "Attach policy" });
    await expect(gated).toHaveAttribute("data-blocked-reason", /Requires role: admin/);
    await expect(gated.getByRole("button")).toBeDisabled();
    // the UI is not the enforcement: the API refuses the same call for this role
    await expect(apiCall("developer", "POST", `/v1/agents/${pkgId}/policies`, { policy_id: "x" })).rejects.toThrow(/403/);
  });

  test("admin attaches then detaches a policy", async ({ page }) => {
    await apiCall("admin", "POST", "/v1/policies", { document: `id: ${policyId}\nrules: []` });
    await signIn(page, "admin");
    await page.goto("/agents");
    await page.getByRole("row", { name: new RegExp(pkgId) }).click();
    await page.getByRole("combobox", { name: "Policy to attach" }).click();
    await page.getByRole("option", { name: policyId }).click();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await expect(page.getByTestId(`attached-${policyId}`)).toContainText("follows latest");
    await page.getByRole("button", { name: `Detach ${policyId}` }).click();
    await expect(page.getByTestId("deny-all-note")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("row", { name: new RegExp(pkgId) })).toContainText("deny-all");
  });

  test("declarative agent from YAML; server-side validation errors are shown verbatim", async ({ page }) => {
    await signIn(page, "developer");
    await page.goto("/agents");
    await page.getByTestId("register-agent").click();
    await page.getByLabel("Agent id").fill(declId);
    await page.getByRole("combobox", { name: "Shape" }).click();
    await page.getByRole("option", { name: /declarative/ }).click();
    await page.getByLabel("Spec (YAML or JSON)").fill("steps:\n  - id: bad\n    call: data.read\n    llm: also-an-llm-step\n");
    await page.getByTestId("register-submit").click();
    await expect(page.getByRole("alert")).toContainText("exactly one of");

    await page.getByLabel("Spec (YAML or JSON)").fill("steps:\n  - id: r\n    call: data.read\n    args: { dataset: prod.logs }\n  - return: { r: \"${r.records}\" }\n");
    await page.getByTestId("register-submit").click();
    const row = page.getByRole("row", { name: new RegExp(declId) });
    await expect(row).toContainText("declarative");
  });

  test("auditor cannot register agents", async ({ page }) => {
    await signIn(page, "auditor");
    await page.goto("/agents");
    await expect(page.locator("[data-blocked-reason]", { hasText: "Register agent" })).toHaveAttribute("data-blocked-reason", /developer/);
  });
});
