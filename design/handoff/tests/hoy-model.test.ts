import { describe, expect, it } from "vitest";
import type { AttentionSummary, DetailedResource, Operation } from "../ui/src/contract.ts";
import { buildFleet, verdict, verdictDetail, zoneOf, type FleetCounts } from "../ui/src/lib/hoyModel.ts";
import { placeZones } from "../ui/src/components/FleetScene.tsx";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function summary(counts: Partial<AttentionSummary["counts"]> = {}): AttentionSummary {
  return { fetchedAt: iso(5000), counts: { attentionGroups: 0, active: 0, pendingReviews: 0, openIncidents: 0, unknownIncidents: 0, coverageProblems: 0, ...counts }, coverage: { scopes: 4, healthy: 4, partial: 0, failed: 0, stale: 0 } };
}
const cleanFleet: FleetCounts = { ok: 3, bad: 0, off: 1, busy: 0, attention: 0, unknown: 0, total: 4 };
const base = { summaryError: false, pendingCount: 0 as number | null, personal: true, activeOperations: [] as Operation[], fleet: cleanFleet, inventoryReady: true };

function resource(patch: Partial<DetailedResource>): DetailedResource {
  return { id: "aws:x", name: "x", kind: "ec2", state: "running", location: "us-east-1", account: "prod", detail: "", actions: [], observedAt: iso(10_000), ...patch } as DetailedResource;
}

describe("veredicto de Hoy", () => {
  it("suma el conteo completo de peticiones y grupos de atención, no lo que cabe en la página", () => {
    const v = verdict({ ...base, summary: summary({ attentionGroups: 7 }), pendingCount: 42 });
    expect(v).toMatchObject({ kind: "attention", total: 49, title: "49 cosas te tocan" });
  });

  it("usa singular para una sola tarea", () => {
    expect(verdict({ ...base, summary: summary({ attentionGroups: 1 }) }).title).toBe("1 cosa te toca");
  });

  it("sin resumen no declara «Todo en orden»", () => {
    expect(verdict({ ...base, summary: null }).kind).toBe("checking");
    const failed = verdict({ ...base, summary: null, summaryError: true });
    expect(failed).toMatchObject({ kind: "unknown", total: null });
    expect(verdictDetail(failed, base)).toContain("No lo tomo como «todo bien»");
  });

  it("con peticiones sin comprobar no dice «nada te toca»", () => {
    expect(verdict({ ...base, summary: summary(), pendingCount: null }).kind).toBe("checking");
    const failed = verdict({ ...base, summary: summary(), pendingCount: null, pendingError: true });
    expect(failed).toMatchObject({ kind: "unknown", total: null });
    expect(verdictDetail(failed, { ...base, pendingCount: null })).toContain("No lo tomo como «nada pendiente»");
    // Con otras tareas confirmadas se cuentan, y el detalle avisa de lo que falta.
    const partial = verdict({ ...base, summary: summary({ attentionGroups: 2 }), pendingCount: null, pendingError: true });
    expect(partial.title).toBe("2 cosas te tocan");
    expect(verdictDetail(partial, { ...base, pendingCount: null })).toContain("Peticiones sin comprobar");
  });

  it("sin fuentes comprobadas, sin inventario o con un resumen viejo no hay estado verde", () => {
    const unchecked = { ...summary(), coverage: { scopes: 0, healthy: 0, partial: 0, failed: 0, stale: 0 } };
    expect(verdict({ ...base, summary: unchecked }).kind).toBe("quiet");
    expect(verdict({ ...base, summary: summary(), inventoryReady: false, fleet: { ok: 0, bad: 0, off: 0, busy: 0, attention: 0, unknown: 0, total: 0 } }).kind).toBe("quiet");
    const stale = verdict({ ...base, summary: summary(), summaryError: true });
    expect(stale.kind).toBe("quiet");
    expect(verdictDetail(stale, { ...base, summaryError: true })).toContain("Según la última lectura");
  });

  it("problemas de cobertura o equipos con fallo impiden el estado verde", () => {
    expect(verdict({ ...base, summary: summary({ coverageProblems: 1 }) }).kind).toBe("quiet");
    expect(verdict({ ...base, summary: summary(), fleet: { ...cleanFleet, bad: 1 } }).kind).toBe("quiet");
    expect(verdict({ ...base, summary: summary() }).kind).toBe("ok");
  });

  it("una orden de encendido de la PC en curso se nombra; otras se cuentan", () => {
    const op = { id: "o1", resourceId: "computer:desktop", resourceName: "PC de casa", action: "boot-cachyos", actor: "admin", state: "running", message: "", createdAt: iso(1000), updatedAt: iso(500) } as Operation;
    expect(verdict({ ...base, summary: summary({ active: 1 }), activeOperations: [op] }).title).toBe("Encendiendo la PC");
    expect(verdict({ ...base, summary: summary({ active: 2 }), activeOperations: [op, { ...op, id: "o2", resourceId: "aws:y" }] }).title).toBe("2 órdenes en curso");
  });

  it("las sesiones de agente no cuentan peticiones", () => {
    expect(verdict({ ...base, personal: false, pendingCount: null, summary: summary() }).kind).toBe("ok");
  });
});

describe("flota de Hoy", () => {
  it("agrupa por proveedor y cuenta una app caída en un EC2 encendido como fallo", () => {
    const unhealthy = resource({ id: "aws:erp", name: "prod-erp", health: { service: { state: "unhealthy", observedAt: iso(50_000) } } as DetailedResource["health"] });
    const { zones, counts } = buildFleet([unhealthy, resource({ id: "aws:cms", name: "prod-cms" }), resource({ id: "computer:desktop", name: "PC", kind: "computer", state: "unconfigured", observedAt: null })], [], NOW);
    expect(zones.map(z => z.name)).toEqual(["AWS", "Casa"]);
    expect(counts.bad).toBe(1);
    expect(counts.ok).toBe(1);
    expect(counts.total).toBe(3);
  });

  it("un recurso con orden activa se ve en curso", () => {
    const op = { id: "o", resourceId: "aws:cms", state: "accepted" } as Operation;
    expect(buildFleet([resource({ id: "aws:cms", name: "prod-cms" })], [op], NOW).counts.busy).toBe(1);
  });

  it("zoneOf separa AWS, Coolify y Casa", () => {
    expect(zoneOf({ kind: "ec2" })).toBe("AWS");
    expect(zoneOf({ kind: "service" })).toBe("Coolify");
    expect(zoneOf({ kind: "router" })).toBe("Casa");
  });

  it("una zona grande apila el resto sin esconder fallos", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, status: i === 29 ? "bad" as const : "ok" as const }));
    const [zone] = placeZones([{ name: "AWS", nodes }]);
    expect(zone!.shown.length + zone!.hidden).toBe(30);
    expect(zone!.hidden).toBeGreaterThan(0);
    expect(zone!.shown.some(node => node.status === "bad")).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, name: `b${i}`, status: "bad" as const }));
    const [crowded] = placeZones([{ name: "AWS", nodes: many }]);
    expect(crowded!.shown.every(node => node.status === "bad")).toBe(true);
    expect(crowded!.hidden).toBe(20 - crowded!.shown.length);
  });
});
