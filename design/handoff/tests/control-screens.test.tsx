import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useAppState } from "../ui/src/app/AppState.tsx";
import { makeCosts, makeOperations, makeResources, makeSecretRequests } from "../states/fixtures.ts";
const state = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ user: { name: "Admin" }, expire: vi.fn(), logout: vi.fn() }) }));
vi.mock("../ui/src/app/providers.ts", async () => { const { createFixtureProvider } = await import("../integration/fixtureProvider.ts"); return { provider: createFixtureProvider({ latencyMs: 0 }), isFixture: true }; });
import { Hoy } from "../ui/src/screens/Hoy.tsx";
import { Inventory } from "../ui/src/screens/Inventory.tsx";
import { ResourceScreen } from "../ui/src/screens/Resource.tsx";
import { Activity } from "../ui/src/screens/Activity.tsx";
import { Costs } from "../ui/src/screens/Costs.tsx";
import { Agents } from "../ui/src/screens/Agents.tsx";
import { Me } from "../ui/src/screens/Me.tsx";
import { SecretRequestDetail } from "../ui/src/screens/SecretRequestDetail.tsx";
import { provider } from "../ui/src/app/providers.ts";
const now = Date.now();
function read<T>(data: T) { return { data, error: null, loading: false, retryAt: 0, refresh: vi.fn(), setData: vi.fn() }; }
beforeEach(() => {
  const app = { inventory: read({ resources: makeResources(now), fetchedAt: new Date(now).toISOString(), refreshSeconds: 60, cursor: 0 }), operations: read({ operations: makeOperations(now) }), secretRequests: read({ requests: makeSecretRequests(now) }), secretsPending: 1, costs: read(makeCosts(now)), enableCosts: vi.fn(), online: true, visible: true, now, sending: false, writeError: null, retryAt: 0, ambiguous: false, ambiguousResource: null, submit: vi.fn(), attach: vi.fn(), canWrite: true };
  state.current = app;
});
describe("pantallas integradas", () => {
  it("Hoy consulta pendientes independientemente del recorte histórico", async () => {
    const spy = vi.spyOn(provider, "getSecretRequests");
    const pending = vi.spyOn(provider, "getPendingSecretRequests");
    render(<Hoy />);
    expect(screen.getByRole("heading", { name: "Hoy" })).toBeInTheDocument();
    expect(await screen.findByText("MacBook Air pide una clave")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /^Cobertura/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Siguiente" })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled(); expect(pending).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 })); spy.mockRestore(); pending.mockRestore();
  });
  it("inventario Mapa permite selección y enlace al detalle único", async () => {
    render(<Inventory view="map" />);
    const select = await screen.findByRole("button", { name: "Seleccionar prod-erp" });
    fireEvent.click(select);
    const inspector = screen.getByRole("complementary", { name: "Inspector del mapa" });
    expect(within(inspector).getByRole("heading", { name: "prod-erp" })).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "Ver detalle" })).toHaveAttribute("href", "/equipo/aws%3Aprod%3Ai-fixture-erp");
    const canvas = screen.getByRole("application");
    fireEvent.click(screen.getByRole("button", { name: "Encuadrar" }));
    await waitFor(() => expect(canvas).toHaveAttribute("data-zoom", "100"));
    fireEvent.click(screen.getByRole("button", { name: "Acercar mapa" }));
    await waitFor(() => expect(canvas).toHaveAttribute("data-zoom", "125"));
  });
  it("detalle lógico muestra relaciones explícitas sin controles de energía", async () => {
    render(<ResourceScreen id="svc:rendicion" />);
    expect(await screen.findByRole("heading", { name: "Rendición branch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apagar$/ })).not.toBeInTheDocument();
    expect(screen.getByText(/abre el equipo relacionado/)).toBeInTheDocument();
    expect(screen.getAllByRole("link").some(link => link.getAttribute("href") === "/equipo/coolify%3Afixture-rendicion")).toBe(true);
  });
  it("actividad consulta el historial real y no inventa episodios ausentes", async () => {
    const history = vi.spyOn(provider, "getIncidentHistory");
    render(<Activity />); fireEvent.click(screen.getByRole("button", { name: /^Incidentes$/ }));
    expect(await screen.findByText("Sin incidentes con este filtro.")).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 })); history.mockRestore();
  });
  it("costes conserva el subtotal excluyendo una cuenta parcial", () => {
    const app = state.current as ReturnType<typeof useAppState>;
    const report = makeCosts(now); report.accounts[1] = { ...report.accounts[1]!, status: "partial" };
    app.costs.data = report;
    render(<Costs />);
    expect(screen.getByText("Subtotal · 2 de 3 cuentas")).toBeInTheDocument();
    expect(screen.getByText("US$ 22,50")).toBeInTheDocument();
  });
  it("agentes no presenta una lista observada como permisos configurados", async () => {
    render(<Agents />);
    expect(screen.getByText("El equipo está verificado; agente y motivo los declara él.")).toBeInTheDocument();
    expect(screen.queryByText(/Cobertura observada|La API no ofrece|Consulta una colección/)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /^Claves guardadas/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Proyecto de la colección")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Anterior|Siguiente)$/ })).not.toBeInTheDocument();
  });
  it("Tú muestra solo secciones conocidas y no declara bóveda sana", async () => {
    render(<Me tab="system" />);
    expect(await screen.findByRole("heading", { name: /^Fuentes del inventario/ })).toBeInTheDocument();
    expect(await screen.findByText("3 de 4 leen bien")).toBeInTheDocument();
    expect(screen.getAllByText(/^AWS · agents$/)).toHaveLength(1);
    expect(screen.queryByText("Bóveda conectada")).not.toBeInTheDocument();
  });
  it("intake limpia el valor incluso al fallar y no imprime el error recibido", async () => {
    const spy = vi.spyOn(provider, "approveSecret").mockRejectedValueOnce(new Error("valor que nunca debe mostrarse"));
    render(<SecretRequestDetail id="sec_pending1" />);
    const input = await screen.findByLabelText(/^Valor de la clave/);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Denegar$/ })).toBeEnabled());
    fireEvent.change(input, { target: { value: "SYNTHETIC_TEST_ONLY" } });
    fireEvent.click(screen.getByRole("button", { name: /^Aprobar y entregar$/ }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByText("valor que nunca debe mostrarse")).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
