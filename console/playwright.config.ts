import { defineConfig } from "@playwright/test";

// End-to-end tests run a REAL browser (Edge/Chrome) against the Vite dev server, which proxies to a REAL harness
// (`docker compose up`). No mocks anywhere. Override keys with E2E_ADMIN_KEY etc.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5180",
    channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Set E2E_BASE_URL (e.g. http://localhost:8081) to test the compose-served console instead of the dev server.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev -- --strictPort", url: "http://localhost:5180", reuseExistingServer: true, timeout: 60_000 },
});
