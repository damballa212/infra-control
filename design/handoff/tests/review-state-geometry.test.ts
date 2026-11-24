import { describe, expect, it, vi } from "vitest";
import type { DetailedResource, Operation, ResourcesSnapshotResponse } from "../ui/src/contract.ts";
import { LiveState } from "../ui/src/lib/liveState.ts";
import { OperationReader } from "../ui/src/lib/operationReader.ts";
import { mapLayout, type MapBounds } from "../ui/src/lib/controlModel.ts";
import { ProviderError } from "../integration/provider.ts";
const at = "2026-11-12T12:00:00Z";
const resource = (id = "r"): DetailedResource => ({ id, name: "Servidor-con-un-nombre-completo-muy-largo-" + id, kind: "ec2", account: "Cuenta", location: "us-east-1", detail: "EC2", state: "running", observedAt: at, actions: ["stop"] });
const snapshot = (cursor: number, resources: DetailedResource[]): ResourcesSnapshotResponse => ({ cursor, resources, fetchedAt: at, refreshSeconds: 60 });
const op = (id: string, state: Operation["state"] = "running"): Operation => ({ id, resourceId: "r", resourceName: "r", action: "stop", actor: "admin", state, createdAt: at, updatedAt: state === "running" ? at : "2026-11-12T12:01:00Z", message: state });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function overlaps(a: MapBounds, b: MapBounds) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }
describe("snapshot seguido de SSE tardío", () => {
  it("un snapshot cubre el SSE recibido mientras su GET estaba en vuelo", () => {
    const store = new LiveState();
    store.acceptInventory(snapshot(10, [resource()]), store.begin());
    const started = store.begin();
    store.resourceEvent(resource(), 20);
    store.acceptInventory(snapshot(30, [{ ...resource(), state: "stopped", actions: ["start"] }]), started);
    expect(store.resourceEvent(resource(), 25)).toBe(false);
    expect(store.inventory()?.resources[0]).toMatchObject({ state: "stopped", actions: ["start"] });
  });
  it("cursor 30 protege estado y acciones contra eventos 20 y 30", () => {
    const store = new LiveState(); store.acceptInventory(snapshot(1, [resource()]), store.begin()); store.resourceEvent(resource(), 10);
    const changed = { ...resource(), state: "unreachable", actions: [] };
    store.acceptInventory(snapshot(30, [changed]), store.begin());
    expect(store.resourceEvent(resource(), 20)).toBe(false); expect(store.resourceEvent(resource(), 30)).toBe(false);
    expect(store.inventory()?.resources[0]).toMatchObject({ state: "unreachable", actions: [], observedAt: at });
  });
  it("no resucita recursos ni aliases omitidos, ni acepta un snapshot más antiguo", () => {
    const store = new LiveState(); store.acceptInventory(snapshot(10, [resource()]), store.begin());
    store.acceptInventory(snapshot(30, []), store.begin()); expect(store.resourceEvent(resource(), 20)).toBe(false);
    store.acceptInventory(snapshot(15, [resource()]), store.begin()); expect(store.inventory()?.resources).toEqual([]);
    expect(store.resourceEvent(resource(), 31)).toBe(true);
  });
});
describe("recuperación individual compartida", () => {
  it("recupera una terminal fuera de la ventana y no interpreta omisiones como éxito", async () => {
    const store = new LiveState(); store.attach(op("old")); const get = vi.fn(async (id: string) => op(id, "succeeded")); const changed = vi.fn();
    const reader = new OperationReader({ store, get, changed, available: () => true, unauthorized: vi.fn() });
    const started = store.begin(); const visible = new Set(Array.from({ length: 100 }, (_, i) => "recent" + i));
    store.acceptOperations({ operations: [...visible].map(id => op(id, "succeeded")) }, started);
    expect(store.activity()?.operations.find(row => row.id === "old")?.state).toBe("running");
    await reader.recoverOutside(visible, started);
    expect(get).toHaveBeenCalledExactlyOnceWith("old"); expect(store.activity()?.operations.find(row => row.id === "old")?.state).toBe("succeeded"); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("deduplica, limita a dos y ejecuta secuencialmente con rotación", async () => {
    const store = new LiveState(); ["a", "b", "c"].forEach(id => store.attach(op(id))); const first = deferred<Operation>();
    const get = vi.fn().mockReturnValueOnce(first.promise).mockImplementation(async (id: string) => op(id));
    const reader = new OperationReader({ store, get, changed: vi.fn(), available: () => true, unauthorized: vi.fn() });
    const batch = reader.recoverOutside(new Set(), store.begin()); const duplicate = reader.read("a");
    expect(get).toHaveBeenCalledTimes(1); first.resolve(op("a")); await duplicate; await batch; expect(get).toHaveBeenCalledTimes(2);
    await reader.recoverOutside(new Set(), store.begin(), 1); expect(get.mock.calls[2]?.[0]).toBe("c");
  });
  it("descarta respuesta tras terminar el contexto y no pisa un SSE terminal posterior", async () => {
    const store = new LiveState(); store.attach(op("a")); const pending = deferred<Operation>(); const changed = vi.fn();
    const reader = new OperationReader({ store, get: () => pending.promise, changed, available: () => true, unauthorized: vi.fn() });
    const request = reader.read("a"); const rejection = expect(request).rejects.toThrow(); reader.deactivate(); pending.resolve(op("a", "succeeded")); await rejection; await Promise.resolve();
    expect(changed).not.toHaveBeenCalled(); expect(store.activity()?.operations[0]?.state).toBe("running");
    const next = deferred<Operation>(); const other = new OperationReader({ store, get: () => next.promise, changed, available: () => true, unauthorized: vi.fn() });
    const response = other.read("a"); store.attach(op("a", "uncertain"), 40); next.resolve(op("a", "succeeded")); expect((await response).state).toBe("uncertain");
  });
  it("respeta Retry-After y 404 conserva la orden pendiente", async () => {
    vi.useFakeTimers(); const store = new LiveState(); store.attach(op("a"));
    const get = vi.fn().mockRejectedValueOnce(new ProviderError({ kind: "http", status: 503, retryAfterSeconds: 45, message: "Espera" })).mockRejectedValueOnce(new ProviderError({ kind: "http", status: 404, message: "No visible" }));
    const reader = new OperationReader({ store, get, changed: vi.fn(), available: () => true, unauthorized: vi.fn() });
    await expect(reader.read("a")).rejects.toMatchObject({ status: 503 }); await vi.advanceTimersByTimeAsync(44999); await expect(reader.read("a")).rejects.toMatchObject({ retryAfterSeconds: 1 }); expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(reader.read("a")).rejects.toMatchObject({ status: 404 }); expect(store.activity()?.operations[0]?.state).toBe("running");
  });
});
describe("geometría completa del mapa", () => {
  it.each([4, 7, 12])("%i EC2 de nombres largos no se solapan ni se recortan", count => {
    const rows = Array.from({ length: count }, (_, i) => resource(String(i)));
    const layout = mapLayout(rows, [], "location", Date.parse(at));
    for (const node of layout.nodes) {
      expect(node.labelLines.join("")).toBe(node.name);
      expect(node.bounds.x).toBeGreaterThanOrEqual(0); expect(node.bounds.y).toBeGreaterThanOrEqual(0);
      expect(node.bounds.x + node.bounds.width).toBeLessThanOrEqual(layout.width); expect(node.bounds.y + node.bounds.height).toBeLessThanOrEqual(layout.height);
      expect(node.bounds.y).toBeLessThanOrEqual(node.y - node.height - 19); expect(node.bounds.y + node.bounds.height).toBeGreaterThanOrEqual(node.y + 19);
    }
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) expect(overlaps(layout.nodes[i]!.bounds, layout.nodes[j]!.bounds)).toBe(false);
  });
  it("distribuye zonas en cuadrícula adaptable con límites separados", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...resource(String(i)), account: "Cuenta-" + Math.floor(i / 2) }));
    const wide = mapLayout(rows, [], "location", Date.parse(at), "", false, 2); const mobile = mapLayout(rows, [], "location", Date.parse(at), "", false, 1);
    expect(new Set(wide.zones.map(zone => zone.bounds.x)).size).toBe(2); expect(new Set(mobile.zones.map(zone => zone.bounds.x)).size).toBe(1);
    for (let i = 0; i < wide.zones.length; i++) for (let j = i + 1; j < wide.zones.length; j++) expect(overlaps(wide.zones[i]!.bounds, wide.zones[j]!.bounds)).toBe(false);
  });
});
