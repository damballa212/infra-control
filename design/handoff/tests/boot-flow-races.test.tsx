import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootPreference, DetailedResource } from "../ui/src/contract.ts";
import { ProviderError } from "../integration/provider.ts";
const state = vi.hoisted(() => ({ current: null as unknown, expire: vi.fn() }));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ expire: state.expire }) }));
vi.mock("../ui/src/app/providers.ts", async () => { const { createFixtureProvider } = await import("../integration/fixtureProvider.ts"); return { provider: createFixtureProvider({ latencyMs: 0 }), isFixture: true }; });
import { provider } from "../ui/src/app/providers.ts";
import { StopDialog } from "../ui/src/components/StopDialog.tsx";
import { DesktopControls } from "../ui/src/components/DesktopControls.tsx";
import { BootActionCoordinator, useBootDefault } from "../ui/src/components/BootDefault.tsx";
const base: BootPreference = { state: "applied", desired: "cachyos", effective: "cachyos", version: 7 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function read<T>(data: T) { return { data, error: null, loading: false, retryAt: 0, refresh: vi.fn(), setData: vi.fn() }; }
function makeApp(resource: DetailedResource) { return { inventory: read({ resources: [resource] }), operations: read({ operations: [] }), canWrite: true, online: true, visible: true, now: Date.now(), sending: false, ambiguous: false, retryAt: 0, submit: vi.fn().mockResolvedValue({ id: "order" }) }; }
const pc: DetailedResource = { id: "computer:desktop", name: "PC de casa", kind: "computer", state: "running", system: "cachyos", account: "Casa", location: "Casa", detail: "Dual boot", observedAt: new Date().toISOString(), actions: ["stop", "boot-windows", "boot-cachyos"] };
beforeEach(() => { state.current = makeApp(pc); vi.spyOn(provider, "getBootPreference").mockResolvedValue({ ...base }); vi.spyOn(provider, "verifyBootPreference").mockResolvedValue({ ...base }); vi.spyOn(provider, "cancelBootPreference").mockResolvedValue({ ...base }); });
afterEach(() => { vi.restoreAllMocks(); });
async function chooseWindows() { await screen.findByRole("group", { name: "Sistema del próximo encendido" }); fireEvent.click(screen.getByRole("button", { name: /^Windows$/ })); fireEvent.click(screen.getByRole("button", { name: /Mantén pulsado/ }), { detail: 0 }); }
describe("preferencia antes de apagar", () => {
  it.each(["pending", "uncertain", "failed"] as const)("%s no autoriza apagar", async outcome => {
    const stop = vi.fn(); const set = vi.spyOn(provider, "setBootPreference").mockResolvedValue({ ...base, desired: "windows", effective: "cachyos", state: outcome, version: 8 });
    render(<StopDialog busy={false} onStop={stop} onCancel={vi.fn()} />); await chooseWindows();
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1)); await act(async () => {});
    expect(stop).not.toHaveBeenCalled();
  });
  it("applied con effective distinto tampoco autoriza apagar", async () => {
    const stop = vi.fn(); vi.spyOn(provider, "setBootPreference").mockResolvedValue({ ...base, desired: "windows", effective: "cachyos", version: 8 });
    render(<StopDialog busy={false} onStop={stop} onCancel={vi.fn()} />); await chooseWindows(); await act(async () => {}); expect(stop).not.toHaveBeenCalled();
  });
  it.each(["cancel", "unmount"] as const)("%s invalida la continuación diferida", async cancellation => {
    const deferredSet = deferred<BootPreference>(); const stop = vi.fn(); const cancel = vi.fn();
    const set = vi.spyOn(provider, "setBootPreference").mockReturnValue(deferredSet.promise);
    const view = render(<StopDialog busy={false} onStop={stop} onCancel={cancel} />); await chooseWindows(); await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    if (cancellation === "cancel") fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/ })); else view.unmount();
    await act(async () => deferredSet.resolve({ ...base, state: "applied", desired: "windows", effective: "windows", version: 8 }));
    expect(stop).not.toHaveBeenCalled(); if (cancellation === "cancel") expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("revalida busy y usa el callback vigente después del await", async () => {
    const pending = deferred<BootPreference>(); vi.spyOn(provider, "setBootPreference").mockReturnValue(pending.promise);
    const oldStop = vi.fn(); const newStop = vi.fn(); const cancel = vi.fn();
    const view = render(<StopDialog busy={false} onStop={oldStop} onCancel={cancel} />); await chooseWindows();
    view.rerender(<StopDialog busy={true} onStop={newStop} onCancel={cancel} />);
    await act(async () => pending.resolve({ ...base, desired: "windows", effective: "windows", version: 8 }));
    expect(oldStop).not.toHaveBeenCalled(); expect(newStop).not.toHaveBeenCalled();
  });
  it("DesktopControls no despacha si la acción desaparece durante la preferencia", async () => {
    const pending = deferred<BootPreference>(); vi.spyOn(provider, "setBootPreference").mockReturnValue(pending.promise);
    const app = makeApp(pc); state.current = app;
    const view = render(<DesktopControls resource={pc} />); fireEvent.click(screen.getByRole("button", { name: /^Apagar$/ })); await chooseWindows();
    const changed = { ...pc, actions: [] }; state.current = { ...app, inventory: read({ resources: [changed] }) }; view.rerender(<DesktopControls resource={changed} />);
    await act(async () => pending.resolve({ ...base, desired: "windows", effective: "windows", version: 8 }));
    expect(app.submit).not.toHaveBeenCalled();
  });
  it("primera acción bloqueada y segunda disponible permiten abrir el selector", async () => {
    const resource: DetailedResource = { ...pc, state: "stopped", actions: ["boot-windows", "boot-cachyos"], actionAvailability: { "boot-windows": { allowed: false, reasonCode: "observation_stale" }, "boot-cachyos": { allowed: true, reasonCode: "available" } } };
    state.current = makeApp(resource); render(<DesktopControls resource={resource} />);
    const enter = screen.getByRole("button", { name: /^Encender$/ }); expect(enter).toBeEnabled(); fireEvent.click(enter);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Encender en CachyOS$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Windows$/ })); expect(screen.getByRole("button", { name: /^Encender en Windows$/ })).toBeDisabled();
    expect(screen.getByText(/El proveedor no ofrece el arranque elegido/)).toBeInTheDocument();
  });
});
describe("Retry-After compartido en preferencia", () => {
  it.each([429, 503])("%s bloquea set, cancel y verify en sus funciones hasta el plazo", async status => {
    vi.useFakeTimers(); const coordinator = new BootActionCoordinator();
    const set = vi.spyOn(provider, "setBootPreference").mockRejectedValueOnce(new ProviderError({ kind: "http", status, retryAfterSeconds: 30, message: "Espera" }));
    const { result } = renderHook(() => useBootDefault(coordinator)); await act(async () => {});
    await act(async () => { expect(await result.current.set("windows")).toBe(false); });
    expect(result.current.blocker).toContain("servidor pidió esperar");
    await act(async () => { await result.current.set("windows"); await result.current.cancel(); await result.current.verify(); });
    expect(set).toHaveBeenCalledTimes(1); expect(provider.cancelBootPreference).not.toHaveBeenCalled(); expect(provider.verifyBootPreference).not.toHaveBeenCalled(); expect(provider.getBootPreference).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); await result.current.verify(); }); expect(provider.verifyBootPreference).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await result.current.verify(); }); expect(provider.verifyBootPreference).toHaveBeenCalledTimes(1);
  });
});
