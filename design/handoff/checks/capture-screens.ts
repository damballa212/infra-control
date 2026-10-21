import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { listScenarios } from "../states/scenarios.ts";
const browser = await chromium.launch();
const base = process.env.FRONTEND_URL ?? "http://127.0.0.1:5176";
const routes = [
  ["control", "/"],
  ["buscar", "/buscar"],
  ["actividad", "/actividad"],
  ["costes", "/costes"],
  ["ajustes", "/ajustes"],
  ["contrasena", "/ajustes/contrasena"],
  ["instalar", "/ajustes/instalar"],
  ["agentes", "/ajustes/agentes"],
  ["acceso", "/acceso?s=login-ok"],
  ["hermes", "/equipo/aws%3Aagents%3Ai-fixture-hermes"],
  ["router", "/equipo/router%3Afiberhome"],
];
const failures: string[] = [];
mkdirSync("screens", { recursive: true });
mkdirSync("states/catalog", { recursive: true });
try {
  for (const width of [320, 390, 834, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: width > 700 ? 1000 : 844 },
      reducedMotion: "reduce",
      timezoneId: "America/Bogota",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    for (const [name, path] of routes) {
      const errors: string[] = [];
      const error = (e: Error) => errors.push(e.message);
      page.on("pageerror", error);
      await page.clock.setFixedTime(new Date("2026-10-21T03:42:00Z"));
      await page.goto(`${base}${path}`);
      await page.getByRole("heading").first().waitFor();
      if (!path.includes("login-ok"))
        await page.locator("main[data-inventory-ready=true]").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () => !document.body.innerText.includes("Calculando el informe…"),
      );
      await page.screenshot({
        path: `screens/${name}-${width}.png`,
        fullPage: true,
      });
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      )
        failures.push(`${name}-${width}: desborde horizontal`);
      failures.push(...errors.map((e) => `${name}-${width}: ${e}`));
      page.off("pageerror", error);
    }
    await context.close();
  }
  writeFileSync(
    "states/catalog/scenarios.json",
    JSON.stringify(
      listScenarios().map(({ id, description }) => ({ id, description })),
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    "screens/report.json",
    JSON.stringify(
      {
        anchor: "2026-10-21T03:42:00Z",
        widths: [320, 390, 834, 1440],
        screens: 44,
        failures,
      },
      null,
      2,
    ) + "\n",
  );
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "44 capturas deterministas; sin desbordes ni errores JavaScript.",
  );
} finally {
  await browser.close();
}
