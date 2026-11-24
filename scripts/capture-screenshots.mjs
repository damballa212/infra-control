// Regenerates docs/screenshots/*.png from the built UI using simulated, neutral data (no real devices involved).
//
//   cd design/handoff && npm ci && npm run build && cd ../..
//   node scripts/capture-screenshots.mjs
//
// Needs Playwright browsers (`npx playwright install chromium` inside design/handoff).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ui = resolve(root, "design/handoff");
const out = resolve(root, "docs/screenshots");
const require = createRequire(resolve(ui, "package.json"));
const { chromium } = require("@playwright/test");
const base = "http://127.0.0.1:4176";

const now = new Date().toISOString();
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const ec2 = (name, account, state, extra = {}) => ({
  id: `aws:${account}:i-${name}`, name, kind: "ec2", state, location: "us-east-1", account, detail: "t3.small",
  actions: state === "running" ? ["stop", "refresh"] : state === "stopped" ? ["start", "refresh"] : ["refresh"],
  observedAt: ago(30), ...extra,
});
const service = (name) => ({
  id: `coolify:${name}`, name, kind: "service", state: "running:healthy", location: "VPS", account: "Coolify",
  detail: "Application", actions: ["refresh"], observedAt: ago(45),
});
const resources = [
  ec2("orchestrator", "agents", "running", { detail: "t4g.large" }),
  ec2("game-server", "agents", "stopped"),
  ec2("prod-cms", "prod", "running"),
  ec2("prod-erp", "prod", "running"),
  ec2("prod-messaging", "prod", "running"),
  service("expenses-app"),
  service("support-desk"),
  { id: "router:fiberhome", name: "FiberHome", kind: "router", state: "reporting", location: "Home network", account: "Home", detail: "Router", actions: ["refresh"], observedAt: ago(8) },
  { id: "computer:desktop", name: "Home PC", kind: "computer", state: "running", system: "windows", location: "Windows / Linux", account: "Home", detail: "Dual boot", actions: ["stop", "boot-windows", "boot-cachyos", "refresh"], observedAt: ago(4) },
  { id: "computer:mac", name: "MacBook", kind: "computer", state: "running", location: "macOS", account: "Personal", detail: "Reporter", actions: [], observedAt: ago(6) },
];
const boot = { desired: "cachyos", effective: "cachyos", state: "applied", version: 4, observedAt: now, verifiedAt: now };

const server = spawn("npx", ["vite", "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", "4176", "--strictPort"], { cwd: ui, stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);
for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch(base)).ok) break; } catch { /* still starting */ }
  await new Promise((done) => setTimeout(done, 500));
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: "UTC", locale: "es" });
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  let data = {};
  if (path === "/api/auth/me") data = { name: "Admin", scopes: ["read", "operate"] };
  if (path === "/api/resources") data = { cursor: 1, fetchedAt: now, resources };
  if (path === "/api/operations") data = { operations: [] };
  if (path === "/api/desktop/boot-preference") data = boot;
  await route.fulfill({ json: data });
});

await page.goto(base);
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(out, "home.png") });

await page.getByRole("link", { name: "Equipos", exact: true }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: resolve(out, "systems.png") });

await page.getByRole("link", { name: "Inicio", exact: true }).click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /^Sistema/ }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(out, "system-picker.png") });

await browser.close();
stop();
console.log(`Screenshots written to ${out}`);
