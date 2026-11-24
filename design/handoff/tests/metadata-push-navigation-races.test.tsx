import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushDevice, PushPreferences, VaultItem } from "../ui/src/contract.ts";
import { ProviderError } from "../integration/provider.ts";
const state = vi.hoisted(() => ({ current: null as unknown, expire: vi.fn() }));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ expire: state.expire }) }));
vi.mock("../ui/src/app/providers.ts", async () => { const { createFixtureProvider } = await import("../integration/fixtureProvider.ts"); return { provider: createFixtureProvider({ latencyMs: 0 }), isFixture: true }; });
vi.mock("../ui/src/lib/push.ts", () => ({ pushBlocker: () => null, currentSubscription: vi.fn(async () => ({ endpoint: "https://push.invalid/synthetic", keys: { auth: "synthetic", p256dh: "synthetic" } })), subscribeThisDevice: vi.fn(), unsubscribeThisDevice: vi.fn() }));
import { provider } from "../ui/src/app/providers.ts";
import { Agents } from "../ui/src/screens/Agents.tsx";
import { PushSettings } from "../ui/src/components/PushSettings.tsx";
import { NavBar } from "../ui/src/components/NavBar.tsx";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function read<T>(data: T) { return { data, error: null, loading: false, retryAt: 0, refresh: vi.fn(), setData: vi.fn() }; }
function app() { return { inventory: read({ resources: [] }), operations: read({ operations: [] }), secretRequests: read({ requests: [] }), secretsPending: 0, online: true, visible: true, now: Date.now() }; }
beforeEach(() => { state.current = app(); });
afterEach(() => { vi.restoreAllMocks(); });
describe("colecciones con identidad", () => {
  it("A diferida nunca aparece bajo B; B se consulta una vez tras terminar A", async () => {
    const a = deferred<{ items: VaultItem[] }>(); const b = deferred<{ items: VaultItem[] }>();
    const get = vi.spyOn(provider, "getSecretItems").mockImplementation(project => project === "A" ? a.promise : b.promise);
    render(<Agents />);
    fireEvent.click(screen.getByRole("button", { name: "Buscar otra colección" }));
    fireEvent.change(screen.getByLabelText("Proyecto de la colección"), { target: { value: "A" } }); fireEvent.click(screen.getByRole("button", { name: /^Consultar nombres$/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("A", null));
    fireEvent.change(screen.getByLabelText("Proyecto de la colección"), { target: { value: "B" } }); fireEvent.click(screen.getByRole("button", { name: /^Consultar nombres$/ }));
    expect(screen.getByRole("heading", { name: /^B$/ })).toBeInTheDocument();
    await act(async () => a.resolve({ items: [{ itemRef: "a", name: "NOMBRE_A", updatedAt: new Date().toISOString() }] }));
    expect(screen.queryByText("NOMBRE_A")).not.toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("B", null));
    await act(async () => b.resolve({ items: [{ itemRef: "b", name: "NOMBRE_B", updatedAt: new Date().toISOString() }] }));
    expect(await screen.findByText("NOMBRE_B")).toBeInTheDocument(); expect(screen.queryByText("NOMBRE_A")).not.toBeInTheDocument(); expect(get).toHaveBeenCalledTimes(2);
  });
});
describe("preferencias push autoritativas", () => {
  it("una desactivación aplicada con respuesta perdida no se restaura en la siguiente escritura", async () => {
    vi.useFakeTimers();
    const initial: PushPreferences = { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true };
    let truth: PushDevice = { id: "device", createdAt: new Date().toISOString(), lastSuccessAt: null, preferences: { ...initial } };
    const refreshed = deferred<PushDevice>();
    vi.spyOn(provider, "getPushConfig").mockResolvedValue({ enabled: true, vapidPublicKey: "synthetic-public" });
    const register = vi.spyOn(provider, "registerPush").mockImplementationOnce(async () => ({ ...truth, preferences: { ...truth.preferences } })).mockImplementationOnce(() => refreshed.promise);
    const update = vi.spyOn(provider, "updatePushPreferences").mockImplementation(async (_id, preferences) => {
      truth = { ...truth, preferences: { ...preferences } };
      if (update.mock.calls.length === 1) throw new ProviderError({ kind: "network", ambiguous: true, retryAfterSeconds: 30, message: "Respuesta perdida" });
    });
    render(<PushSettings />); await act(async () => {});
    const orders = screen.getByRole("checkbox", { name: "Órdenes terminadas" });
    fireEvent.click(orders); await act(async () => {});
    expect(truth.preferences.operations).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Router" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Router" })); expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); }); expect(register).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(register).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("checkbox", { name: "Router" })).toBeDisabled();
    await act(async () => refreshed.resolve({ ...truth, preferences: { ...truth.preferences } }));
    expect(screen.getByRole("checkbox", { name: "Órdenes terminadas" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Router" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Router" })); await act(async () => {});
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[1]).toMatchObject({ operations: false, router: false });
    expect(truth.preferences.operations).toBe(false);
  });
});
describe("nombres accesibles de navegación", () => {
  it("Hoy conserva nombre estable al llegar el badge y anuncia su conteo como descripción", () => {
    const current = app(); state.current = current;
    const view = render(<NavBar route={{ name: "control" }} />);
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    expect(within(nav).getByRole("link", { name: /^Hoy$/ })).toHaveAccessibleName("Hoy");
    state.current = { ...current, secretsPending: 2, attention: { error: null, data: { fetchedAt: new Date().toISOString(), counts: { attentionGroups: 3, active: 0, pendingReviews: 3, openIncidents: 0, unknownIncidents: 0, coverageProblems: 0 }, coverage: { scopes: 0, healthy: 0, partial: 0, failed: 0, stale: 0 }, pendingApprovals: 2 } } }; view.rerender(<NavBar route={{ name: "control" }} />);
    const hoy = within(nav).getByRole("link", { name: /^Hoy$/ });
    expect(hoy).toHaveAccessibleName("Hoy"); expect(hoy).toHaveAccessibleDescription("3 grupos de atención");
    expect(within(hoy).getByText("3")).toHaveAttribute("aria-hidden", "true");
    const agents = within(nav).getByRole("link", { name: /^Agentes$/ }); expect(agents).toHaveAccessibleDescription("2 te espera");
    state.current = current; view.rerender(<NavBar route={{ name: "control" }} />);
    expect(within(nav).getByRole("link", { name: /^Hoy$/ })).not.toHaveAttribute("aria-describedby");
  });
});
