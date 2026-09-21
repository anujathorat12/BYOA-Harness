import { expect, type Page } from "@playwright/test";

export const KEYS = {
  admin: process.env.E2E_ADMIN_KEY ?? "change-me-admin",
  developer: process.env.E2E_DEV_KEY ?? "change-me-dev",
  approver: process.env.E2E_APPROVER_KEY ?? "change-me-approver",
  auditor: process.env.E2E_AUDITOR_KEY ?? "change-me-auditor",
};
export type RoleName = keyof typeof KEYS;

export const API = process.env.E2E_API ?? "http://localhost:8080";

export async function signIn(page: Page, role: RoleName) {
  await page.goto("/");
  await page.getByLabel("API key").fill(KEYS[role]);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("whoami-name")).toBeVisible();
}

/** Direct API call (as a given role) used by tests to arrange real backend state. */
export async function apiCall<T = unknown>(role: RoleName, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEYS[role]}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
