import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const hermes = "aws:agents:i-fixture-hermes";
async function holdConfirm(page: Page) { const button = page.getByRole("button", { name: /Mantén pulsado/ }); const box = (await button.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(1700); await page.mouse.up(); }
test("Hoy, inventario y búsqueda sin desbordes en móvil y escritorio", async ({ page }) => {
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 }); await page.goto("/");
    await expect(page.getByRole("link", { name: "Hoy", exact: true })).toBeVisible();
    await expect(page.getByText("PROTOTIPO · datos simulados · sin acciones reales")).toBeVisible();
    await expect(page.getByRole("link", { name: "Inventario", exact: true })).toBeVisible();
    await page.locator('main[data-inventory-ready=true]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({ width: innerWidth, x: scrollX, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')].map(element => { const box = element.getBoundingClientRect(); return { tag: element.tagName, cls: element.className, text: element.textContent?.slice(0, 100), right: box.right, width: box.width, scroll: element.scrollWidth, client: element.clientWidth }; }).filter(box => box.width > 0 && (box.right > innerWidth + 1 || box.scroll > box.client + 1)).slice(-12) }));
    expect(layout.scroll <= layout.width, JSON.stringify(layout)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/buscar");
  await page.getByRole("searchbox").fill("game"); await expect(page.getByText("game-server", { exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("no-existe"); await expect(page.getByRole("heading", { name: "Nada coincide con «no-existe»" })).toBeVisible();
});
test("energía exige confirmación, gesto único y la orden sobrevive a navegar", async ({ page }) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}?s=power-succeeds`); await page.getByRole("button", { name: "Apagar", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Apagar", exact: true }).click(); await holdConfirm(page);
  // La orden se sigue en el sitio (202 no es éxito) y su detalle está a un toque.
  await expect(page.getByRole("status", { name: /^Orden / })).toBeVisible(); await page.getByRole("main").getByRole("link", { name: "Detalle", exact: true }).click(); await expect(page).toHaveURL(/actividad\/op_/);
  await page.getByRole("link", { name: "Agentes", exact: true }).click(); await expect(page.getByRole("complementary", { name: "Orden pendiente" })).toBeVisible();
  await page.getByRole("complementary", { name: "Orden pendiente" }).getByRole("link").click();
  await expect(page.getByText("AWS confirmó la instancia detenida.", { exact: true }).first()).toBeVisible({ timeout: 18000 });
});
test("envío ambiguo no se repite y recupera la misma intención", async ({ page }) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}?s=power-ambiguous`); await page.getByRole("button", { name: "Apagar", exact: true }).click(); await holdConfirm(page);
  await expect(page.getByText("No sabemos si el envío llegó", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Apagar", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Recuperar el mismo envío" }).click(); await expect(page.getByText("No sabemos si el envío llegó", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Actividad", exact: true }).click(); await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await expect(page.getByRole("link").filter({ hasText: "Apagar orchestrator" })).toHaveCount(2);
});
test("costes parciales se excluyen y null permanece ausente", async ({ page }) => {
  await page.goto("/costes?s=costs-partial"); await expect(page.getByText("Subtotal · 2 de 3 cuentas")).toBeVisible();
  await expect(page.locator(".cost-table").getByText("parcial · no se suma").first()).toBeVisible(); await expect(page.getByText("US$ 22,50", { exact: true })).toBeVisible();
  await page.goto("/costes?s=costs-first-day"); await expect(page.locator(".sc-cost-total")).toHaveText("—");
});
test("sesión caducada limpia el árbol privado", async ({ page }) => {
  await page.clock.install(); await page.goto("/?s=session-expires"); await page.locator("main[data-inventory-ready=true]").waitFor();
  await expect(page.getByText("FiberHome", { exact: true })).toBeVisible(); await page.clock.runFor(61000);
  await expect(page.getByRole("heading", { name: "Hola, Admin", exact: true })).toBeVisible(); await expect(page.getByText("prod-cms", { exact: true })).toHaveCount(0); await expect(page.getByText("FiberHome", { exact: true })).toHaveCount(0);
});
test("offline bloquea escrituras sin cola", async ({ page, context }) => {
  await page.goto(`/equipo/${encodeURIComponent(hermes)}`); await expect(page.getByRole("button", { name: "Apagar", exact: true })).toBeEnabled(); await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Apagar", exact: true })).toBeDisabled(); await expect(page.getByText("Sin conexión", { exact: true }).first()).toBeVisible();
});
test("pantallas principales cumplen axe WCAG AA", async ({ page }) => {
  test.setTimeout(120000); // Once rutas con auditoría completa, secuenciales en la EC2.
  for (const path of ["/", "/buscar", "/inventario", "/inventario/mapa", "/actividad", "/costes", "/ajustes", "/tu", "/agentes", "/acceso?s=login-ok", `/equipo/${encodeURIComponent(hermes)}`]) {
    await page.goto(path); await expect(page.getByRole("heading").first()).toBeVisible();
    if (!path.includes("login-ok")) await page.locator("main[data-inventory-ready=true]").waitFor();
    if (path === "/actividad") await expect(page.getByText("Falló", { exact: true }).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  }
});
test("ajustes ofrece avisos con área táctil accesible", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Notification, "permission", { get: () => "default" })); await page.goto("/tu/dispositivos");
  const button = page.getByRole("button", { name: "Activar avisos en este teléfono" }); await expect(button).toBeVisible(); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(result.violations.map(v => v.id)).toEqual([]);
});
test("ajustes explica notificaciones bloqueadas", async ({ page }) => { await page.goto("/tu/dispositivos"); await expect(page.getByText(/permiso de notificaciones está bloqueado/)).toBeVisible(); });
test("mapa interactivo, catálogo lógico y detalle único", async ({ page }) => {
  await page.goto("/inventario/mapa"); const canvas = page.getByRole("application");
  await expect(canvas).toHaveCSS("touch-action", "none"); await expect(canvas).toHaveAttribute("data-level", "zones");
  const before = await page.evaluate(() => scrollY); const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 6 }); await page.mouse.up();
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await page.getByRole("button", { name: "Seleccionar prod-erp", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector del mapa" })).toContainText("prod-erp");
  await expect(canvas).toHaveAttribute("data-level", "nodes");
  await page.getByRole("button", { name: "Encuadrar", exact: true }).click(); await expect(canvas).toHaveAttribute("data-zoom", "100");
  await page.getByRole("button", { name: "Acercar mapa" }).click(); await expect(canvas).toHaveAttribute("data-zoom", "125");
  const label = await page.locator(".inv-chip__name").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize)); expect(label).toBeGreaterThanOrEqual(11);
  await page.getByRole("button", { name: "Proyecto", exact: true }).click(); await page.getByRole("searchbox").fill("Rendición branch");
  await page.getByRole("button", { name: "Seleccionar Rendición branch", exact: true }).click(); await page.getByRole("link", { name: "Ver detalle", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rendición branch", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Apagar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link").filter({ hasText: "prod-erp" }).first()).toBeVisible();
});
test("«1 falla» de Hoy abre Equipos con el fallo arriba", async ({ page }) => {
  await page.goto("/inventario/equipos/problemas"); await expect(page.getByRole("heading", { name: /^1 falla/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Primero lo que falla" }).getByRole("link").first()).toContainText("prod-erp");
  await page.getByRole("button", { name: /Quitar filtro/ }).click(); await expect(page).toHaveURL(/\/inventario\/equipos$/);
});
test("Tú distingue estado, dispositivos y ajustes y conserva aliases", async ({ page }) => {
  await page.goto("/tu"); await expect(page.getByRole("heading", { name: /^Fuentes del inventario/ })).toBeVisible(); await expect(page.getByText("3 de 4 leen bien", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Dispositivos y avisos", exact: true }).click(); await expect(page.getByRole("heading", { name: "Este navegador", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ajustes", exact: true }).click(); await expect(page.getByRole("link", { name: /^Contraseña/ })).toBeVisible();
  await page.goto("/ajustes/agentes"); await expect(page.getByRole("heading", { name: "Agentes", exact: true })).toBeVisible(); await expect(page.getByText("El equipo está verificado; agente y motivo los declara él.", { exact: true })).toBeVisible();
});
