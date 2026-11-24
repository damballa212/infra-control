import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const FAKE = "FAKE_ONLY_0123456789abcdef0123456789abcdef";
test("intake humano, permiso y revocación sin valores ni desbordes", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.goto("/"); await page.locator("main[data-inventory-ready=true]").waitFor();
    await expect(page.getByText("MacBook Air pide una clave", { exact: true })).toBeVisible(); await page.goto("/secretos");
    await expect(page.getByRole("heading", { name: "Agentes", exact: true })).toBeVisible(); await expect(page.getByText("OPENAI_API_KEY").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: /OPENAI_API_KEY/ }).first().click(); await expect(page.getByRole("heading", { name: "MacBook Air pide OPENAI_API_KEY", exact: true })).toBeVisible(); await expect(page.getByText(/^vence en \d+ min$/)).toBeVisible();
  const field = page.getByLabel("Valor de la clave"); await expect(field).toHaveAttribute("type", "password"); await expect(page.getByRole("button", { name: "Aprobar y entregar" })).toBeDisabled();
  await field.fill(FAKE); await page.getByRole("radio", { name: /^Este equipo/ }).check(); await page.getByRole("button", { name: "Aprobar y entregar" }).click();
  await expect(page.getByText("Aprobada, por entregar", { exact: true })).toBeVisible(); await expect(page.getByRole("status", { name: "Resultado de la petición" })).toContainText("El agente la recogerá antes de"); await expect(page.getByRole("link", { name: "Volver a Agentes", exact: true })).toBeVisible(); await expect(page.getByLabel("Valor de la clave")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(FAKE); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("main").getByRole("link", { name: "Agentes", exact: true }).click(); const permissions = page.getByRole("region", { name: "Permisos", exact: true });
  await expect(permissions.getByRole("button", { name: "Revocar", exact: true })).toHaveCount(1); await permissions.getByRole("button", { name: "Revocar", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("credencial seguirá vigente"); await page.getByRole("button", { name: "Confirmar revocación", exact: true }).click();
  await expect(permissions.getByRole("button", { name: "Revocar", exact: true })).toHaveCount(0);
});
test("denegar cierra la petición", async ({ page }) => {
  await page.goto("/secretos/sec_pending1"); await page.getByRole("button", { name: "Denegar", exact: true }).click();
  await expect(page.getByText("Denegada", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Aprobar y entregar" })).toHaveCount(0);
});
test("seleccionar metadatos guardados y pantallas de agentes accesibles", async ({ page }) => {
  await page.goto("/secretos/sec_pending1"); await page.getByRole("button", { name: "Elegir guardada", exact: true }).click();
  await page.getByRole("radio", { name: /OPENAI_API_KEY/ }).check(); await expect(page.getByRole("button", { name: "Aprobar y entregar" })).toBeEnabled();
  for (const path of ["/secretos", "/secretos/sec_pending1"]) {
    await page.goto(path); await expect(page.getByRole("heading").first()).toBeVisible(); await page.evaluate(() => document.fonts.ready);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  }
});
