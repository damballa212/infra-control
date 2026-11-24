import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DetailedResource, Operation, OperationsResponse, ResourcesSnapshotResponse } from "../ui/src/contract.ts";
import { ProviderError } from "../integration/provider.ts";
const mocks = vi.hoisted(() => ({ provider: { getResources: vi.fn(), getOperations: vi.fn(), getSecretRequests: vi.fn(), getCosts: vi.fn(), createOperation: vi.fn() }, expire: vi.fn() }));
vi.mock("../ui/src/app/providers.ts", () => ({ provider: mocks.provider, isFixture: false }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ expire: mocks.expire }) }));
import { AppStateProvider, useAppState } from "../ui/src/app/AppState.tsx";
import { LiveState } from "../ui/src/lib/liveState.ts";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const at = "2026-11-12T12:00:00Z";
function resource(extra: Partial<DetailedResource> = {}): DetailedResource { return { id: "computer:desktop", name: "PC", kind: "computer", state: "running", account: "Casa", location: "Casa", detail: "Dual boot", actions: ["stop", "refresh"], observedAt: at, ...extra }; }
function operation(extra: Partial<Operation> = {}): Operation { return { id: "new", resourceId: "computer:desktop", resourceName: "PC", action: "stop", actor: "admin", state: "accepted", createdAt: at, updatedAt: at, message: "Registrada", ...extra }; }
function snapshot(rows = [resource()], cursor = 10): ResourcesSnapshotResponse { return { resources: rows, cursor, fetchedAt: at, refreshSeconds: 60 }; }
class Stream extends EventTarget {
  static instances: Stream[] = [];
  constructor(_url: string) { super(); Stream.instances.push(this); }
  close() {}
  emit(type: string, value: unknown, sequence: number) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value), lastEventId: String(sequence) })); }
}
function wrapper({ children }: { children: ReactNode }) { return <AppStateProvider>{children}</AppStateProvider>; }
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at); vi.stubGlobal("EventSource", Stream); Stream.instances = [];
  Object.values(mocks.provider).forEach(mock => mock.mockReset());
  mocks.provider.getResources.mockResolvedValue(snapshot()); mocks.provider.getOperations.mockResolvedValue({ operations: [] }); mocks.provider.getSecretRequests.mockResolvedValue({ requests: [] });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("GET tardíos, actualizaciones locales y SSE", () => {
  it("conserva una orden adjunta durante un GET vacío y mantiene polling aunque el siguiente GET también la omita", async () => {
    const pending = deferred<OperationsResponse>(); mocks.provider.getOperations.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useAppState, { wrapper }); await flush();
    act(() => result.current.attach(operation()));
    await act(async () => pending.resolve({ operations: [] })); await flush();
    expect(result.current.operations.data?.operations).toHaveLength(1);
    expect(result.current.operations.data?.operations[0]?.state).toBe("accepted");
    await flush(5100); expect(mocks.provider.getOperations.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.operations.data?.operations[0]?.id).toBe("new");
  });
  it("un GET fallido no borra la orden local ni pierde polling; Retry-After sobrevive", async () => {
    const pending = deferred<OperationsResponse>(); mocks.provider.getOperations.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useAppState, { wrapper }); await flush();
    act(() => result.current.attach(operation()));
    await act(async () => pending.reject(new ProviderError({ kind: "http", status: 429, retryAfterSeconds: 45, message: "Espera" })));
    expect(result.current.operations.data?.operations[0]?.id).toBe("new");
    await flush(44999); expect(mocks.provider.getOperations).toHaveBeenCalledTimes(1);
    await flush(101); expect(mocks.provider.getOperations.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.operations.data?.operations[0]?.state).toBe("accepted");
  });
  it("protege cambios derivados con observedAt idéntico contra un GET tardío y un SSE fuera de orden", async () => {
    const { result } = renderHook(useAppState, { wrapper }); await flush();
    const late = deferred<ResourcesSnapshotResponse>(); mocks.provider.getResources.mockReturnValueOnce(late.promise);
    act(() => result.current.inventory.refresh()); await flush(60000);
    const stream = Stream.instances.at(-1)!;
    act(() => stream.emit("resource", resource({ state: "unreachable", actions: [] }), 21));
    act(() => stream.emit("resource", resource({ state: "running" }), 20));
    await act(async () => late.resolve(snapshot([resource()], 20))); await flush();
    expect(result.current.inventory.data?.resources[0]?.state).toBe("unreachable");
    expect(result.current.inventory.data?.resources[0]?.observedAt).toBe(at);
  });
  it("una orden terminal no retrocede por GET ni por SSE anterior", async () => {
    const { result } = renderHook(useAppState, { wrapper }); await flush(); const stream = Stream.instances.at(-1)!;
    act(() => stream.emit("operation", operation({ state: "running", updatedAt: "2026-11-12T12:00:01Z" }), 31));
    act(() => stream.emit("operation", operation({ state: "succeeded", updatedAt: "2026-11-12T12:00:02Z" }), 32));
    act(() => stream.emit("operation", operation({ state: "accepted", updatedAt: "2026-11-12T12:00:00Z" }), 30));
    expect(result.current.operations.data?.operations[0]?.state).toBe("succeeded");
    const store = new LiveState(); store.attach(operation({ state: "succeeded", updatedAt: "2026-11-12T12:00:02Z" }));
    expect(store.acceptOperations({ operations: [operation()] }, store.begin()).operations[0]?.state).toBe("succeeded");
  });
  it("una función submit capturada revalida la autoridad vigente al despachar", async () => {
    const { result } = renderHook(useAppState, { wrapper }); await flush(); const submit = result.current.submit;
    act(() => Stream.instances.at(-1)!.emit("desktop", resource({ actions: [] }), 22));
    await expect(submit({ resourceId: "computer:desktop", action: "stop", confirmed: true })).rejects.toThrow();
    expect(mocks.provider.createOperation).not.toHaveBeenCalled();
  });
});
