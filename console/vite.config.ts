import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The backend has no CORS (deliberately). In dev the console is same-origin with the API through this proxy;
// in compose the nginx `console` service does the same job. Nothing in the browser talks cross-origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_DEV_PROXY_TARGET || "http://localhost:8080";
  const proxy = Object.fromEntries(
    ["/v1", "/healthz", "/readyz", "/metrics"].map((p) => [p, { target, changeOrigin: false }]),
  );
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    server: { port: Number(env.VITE_DEV_PORT || 5180), proxy },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
