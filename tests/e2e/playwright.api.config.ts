import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/qa-gate-operational-api.spec.ts",
  timeout: 45_000,
  retries: 0,
  use: { headless: true },
  projects: [
    {
      name: "api",
    },
  ],
  reporter: [["list"]],
});
