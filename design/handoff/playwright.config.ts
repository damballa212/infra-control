import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: "http://127.0.0.1:5176",
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    timezoneId: "America/Bogota",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5176",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "npx vite preview --config vite.config.ts --host 127.0.0.1 --port 4176 --strictPort",
      url: "http://127.0.0.1:4176",
      reuseExistingServer: !process.env.CI,
    },
  ],
  reporter: "list",
});
