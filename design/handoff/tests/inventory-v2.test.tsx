import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOperations, makeResources, makeServices } from "../states/fixtures.ts";
const state = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ user: { name: "Admin" }, expire: vi.fn(), logout: vi.fn() }) }));
vi.mock("../ui/src/app/providers.ts", async () => { const { createFixtureProvider } = await import("../integration/fixtureProvider.ts"); return { provider: createFixtureProvider({ latencyMs: 0 }), isFixture: true }; });
import { provider } from "../ui/src/app/providers.ts";
import { Inventory } from "../ui/src/screens/Inventory.tsx";
import { ResourceScreen } from "../ui/src/screens/Resource.tsx";
import { activeResourceIds, bySeverity, groupItems, isProblem, problemCounts, problemSummary, resourceItem, serviceView } from "../ui/src/lib/invModel.ts";
import { buildMap, clampCamera, fitCamera, zoomAt, NODE_LEVEL_K } from "../ui/src/lib/invMap.ts";

const now = Date.now();
function read<T>(data: T) { return { data, error: null, loading: false, retryAt: 0, refresh: vi.fn(), setData: vi.fn() }; }
beforeEach(() => {
  state.current = { inventory: read({ resources: makeResources(now), fetchedAt: new Date(now).toISOString(), refreshSeconds: 60, cursor: 0 }), operations: read({ operations: makeOperations(now) }), online: true, visible: true, now, sending: false, retryAt: 0, ambiguous: false, submit: vi.fn(), canWrite: true, attention: { refresh: vi.fn() } };
});

describe("modelo del inventario", () => {
  const resources = makeResources(now);
  const ops = makeOperations(now);
  const items = resources.map(r => resourceItem(r, now, activeResourceIds(ops)));
  it("ordena por gravedad: el fallo primero, luego sin datos; «Por conectar» no es «apagada»", () => {
    const problems = items.filter(i => isProblem(i.status)).sort(bySeverity);
    expect(problems[0]!.name).toBe("prod-erp");
    expect(problems[0]!.status).toBe("bad");
    const pc = items.find(i => i.id === "computer:desktop")!;
    expect(pc.label).toBe("Por conectar"); expect(pc.status).toBe("unknown");
    expect(problemSummary(problemCounts(items))).toBe("1 falla · 4 sin datos");
  });
  it("los grupos con fallos van arriba y una EC2 no repite «no verifica sus aplicaciones»", () => {
    expect(groupItems(items)[0]!.items[0]!.name).toBe("prod-erp");
    expect(items.some(i => /verifica/.test(i.note ?? ""))).toBe(false);
  });
  it("un servicio sin sonda no se pinta sano ni como problema; un host sin descubrir sí pide revisión", () => {
    const services = makeServices(now);
    expect(serviceView(services.find(s => s.id === "svc:hermes")!, resources, now).status).toBe("unchecked");
    expect(serviceView(services.find(s => s.id === "svc:retail")!, resources, now).label).toBe("Host sin descubrir");
    expect(serviceView(services.find(s => s.id === "svc:rendicion")!, resources, now)).toMatchObject({ status: "stale", note: "prod-erp con fallo" });
  });
});

describe("cámara del mapa", () => {
  it("el zoom conserva el punto bajo los dedos y el encuadre deja ver las zonas", () => {
    const layout = buildMap(resourceItemsFor(), [], makeResources(now), 2);
    const view = { w: 360, h: 420 };
    const fit = fitCamera(layout.bounds, view);
    expect(fit.k).toBeLessThan(NODE_LEVEL_K);
    const z = zoomAt(fit, 100, 200, 2, 0.05);
    expect(((100 - z.x) / z.k)).toBeCloseTo((100 - fit.x) / fit.k, 6);
    const lost = clampCamera({ ...fit, x: -100000 }, layout.bounds, view);
    expect((layout.bounds.x + layout.bounds.w) * lost.k + lost.x).toBeGreaterThan(0);
  });
});
function resourceItemsFor() { return makeResources(now).map(r => resourceItem(r, now, new Set())); }

describe("pantallas", () => {
  it("«1 falla» desde Hoy abre la lista filtrada con el fallo arriba y un chip para quitarlo", async () => {
    render(<Inventory view="devices" problems />);
    expect(await screen.findByRole("heading", { name: "1 falla · 4 sin datos" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Primero lo que falla" });
    expect(within(list).getAllByRole("link")[0]).toHaveTextContent("prod-erp");
    expect(within(list).queryByText("game-server")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quitar filtro/ })).toBeInTheDocument();
  });
  it("el detalle pone las acciones arriba, sin paginador ni bloque de agentes vacío", async () => {
    render(<ResourceScreen id="aws:prod:i-fixture-erp" />);
    expect(await screen.findByRole("heading", { name: "prod-erp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apagar" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Ver todas en Actividad ›" })).toHaveAttribute("href", "/actividad");
    expect(screen.queryByRole("button", { name: "Siguiente" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Agentes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Revisa la edad de la observación/)).not.toBeInTheDocument();
  });
  it("la política se elige con una opción y se guarda una sola vez con la versión leída", async () => {
    const put = vi.spyOn(provider, "putResourceExpectation");
    render(<ResourceScreen id="aws:prod:i-fixture-erp" />);
    const options = await screen.findByRole("radiogroup", { name: "Disponibilidad esperada" });
    await waitFor(() => expect(within(options).getAllByRole("radio")[2]).toBeEnabled());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(within(options).getByRole("radio", { name: /Siempre encendido/ }));
    const save = screen.getByRole("button", { name: "Guardar" });
    fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("aws:prod:i-fixture-erp", expect.any(Number), "always-on");
  });
});
