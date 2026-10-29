import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5174",
    channel: "chrome",
    headless: true,
    actionTimeout: 15_000,
  },
  reporter: "list",
});
