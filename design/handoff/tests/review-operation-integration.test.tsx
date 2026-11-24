import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Operation } from "../ui/src/contract.ts";
const mocks = vi.hoisted(() => ({ provider: { getResources: vi.fn(), getOperations: vi.fn(), getOperation: vi.fn(), getSecretRequests: vi.fn(), getCosts: vi.fn(), createOperation: vi.fn() }, expire: vi.fn() }));
vi.mock("../ui/src/app/providers.ts", () => ({ provider: mocks.provider, isFixture: true }));
vi.mock("../ui/src/app/Session.tsx", () => ({ useSession: () => ({ expire: mocks.expire }) }));
import { AppStateProvider, useAppState } from "../ui/src/app/AppState.tsx";
import { ProviderError } from "../integration/provider.ts";
const at = "2026-11-12T12:00:00Z";
const op = (id: string, state: Operation["state"]): Operation => ({ id, state, resourceId: "r", resourceName: "r", action: "stop", actor: "admin", message: state, createdAt: at, updatedAt: state === "running" ? at : "2026-11-12T12:01:00Z" });
function wrapper({ children }: { children: ReactNode }) { return <AppStateProvider>{children}</AppStateProvider>; }
beforeEach(() => { vi.useFakeTimers(); Object.values(mocks.provider).forEach(mock => mock.mockReset()); mocks.provider.getResources.mockResolvedValue({ resources: [], cursor: 0, fetchedAt: at, refreshSeconds: 60 }); mocks.provider.getSecretRequests.mockResolvedValue({ requests: [] }); });
it("la caché durante backoff no limpia un fallo posterior de la lista", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let lists = 0;
  mocks.provider.getOperations.mockImplementation(async () => {
    lists++;
    if (lists === 5) throw new ProviderError({ kind: "http", status: 500, message: "Lista no disponible" });
    return { operations: lists === 1 ? [op("old", "running")] : [] };
  });
  mocks.provider.getOperation.mockRejectedValue(new ProviderError({ kind: "http", status: 404, message: "No visible" }));
  const { result } = renderHook(useAppState, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(45000); });
  expect(lists).toBe(5);
  expect(result.current.operations.error).toMatchObject({ status: 500 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(lists).toBeGreaterThan(5);
  expect(result.current.operations.error).toBeNull();
});
it("una recuperación individual 404 no bloquea otros recursos ni borra la orden", async () => {
  const resource = (id: string) => ({ id, name: id, kind: "ec2", account: "fixture", location: "fixture", detail: "fixture", state: "running", observedAt: at, actions: ["stop"] });
  mocks.provider.getResources.mockResolvedValue({ resources: [resource("r"), resource("other")], cursor: 0, fetchedAt: at, refreshSeconds: 60 });
  mocks.provider.getOperations.mockResolvedValueOnce({ operations: [op("old", "running")] }).mockResolvedValue({ operations: [] });
  mocks.provider.getOperation.mockRejectedValue(new ProviderError({ kind: "http", status: 404, message: "No visible" }));
  const { result } = renderHook(useAppState, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  expect(mocks.provider.getOperation).toHaveBeenCalledWith("old");
  expect(result.current.operations.error).toBeNull();
  expect(result.current.currentBlocker("r", "stop")).not.toBeNull();
  expect(result.current.currentBlocker("other", "stop")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  expect(result.current.operations.error).toBeNull();
  expect(result.current.currentBlocker("other", "stop")).toBeNull();
  expect(result.current.operations.data?.operations.find(row => row.id === "old")?.state).toBe("running");
});
it("la recuperación fuera de las últimas 100 actualiza el estado compartido y termina el polling activo", async () => {
  const recent = Array.from({ length: 100 }, (_, index) => op("recent-" + index, "succeeded"));
  mocks.provider.getOperations.mockResolvedValueOnce({ operations: [op("old", "running")] }).mockResolvedValue({ operations: recent }); mocks.provider.getOperation.mockResolvedValue(op("old", "succeeded"));
  const { result } = renderHook(useAppState, { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.operations.data?.operations.find(row => row.id === "old")?.state).toBe("running");
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  expect(mocks.provider.getOperation).toHaveBeenCalledExactlyOnceWith("old"); expect(result.current.operations.data?.operations.find(row => row.id === "old")?.state).toBe("succeeded");
  const count = mocks.provider.getOperations.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(mocks.provider.getOperations).toHaveBeenCalledTimes(count);
});
