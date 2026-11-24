import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Route } from "../ui/src/lib/router.tsx";
import { makeCosts, makeResources, makeSecretRequests } from "../states/fixtures.ts";
import { ProviderError } from "../integration/provider.ts";

const state = vi.hoisted(() => ({
  current: null as unknown,
  fixture: false,
  update: { waiting: null as ServiceWorker | null, activate: vi.fn() },
}));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ user: { name: "Admin" }, expire: vi.fn(), logout: vi.fn() }) }));
vi.mock("../ui/src/hooks/useAppUpdate.ts", () => ({ useAppUpdate: () => state.update }));
vi.mock("../ui/src/app/providers.ts", async () => {
  const { createFixtureProvider } = await import("../integration/fixtureProvider.ts");
  return {
    provider: createFixtureProvider({ latencyMs: 0 }),
    get isFixture() { return state.fixture; },
  };
});

import { AppShell } from "../ui/src/components/AppShell.tsx";
import { ReadNotice, ResourceLine } from "../ui/src/components/ControlUI.tsx";
import { Me } from "../ui/src/screens/Me.tsx";
import { Costs } from "../ui/src/screens/Costs.tsx";
import { Agents } from "../ui/src/screens/Agents.tsx";
import { Activity } from "../ui/src/screens/Activity.tsx";
import { Inventory } from "../ui/src/screens/Inventory.tsx";
import { ResourceScreen } from "../ui/src/screens/Resource.tsx";
import { age } from "../ui/src/lib/controlModel.ts";

const now = Date.parse("2026-11-12T12:00:00Z");
const old = new Date(now - 600000).toISOString();
function read<T>(data: T) {
  const value = { data, error: null as unknown, loading: false, retryAt: 0 };
  return { ...value, refresh: vi.fn(), setData: vi.fn(), getState: () => value };
}
function makeApp() {
  return {
    inventory: read({ resources: makeResources(now), fetchedAt: new Date(now).toISOString(), refreshSeconds: 60, cursor: 0 }),
    operations: read({ operations: [] }),
    secretRequests: read({ requests: makeSecretRequests(now) }),
    secretsPending: 1,
    costs: read(makeCosts(now)),
    enableCosts: vi.fn(),
    online: true,
    visible: true,
    now,
    sending: false,
    writeError: null as unknown,
    retryAt: 0,
    ambiguous: false,
    ambiguousResource: null as string | null,
    submit: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn(),
    canWrite: true,
  };
}
const routes: { label: string; route: Route; content: () => ReactNode }[] = [
  { label: "Tú / sistema", route: { name: "me", tab: "system" }, content: () => <Me tab="system" /> },
  { label: "Tú / dispositivos", route: { name: "me", tab: "devices" }, content: () => <Me tab="devices" /> },
  { label: "Tú / ajustes", route: { name: "me", tab: "settings" }, content: () => <Me tab="settings" /> },
  { label: "Costes", route: { name: "costs" }, content: () => <Costs /> },
  { label: "Agentes", route: { name: "agents" }, content: () => <Agents /> },
  { label: "Actividad", route: { name: "activity" }, content: () => <Activity /> },
];
function notices() {
  const element = screen.getByRole("main").querySelector<HTMLElement>(".shell__notices");
  expect(element).not.toBeNull();
  return element!;
}
async function renderRoute(entry: typeof routes[number]) {
  render(<AppShell route={entry.route}>{entry.content()}</AppShell>);
  await act(async () => {});
}
beforeEach(() => {
  state.current = makeApp();
  state.fixture = false;
  state.update.waiting = null;
  state.update.activate.mockReset();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe.each(routes)("jerarquía de avisos: $label", entry => {
  it.each(["stale", "loading", "partial", "error", "rate-limited"] as const)("%s del inventario no ocupa la cabecera global", async condition => {
    const app = makeApp();
    if (condition === "stale") app.inventory.data.resources = app.inventory.data.resources.map(resource => ({ ...resource, observedAt: resource.observedAt === null ? null : old }));
    if (condition === "loading") app.inventory.loading = true;
    if (condition === "partial") app.inventory.data.resources = app.inventory.data.resources.map(resource => resource.kind === "service" ? { ...resource, state: "unknown" } : resource);
    if (condition === "error") app.inventory.error = new ProviderError({ kind: "http", status: 503, message: "No disponible" });
    if (condition === "rate-limited") app.inventory.error = new ProviderError({ kind: "http", status: 429, retryAfterSeconds: 30, message: "Espera" });
    state.current = app;
    await renderRoute(entry);
    expect(notices()).toBeEmptyDOMElement();
    expect(notices()).not.toHaveClass("page");
    expect(screen.getByRole("main").querySelector(".page-head-wrap")).not.toBeNull();
    expect(screen.queryByText("PROTOTIPO · datos simulados · sin acciones reales")).not.toBeInTheDocument();
    if (condition === "stale") expect(app.inventory.data.resources.find(resource => resource.name === "prod-erp")?.observedAt).toBe(old);
  });

  it("mantiene el aviso global offline", async () => {
    const app = makeApp(); app.online = false; state.current = app;
    await renderRoute(entry);
    expect(within(notices()).getByText("Sin conexión", { exact: true })).toBeInTheDocument();
    expect(within(notices()).getByText("Ves la última lectura de esta sesión. No se envían órdenes ni se dejan en cola.")).toBeInTheDocument();
    expect(notices()).not.toHaveClass("page");
  });

  it("recupera la misma intención desde cualquier ruta y respeta la espera", async () => {
    const app = makeApp();
    app.ambiguous = true; app.ambiguousResource = "computer:desktop";
    app.writeError = new ProviderError({ kind: "network", ambiguous: true, message: "Respuesta perdida" });
    state.current = app;
    const view = render(<AppShell route={entry.route}>{entry.content()}</AppShell>);
    await act(async () => {});
    expect(within(notices()).getByText("No sabemos si el envío llegó")).toBeInTheDocument();
    fireEvent.click(within(notices()).getByRole("button", { name: "Recuperar el mismo envío" }));
    expect(app.submit).toHaveBeenCalledTimes(1);
    expect(app.submit).toHaveBeenCalledWith();
    state.current = { ...app, retryAt: now + 30000 };
    view.rerender(<AppShell route={entry.route}>{entry.content()}</AppShell>);
    expect(within(notices()).getByRole("button", { name: "Recuperar el mismo envío" })).toBeDisabled();
    state.current = { ...app, online: false };
    view.rerender(<AppShell route={entry.route}>{entry.content()}</AppShell>);
    expect(within(notices()).getByRole("button", { name: "Recuperar el mismo envío" })).toBeDisabled();
    expect(app.submit).toHaveBeenCalledTimes(1);
  });

  it("conserva el aviso y la acción explícita de actualización", async () => {
    state.update.waiting = {} as ServiceWorker;
    await renderRoute(entry);
    expect(within(notices()).getByText("Hay una versión nueva")).toBeInTheDocument();
    fireEvent.click(within(notices()).getByRole("button", { name: "Actualizar y recargar" }));
    expect(state.update.activate).toHaveBeenCalledTimes(1);
  });
});

describe("avisos globales y contexto del recurso", () => {
  it("no pierde la recuperación ambigua aunque no haya un objeto de error", () => {
    const app = makeApp(); app.ambiguous = true; state.current = app;
    render(<AppShell route={{ name: "me", tab: "settings" }}><div className="page" /></AppShell>);
    expect(within(notices()).getByRole("button", { name: "Recuperar el mismo envío" })).toBeEnabled();
  });

  it("una actualización espera mientras existe una intención ambigua", () => {
    const app = makeApp(); app.ambiguous = true; state.current = app;
    state.update.waiting = {} as ServiceWorker;
    render(<AppShell route={{ name: "costs" }}><div className="page" /></AppShell>);
    expect(within(notices()).getByText("Recupera el envío antes de actualizar")).toBeInTheDocument();
    const button = within(notices()).getByRole("button", { name: "Actualizar y recargar" });
    expect(button).toBeDisabled(); fireEvent.click(button);
    expect(state.update.activate).not.toHaveBeenCalled();
  });

  it("conserva los fallos de escritura globales", () => {
    const app = makeApp(); app.writeError = new Error("La solicitud fue rechazada."); state.current = app;
    render(<AppShell route={{ name: "agents" }}><div className="page" /></AppShell>);
    expect(within(notices()).getByText("No se pudo completar la solicitud")).toBeInTheDocument();
    expect(within(notices()).getByText("La solicitud fue rechazada.")).toBeInTheDocument();
    expect(within(notices()).queryByRole("button", { name: "Recuperar el mismo envío" })).not.toBeInTheDocument();
  });

  it("el marcador de prototipo aparece exclusivamente con fixtures", () => {
    const view = render(<AppShell route={{ name: "me", tab: "settings" }}><div className="page" /></AppShell>);
    expect(notices()).toBeEmptyDOMElement();
    state.fixture = true;
    view.rerender(<AppShell route={{ name: "me", tab: "settings" }}><div className="page" /></AppShell>);
    expect(within(notices()).getByText("PROTOTIPO · datos simulados · sin acciones reales")).toBeInTheDocument();
    expect(notices()).not.toHaveClass("page");
  });

  it("inventario conserva la edad de una observación antigua", async () => {
    const app = makeApp();
    app.inventory.data.resources = app.inventory.data.resources.map(resource => resource.name === "prod-erp" ? { ...resource, observedAt: old } : resource);
    state.current = app;
    render(<AppShell route={{ name: "inventory", view: "devices" }}><Inventory view="devices" /></AppShell>);
    const name = await screen.findByText("prod-erp", { exact: true });
    const link = name.closest("a"); expect(link).not.toBeNull();
    expect(within(link!).getByText(age(old, now), { exact: true })).toBeInTheDocument();
    expect(notices()).toBeEmptyDOMElement();
    expect(app.inventory.data.resources.find(resource => resource.name === "prod-erp")?.observedAt).toBe(old);
  });

  it("el detalle conserva sus timestamps sin elevarlos al shell", async () => {
    const app = makeApp();
    const resource = app.inventory.data.resources.find(row => row.name === "prod-erp")!;
    resource.observedAt = old; state.current = app;
    render(<AppShell route={{ name: "resource", id: resource.id }}><ResourceScreen id={resource.id} /></AppShell>);
    expect(await screen.findByRole("heading", { name: /^prod-erp$/ })).toBeInTheDocument();
    expect(screen.getAllByText(age(old, now), { exact: true }).length).toBeGreaterThan(0);
    expect(notices()).toBeEmptyDOMElement();
    expect(resource.observedAt).toBe(old);
  });

  it("ReadNotice mantiene el error y Retry-After en su contexto", () => {
    const app = makeApp();
    app.inventory.error = new ProviderError({ kind: "http", status: 429, retryAfterSeconds: 30, message: "Espera" });
    app.inventory.retryAt = now + 30000; state.current = app;
    const resource = app.inventory.data.resources.find(row => row.name === "prod-erp")!;
    render(<AppShell route={{ name: "inventory", view: "devices" }}><div className="page"><ReadNotice read={app.inventory} label="los equipos" /><ResourceLine resource={resource} /></div></AppShell>);
    expect(notices()).toBeEmptyDOMElement();
    expect(screen.getByText(/No se pudo actualizar los equipos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Volver a consultar" })).toBeDisabled();
    expect(screen.getByText(/El servidor pidió esperar hasta/)).toBeInTheDocument();
  });
});
