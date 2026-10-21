import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function holdConfirm(page: import('@playwright/test').Page) {
  const key = page.getByRole('button', { name: /Mantén pulsado/ });
  const box = (await key.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await page.mouse.up();
}
const hermes = "aws:agents:i-fixture-hermes";
test("Control, búsqueda y navegación funcionan sin desbordes a 320, 390 y escritorio", async ({
  page,
}) => {
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 });
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Inicio", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("PROTOTIPO · datos simulados · sin acciones reales"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Equipos", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Equipos", exact: true }).click();
  await page.getByRole("searchbox").fill("game");
  await expect(
    page.getByText("game-server", { exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("no-existe");
  await expect(
    page.getByRole("heading", { name: "Nada coincide con «no-existe»" }),
  ).toBeVisible();
});
test("energía requiere confirmación, doble click no duplica, la orden sobrevive a navegar", async ({
  page,
}) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}?s=power-succeeds`);
  await page.getByRole("button", { name: "Apagar", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Apagar", exact: true }).click();
  await holdConfirm(page);
  await expect(page).toHaveURL(/actividad\/op_/);
  await page.getByRole("link", { name: "Costes", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Orden pendiente" }),
  ).toBeVisible();
  await page
    .getByRole("complementary", { name: "Orden pendiente" })
    .getByRole("link")
    .click();
  await expect(
    page.getByText("AWS confirmó la instancia detenida.", { exact: true }),
  ).toBeVisible({ timeout: 18000 });
});
test("envío ambiguo nunca reintenta automáticamente y recupera la misma orden", async ({
  page,
}) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}?s=power-ambiguous`);
  await page.getByRole("button", { name: "Apagar", exact: true }).click();
  await holdConfirm(page);
  await expect(
    page.getByText("No sabemos si el envío llegó", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apagar", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Recuperar el mismo envío" }).click();
  await expect(
    page.getByText("No sabemos si el envío llegó", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Actividad", exact: true }).click();
  await expect(
    page.getByRole("link").filter({ hasText: "Apagar orchestrator" }),
  ).toHaveCount(2); // fixture histórico + una única intención nueva
});
test("costes parciales no se incluyen en el total y null sigue ausente", async ({
  page,
}) => {
  await page.goto("/costes?s=costs-partial");
  await expect(page.getByText("SUBTOTAL · 2 CUENTAS COMPLETAS")).toBeVisible();
  await expect(page.getByText("US$ 22,50", { exact: true })).toBeVisible();
  await page.goto("/costes?s=costs-first-day");
  await expect(page.getByText("Calculando el informe…")).toHaveCount(0);
  await expect(page.locator(".t-h1").filter({ hasText: "—" })).toBeVisible();
});
test("sesión caducada elimina recursos, actividad y costes privados", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/?s=session-expires");
  await expect(
    page.getByRole("heading", { name: "Hermes", exact: true }).first(),
  ).toBeVisible();
  await page.clock.runFor(61000);
  await expect(
    page.getByRole("heading", { name: "Entrar", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("prod-cms", { exact: true })).toHaveCount(0);
});
test("offline desactiva escrituras y no ofrece cola", async ({
  page,
  context,
}) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}`);
  await expect(
    page.getByRole("button", { name: "Apagar", exact: true }),
  ).toBeEnabled();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Apagar", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Sin conexión", { exact: true }).first(),
  ).toBeVisible();
});
test("acceso, estados y pantallas principales cumplen axe WCAG AA", async ({
  page,
}) => {
  for (const path of [
    "/",
    "/buscar",
    "/actividad",
    "/costes",
    "/ajustes",
    "/acceso?s=login-ok",
    `/equipo/${encodeURIComponent(hermes)}`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible();
    if (!path.includes("login-ok"))
      await page.locator("main[data-inventory-ready=true]").waitFor();
    if (path === "/actividad")
      await expect(page.getByText("Falló", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  }
});
