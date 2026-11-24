import { test, expect, type Page } from "@playwright/test";
import type { BootPreference, Operation, Resource } from "../ui/src/contract.ts";
import { makeCosts, makeResources } from "../states/fixtures.ts";
test.use({ baseURL: "http://127.0.0.1:4176" });
async function holdConfirm(page: Page) { const key = page.getByRole("button", { name: /Mantén pulsado/ }); const box = (await key.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(1700); await page.mouse.up(); }
const now = () => new Date().toISOString();
function pc(state: string, system: "windows" | "cachyos", actions: Resource["actions"]): Resource { return { id: "computer:desktop", name: "PC de casa", kind: "computer", state, system, actions, observedAt: now(), account: "Casa", location: "Windows / CachyOS", detail: "Dual boot" }; }
async function desktopApi(page: Page, resource: Resource, initialBoot?: BootPreference) {
  const orders: { body: unknown; key: string | undefined }[] = []; const preferences: { body: unknown; key: string | undefined }[] = []; const sequence: string[] = [];
  let boot = initialBoot; let saved: Operation | null = null;
  await page.route("**/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; let data: unknown;
    if (path === "/api/auth/me") data = { name: "Admin", scopes: ["read", "operate"] };
    else if (path === "/api/resources") data = { cursor: 1, fetchedAt: now(), refreshSeconds: 60, resources: [resource] };
    else if (path === "/api/operations" && req.method() === "GET") data = { operations: saved ? [saved] : [] };
    else if (path === "/api/operations" && req.method() === "POST") {
      const body = req.postDataJSON() as { action: Operation["action"] }; orders.push({ body, key: req.headers()["idempotency-key"] }); sequence.push("orden:" + body.action);
      saved = { id: "desktop-order", resourceId: resource.id, resourceName: resource.name, action: body.action, actor: "admin", state: "accepted", message: "Orden registrada", createdAt: now(), updatedAt: now() }; data = saved;
    } else if (path === "/api/operations/desktop-order/history") data = { events: [] };
    else if (path === "/api/operations/desktop-order") data = saved && { ...saved, state: "running", message: "Comprobando sistema" };
    else if (path === "/api/desktop/boot-preference" && req.method() === "GET" && boot) data = boot;
    else if (path === "/api/desktop/boot-preference" && req.method() === "POST" && boot) {
      const body = req.postDataJSON() as { system: "windows" | "cachyos"; expectedVersion: number };
      preferences.push({ body, key: req.headers()["idempotency-key"] }); sequence.push(`preferencia:${body.system}:v${body.expectedVersion}`);
      boot = { ...boot, desired: body.system, effective: body.system, version: boot.version + 1 }; data = boot;
    } else if (path === "/api/secrets/requests") data = { requests: [] };
    else { await route.fulfill({ status: 404, json: { error: "No disponible" } }); return; }
    await route.fulfill({ status: path === "/api/operations" && req.method() === "POST" ? 202 : 200, json: data, headers: { "Cache-Control": "no-store" } });
  });
  return { orders, preferences, sequence };
}
test("HTTP: sesión, 202 incierto y PWA sin datos privados cacheados", async ({ page, context }) => {
  let signedIn = false; let writes = 0; let saved: Operation | null = null;
  const anchor = Date.parse("2026-10-21T03:42:00Z"); const resources = makeResources(anchor);
  await context.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname; const headers = { "Cache-Control": "no-store" };
    if (path === "/api/auth/login") { signedIn = true; await route.fulfill({ json: { name: "Admin" }, headers }); return; }
    if (!signedIn) { await route.fulfill({ status: 401, json: { error: "Sesión requerida" }, headers }); return; }
    if (path === "/api/auth/me") { await route.fulfill({ json: { name: "Admin" }, headers }); return; }
    if (path === "/api/resources") { await route.fulfill({ json: { resources, fetchedAt: new Date(anchor).toISOString(), refreshSeconds: 60, cursor: 0 }, headers }); return; }
    if (path === "/api/auth/logout") { signedIn = false; await route.fulfill({ status: 401, json: { error: "Sesión caducada" } }); return; }
    if (path === "/api/operations" && route.request().method() === "POST") {
      writes++; expect(route.request().headers()["idempotency-key"]).toBeTruthy(); saved = { id: "real-contract-order", resourceId: resources[0]!.id, resourceName: resources[0]!.name, action: "stop", actor: "admin", state: "uncertain", message: "AWS no confirmó la recepción de la orden.", createdAt: now(), updatedAt: now() }; await route.fulfill({ status: 202, json: saved, headers }); return;
    }
    if (path === "/api/operations/real-contract-order/history") { await route.fulfill({ json: { events: [] }, headers }); return; }
    if (path === "/api/operations/real-contract-order" && saved) { await route.fulfill({ json: saved, headers }); return; }
    if (path === "/api/operations") { await route.fulfill({ json: { operations: saved ? [saved] : [] }, headers }); return; }
    if (path === "/api/costs") { await route.fulfill({ json: makeCosts(anchor), headers }); return; }
    if (path === "/api/secrets/requests") { await route.fulfill({ json: { requests: [] }, headers }); return; }
    if (path === "/api/catalog/services") { await route.fulfill({ json: { services: [], fetchedAt: now() }, headers }); return; }
    await route.fulfill({ status: 404, json: { error: "No disponible" }, headers });
  });
  await page.goto("/?s=normal"); await expect(page.getByRole("heading", { name: "Hola, Admin", exact: true })).toBeVisible(); await expect(page.getByText("PROTOTIPO · datos simulados · sin acciones reales")).toHaveCount(0);
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-only-password"); await page.getByRole("button", { name: "Entrar", exact: true }).click(); await expect(page.getByRole("link", { name: "Hoy", exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(req => new URL(req.url).pathname)))).flat());
  expect(cached).toContain("/index.html"); expect(cached.some(path => path.startsWith("/api/"))).toBe(false);
  await page.goto(`/equipo/${encodeURIComponent(resources[0]!.id)}`); await page.getByRole("button", { name: "Apagar", exact: true }).click(); await holdConfirm(page);
  await expect(page.getByText("AWS no confirmó la recepción de la orden.", { exact: true }).first()).toBeVisible(); await expect(page.getByText("Sin confirmar", { exact: true }).first()).toBeVisible(); expect(writes).toBe(1);
  await page.goto("/ajustes"); await page.getByRole("button", { name: "Cerrar sesión en este dispositivo" }).click(); await expect(page.getByRole("heading", { name: "Hola, Admin", exact: true })).toBeVisible();
  await page.getByLabel("Contraseña", { exact: true }).fill("synthetic-only-password"); await page.getByRole("button", { name: "Entrar", exact: true }).click(); await expect(page.getByRole("link", { name: "Hoy", exact: true })).toBeVisible();
  await context.setOffline(true); await page.reload(); await expect(page.getByText("Sin conexión", { exact: true })).toBeVisible(); await expect(page.getByText("prod-cms", { exact: true })).toHaveCount(0); expect(writes).toBe(1);
});
test("PC: SO requiere confirmación y una intención", async ({ page }) => {
  const calls = await desktopApi(page, pc("running", "cachyos", ["stop", "boot-windows", "refresh"])); await page.goto("/");
  await expect(page.getByRole("button", { name: /^Encender/ })).toHaveCount(0); const power = page.getByRole("button", { name: "Apagar", exact: true }); await expect(power).toBeEnabled();
  await expect(page.getByText("CachyOS", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Sistema: CachyOS ▾", exact: true }).click(); await page.getByRole("button", { name: "Windows", exact: true }).click();
  expect(calls.orders).toHaveLength(0); await expect(page.getByRole("alertdialog")).toContainText("Guarda tu trabajo"); await page.getByRole("button", { name: "Reiniciar en Windows", exact: true }).click();
  await expect.poll(() => calls.orders.length).toBe(1); expect(calls.orders[0]?.body).toEqual({ resourceId: "computer:desktop", action: "boot-windows", confirmed: true }); expect(calls.orders[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/);
});
test("PC sin señal a 320px: encender y elegir SO, sin Apagar", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 }); await desktopApi(page, pc("unreachable", "cachyos", ["start", "boot-windows", "boot-cachyos", "refresh"])); await page.goto("/");
  const button = page.getByRole("button", { name: "Encender la PC", exact: true }); await expect(button).toBeEnabled(); await expect(page.getByRole("button", { name: "Apagar", exact: true })).toHaveCount(0);
  await button.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button.click(); await expect(page.getByRole("alertdialog")).toContainText("Elige el sistema"); await page.getByRole("button", { name: "Windows", exact: true }).click(); await expect(page.getByRole("button", { name: "Encender en Windows", exact: true })).toBeEnabled();
});
test("arranque predeterminado: confirmación, versión y cero órdenes de energía", async ({ page }) => {
  const calls = await desktopApi(page, pc("running", "windows", ["stop", "boot-cachyos", "refresh"]), { desired: "cachyos", effective: "cachyos", state: "applied", version: 4, observedAt: now(), verifiedAt: now() }); await page.goto("/");
  await page.getByRole("button", { name: /^Sistema/ }).click(); await expect(page.getByRole("button", { name: "CachyOS, predeterminado" })).toBeVisible(); await expect(page.getByText("★ Predeterminado: CachyOS.")).toBeVisible();
  await page.getByRole("button", { name: /^Windows/ }).click(); await page.getByRole("button", { name: "Hacer predeterminado", exact: true }).click(); expect(calls.preferences).toHaveLength(0); await expect(page.getByRole("alertdialog")).toContainText("No se reinicia ahora");
  await page.getByRole("button", { name: "Sí, cambiar", exact: true }).click(); await expect.poll(() => calls.preferences.length).toBe(1); expect(calls.preferences[0]?.body).toEqual({ system: "windows", confirmed: true, expectedVersion: 4 }); expect(calls.preferences[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/); await expect(page.getByText("Listo: Windows es ahora el predeterminado.")).toBeVisible(); expect(calls.orders).toHaveLength(0);
});
test("apagar fija el siguiente sistema antes de la orden; sin elegir no escribe preferencia", async ({ page }) => {
  const boot: BootPreference = { desired: "cachyos", effective: "cachyos", state: "applied", version: 7, observedAt: now(), verifiedAt: now() };
  const calls = await desktopApi(page, pc("running", "cachyos", ["stop", "boot-windows", "refresh"]), boot); await page.goto("/"); await page.getByRole("button", { name: "Apagar", exact: true }).click();
  const choice = page.getByRole("group", { name: "Sistema del próximo encendido" }); await expect(choice).toContainText("CachyOS sigue como predeterminado."); await choice.getByRole("button", { name: "Windows", exact: true }).click(); await expect(choice).toContainText("Se cambiará el predeterminado a Windows antes de apagar.");
  await holdConfirm(page); await expect.poll(() => calls.sequence.length).toBe(2); expect(calls.sequence).toEqual(["preferencia:windows:v7", "orden:stop"]);
  await page.unroute("**/api/**"); const unchanged = await desktopApi(page, pc("running", "cachyos", ["stop", "boot-windows", "refresh"]), boot); await page.goto("/"); await page.getByRole("button", { name: "Apagar", exact: true }).click(); await expect(page.getByRole("group", { name: "Sistema del próximo encendido" })).toContainText("CachyOS sigue como predeterminado."); await holdConfirm(page); await expect.poll(() => unchanged.orders.length).toBe(1); expect(unchanged.preferences).toHaveLength(0);
});
test("reiniciar en el mismo SO conserva acción y confirmación", async ({ page }) => {
  const calls = await desktopApi(page, pc("running", "windows", ["stop", "boot-windows", "boot-cachyos", "refresh"])); await page.goto("/"); await page.getByRole("button", { name: /^Sistema/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Reinicia la PC en el mismo sistema"); const restart = page.getByRole("button", { name: "Reiniciar en Windows", exact: true }); await expect(restart).toBeEnabled(); expect(calls.orders).toHaveLength(0); await restart.click(); await expect.poll(() => calls.orders.length).toBe(1); expect(calls.orders[0]?.body).toEqual({ resourceId: "computer:desktop", action: "boot-windows", confirmed: true }); expect(calls.orders[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/);
});

for (const width of [320, 390, 834, 1440]) {
  test(`shell HTTP: inventario antiguo no desplaza páginas ajenas a ${width}px`, async ({ page, context }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 1000 });
    const resource = pc("running", "cachyos", ["stop", "boot-windows", "refresh"]);
    resource.observedAt = new Date(Date.now() - 600000).toISOString();
    const observedAt = resource.observedAt;
    const calls = await desktopApi(page, resource);
    const expectedTop = width >= 701 ? 28 : 20;
    for (const path of ["/tu", "/tu/dispositivos", "/tu/ajustes", "/costes", "/agentes", "/actividad"]) {
      await page.goto(path);
      const main = page.locator("main[data-inventory-ready=true]");
      await expect(main).toBeVisible();
      const head = main.locator(".page-head-wrap").first();
      await expect(head).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const notices = main.locator(".shell__notices");
      await expect(notices).toBeEmpty();
      await expect(notices.getByText("Datos antiguos", { exact: true })).toHaveCount(0);
      await expect(notices.getByText("Comprobando al volver", { exact: true })).toHaveCount(0);
      await expect(page.getByText("PROTOTIPO · datos simulados · sin acciones reales")).toHaveCount(0);
      const geometry = await main.evaluate(element => {
        const head = element.querySelector<HTMLElement>(".page-head-wrap")!;
        const notices = element.querySelector<HTMLElement>(".shell__notices")!;
        return {
          top: head.getBoundingClientRect().top - element.getBoundingClientRect().top,
          noticeHeight: notices.getBoundingClientRect().height,
          noticeBottomPadding: getComputedStyle(notices).paddingBottom,
          noticeIsPage: notices.classList.contains("page"),
        };
      });
      expect(geometry.top, path).toBeGreaterThanOrEqual(expectedTop - 2);
      expect(geometry.top, path).toBeLessThanOrEqual(expectedTop + 2);
      expect(geometry.noticeHeight, path).toBe(0);
      expect(geometry.noticeBottomPadding, path).toBe("0px");
      expect(geometry.noticeIsPage, path).toBe(false);
    }
    expect(resource.observedAt).toBe(observedAt);
    expect(calls.orders).toHaveLength(0);
    expect(calls.preferences).toHaveLength(0);
    await context.setOffline(true);
    const notices = page.locator(".shell__notices");
    await expect(notices.getByText("Sin conexión", { exact: true })).toBeVisible();
    const offlineGeometry = await notices.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      bottomPadding: getComputedStyle(element).paddingBottom,
    }));
    expect(offlineGeometry.height).toBeGreaterThan(0);
    expect(offlineGeometry.bottomPadding).toBe("0px");
    expect(calls.orders).toHaveLength(0);
  });
}
