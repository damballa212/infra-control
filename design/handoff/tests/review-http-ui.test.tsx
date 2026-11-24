import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootPreference, PushDevice } from "../ui/src/contract.ts";
import { createHttpProvider } from "../integration/httpProvider.ts";
import { IntentController } from "../ui/src/lib/intent.ts";
const state = vi.hoisted(() => ({ current: null as unknown, fetcher: vi.fn<typeof fetch>(), expire: vi.fn() }));
vi.mock("../ui/src/app/AppState.tsx", () => ({ useAppState: () => state.current }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ expire: state.expire }) }));
vi.mock("../ui/src/app/providers.ts", async () => { const { createHttpProvider } = await import("../integration/httpProvider.ts"); return { provider: createHttpProvider((...args) => state.fetcher(...args)), isFixture: false }; });
vi.mock("../ui/src/lib/push.ts", () => ({ pushBlocker: () => null, currentSubscription: vi.fn(async () => ({ endpoint: "https://push.invalid/test", keys: { auth: "synthetic", p256dh: "synthetic" } })), subscribeThisDevice: vi.fn(), unsubscribeThisDevice: vi.fn() }));
import { PushSettings } from "../ui/src/components/PushSettings.tsx";
import { StopDialog } from "../ui/src/components/StopDialog.tsx";
import { BootActionCoordinator, BootDefaultRow, useBootDefault } from "../ui/src/components/BootDefault.tsx";
import { pushDisabled, setPushDisabled } from "../ui/src/lib/pushIntent.ts";
import { subscribeThisDevice, unsubscribeThisDevice } from "../ui/src/lib/push.ts";
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
const base: BootPreference = { desired: "cachyos", effective: "cachyos", state: "applied", version: 7 };
beforeEach(() => { setPushDisabled(false); state.fetcher.mockReset(); state.current = { online: true, visible: true, now: Date.now() }; });
afterEach(() => { vi.restoreAllMocks(); });
describe("ambigüedad del adaptador real", () => {
  it("la reactivación ambigua conserva opt-out y permite reintento humano sin remontar", async () => {
    setPushDisabled(true);
    vi.mocked(subscribeThisDevice).mockResolvedValue({ endpoint: "https://push.invalid/test", keys: { auth: "synthetic", p256dh: "synthetic" } });
    let registrations = 0;
    state.fetcher.mockImplementation(async path => {
      if (path === "/api/push/config") return json({ enabled: true, vapidPublicKey: "synthetic-public" });
      if (path === "/api/push/subscriptions") {
        registrations++;
        if (registrations === 1) throw new TypeError("Respuesta perdida");
        return json({ id: "d", createdAt: new Date().toISOString(), lastSuccessAt: null, preferences: { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true } });
      }
      throw new Error("Unexpected request");
    });
    render(<PushSettings />); await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Activar avisos en este teléfono" })); await act(async () => {});
    expect(registrations).toBe(1); expect(pushDisabled()).toBe(true);
    expect(screen.getByRole("button", { name: "Activar avisos en este teléfono" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Activar avisos en este teléfono" })); await act(async () => {});
    expect(pushDisabled()).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Router" })).toBeEnabled();
  });
  it("desmontar tras una baja ambigua no vuelve a registrar avisos", async () => {
    let registrations = 0;
    state.fetcher.mockImplementation(async (path, init) => {
      if (path === "/api/push/config") return json({ enabled: true, vapidPublicKey: "synthetic-public" });
      if (init?.method === "DELETE") throw new TypeError("Respuesta perdida después de aplicar");
      if (path === "/api/push/subscriptions") { registrations++; return json({ id: "d", createdAt: new Date().toISOString(), lastSuccessAt: null, preferences: { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true } }); }
      throw new Error("Unexpected request");
    });
    const first = render(<PushSettings />); await act(async () => {});
    expect(registrations).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Desactivar en este teléfono" })); await act(async () => {});
    first.unmount(); render(<PushSettings />); await act(async () => {});
    expect(registrations).toBe(1);
    expect(unsubscribeThisDevice).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Activar avisos en este teléfono" })).toBeEnabled();
  });
  it.each([500, 502, 503, 504])("energía con %i conserva petición y clave sin reintento automático", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: "Gateway" }, status, { "Retry-After": "30" })).mockResolvedValueOnce(json({ id: "same", state: "accepted" }, 202));
    const provider = createHttpProvider(fetcher); const intent = new IntentController(provider.createOperation);
    await expect(intent.submit({ resourceId: "r", action: "stop", confirmed: true })).rejects.toMatchObject({ status, ambiguous: true, retryAfterSeconds: 30 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(intent.ambiguous).toBe(true);
    await expect(intent.submit({ resourceId: "r", action: "stop", confirmed: true })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
    await intent.recover(); expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body); expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual(fetcher.mock.calls[0]?.[1]?.headers);
  });
  it.each([400, 401, 403, 409, 429])("rechazo %i mantiene ausencia de ambigüedad", async status => {
    const provider = createHttpProvider(vi.fn<typeof fetch>().mockResolvedValue(json({}, status, { "Retry-After": "45" })));
    await expect(provider.createOperation({ resourceId: "r", action: "stop", confirmed: true }, "same-key")).rejects.toMatchObject({ status, ambiguous: false, retryAfterSeconds: 45 });
  });
  it("DELETE sin body con timeout es ambiguo y GET no lo es", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }); }));
    const provider = createHttpProvider(fetcher); const removal = expect(provider.removePush("d")).rejects.toMatchObject({ ambiguous: true }); await vi.advanceTimersByTimeAsync(20000); await removal;
    const read = expect(provider.getPushConfig()).rejects.toMatchObject({ ambiguous: false }); await vi.advanceTimersByTimeAsync(20000); await read;
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" }); expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it("DELETE aplicado con respuesta perdida bloquea push sin volver a registrarlo", async () => {
    vi.useFakeTimers(); let removed = false; let registrations = 0;
    const device: PushDevice = { id: "d", createdAt: new Date().toISOString(), lastSuccessAt: null, preferences: { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true } };
    state.fetcher.mockImplementation(async (path, init) => { if (path === "/api/push/config") return json({ enabled: true, vapidPublicKey: "synthetic-public" }); if (init?.method === "DELETE") { removed = true; throw new TypeError("Respuesta perdida después de aplicar"); } if (path === "/api/push/subscriptions") { registrations++; return json(device); } throw new Error("Unexpected request"); });
    render(<PushSettings />); await act(async () => {}); expect(registrations).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Desactivar en este teléfono" })); await act(async () => {});
    expect(removed).toBe(true); expect(screen.getByText(/No hay un endpoint de lectura que confirme esta eliminación/)).toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: "Router" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); }); expect(registrations).toBe(1); expect(state.fetcher.mock.calls.filter(call => call[1]?.method === "DELETE")).toHaveLength(1);
  });
});
describe("conflicto de versión de arranque", () => {
  it("409 invalida la confirmación, recupera versión vigente por GET y exige revisión explícita", async () => {
    let reads = 0; let writes = 0;
    state.fetcher.mockImplementation(async (_path, init) => { if (init?.method === "POST") { writes++; return json({ error: "Versión antigua" }, 409); } reads++; return json(reads === 1 ? base : { ...base, version: 9 }); });
    const coordinator = new BootActionCoordinator(); const { result } = renderHook(() => useBootDefault(coordinator)); await act(async () => {});
    await act(async () => { expect(await result.current.set("windows")).toBe(false); }); await waitFor(() => expect(result.current.preference?.version).toBe(9));
    expect(result.current.recoveryRequired).toBe(true); expect(result.current.confirmationRevision).toBe(1); await act(async () => { expect(await result.current.set("windows")).toBe(false); }); expect(writes).toBe(1);
    render(<BootDefaultRow boot={result.current} chosen="windows" onRequestSet={vi.fn()} />); expect(screen.getByRole("button", { name: "Revisar preferencia actual" })).toBeEnabled();
    await act(async () => result.current.recover()); expect(result.current.recoveryRequired).toBe(false); expect(writes).toBe(1);
  });
  it("409 con Retry-After no permite recuperación anticipada ni energía", async () => {
    vi.useFakeTimers();
    // Fija el jitter del backoff (60–120 s) sin acortar Retry-After.
    vi.spyOn(Math, "random").mockReturnValue(0);
    let reads = 0; let writes = 0;
    state.fetcher.mockImplementation(async (_path, init) => { if (init?.method === "POST") { writes++; return json({ error: "Versión antigua" }, 409, { "Retry-After": "30" }); } reads++; return json(reads === 1 ? base : { ...base, version: 10 }); });
    const stop = vi.fn(); render(<StopDialog busy={false} onStop={stop} onCancel={vi.fn()} />); await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^Windows$/ })); fireEvent.click(screen.getByRole("button", { name: /Mantén pulsado/ }), { detail: 0 }); await act(async () => {});
    expect(writes).toBe(1); expect(reads).toBe(1); expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revisar preferencia actual" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); }); expect(reads).toBe(1); expect(stop).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(31001); }); expect(reads).toBeGreaterThanOrEqual(2); expect(writes).toBe(1); expect(stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar preferencia actual" })); await act(async () => {}); expect(writes).toBe(1); expect(stop).not.toHaveBeenCalled();
  });
});
