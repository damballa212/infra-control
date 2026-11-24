import { describe, it, expect } from "vitest";
import type { Operation, Resource, ResourceHealth } from "../ui/src/contract.ts";
import {
  displayName,
  hermesServiceView,
  isHermes,
  isStale,
  mergeResourceEvent,
  needsAttention,
  observedAgents,
  unresolvedOrders,
} from "../ui/src/lib/status.ts";

// Regresiones de la evaluación 2026-11-11 (docs/evaluacion-2026-11-11.md).
const now = Date.parse("2026-11-11T12:00:00Z");
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const res = (id: string, extra: Partial<Resource & { health: ResourceHealth }> = {}): Resource & { health?: ResourceHealth } => ({
  id,
  name: id,
  kind: "computer",
  state: "running",
  location: "casa",
  account: "casa",
  detail: "",
  actions: ["refresh"],
  observedAt: ago(10),
  ...extra,
});
const op = (extra: Partial<Operation>): Operation => ({
  id: "op",
  resourceId: "ec2:a",
  resourceName: "a",
  action: "stop",
  actor: "admin",
  state: "uncertain",
  message: "",
  createdAt: ago(900),
  updatedAt: ago(840),
  ...extra,
} as Operation);

describe("hallazgo 1: eventos SSE de recurso", () => {
  it("un recurso sin catálogo solo sustituye su propia fila", () => {
    const rows = [res("computer:desktop"), res("computer:mac"), res("router:fiberhome", { kind: "router" })];
    const merged = mergeResourceEvent(rows, res("computer:mac", { state: "asleep" }));
    expect(merged.map((r) => r.id)).toEqual(["computer:desktop", "computer:mac", "router:fiberhome"]);
    expect(merged[1]!.state).toBe("asleep");
    expect(merged[0]).toBe(rows[0]);
  });
  it("sustituye por catalogId solo cuando ambos coinciden", () => {
    const catalog = { catalogId: "c1", provider: "aws", accountId: "1", region: "us-east-1", resourceType: "ec2", providerId: "i-1", lifecycle: "active" } as const;
    const rows = [res("legacy:a", { catalog }), res("b")];
    const merged = mergeResourceEvent(rows, res("aws:a", { catalog }));
    expect(merged.map((r) => r.id)).toEqual(["aws:a", "b"]);
  });
  it("un evento más antiguo no pisa una observación más reciente", () => {
    const rows = [res("a", { observedAt: ago(5), state: "running" })];
    expect(mergeResourceEvent(rows, res("a", { observedAt: ago(60), state: "stopped" }))[0]!.state).toBe("running");
  });
});

describe("hallazgo 2: salud y frescura en el resumen", () => {
  it("EC2 encendida con servicio unhealthy necesita atención", () => {
    const ec2 = res("ec2:a", { kind: "ec2", health: { service: { state: "unhealthy", source: "https-probe", observedAt: ago(10) } } });
    expect(needsAttention(ec2, now)).toBe(true);
  });
  it("una lectura antigua necesita atención cuando se conoce la hora", () => {
    const ec2 = res("ec2:a", { kind: "ec2", observedAt: ago(1260) });
    expect(isStale(ec2, now)).toBe(true);
    expect(needsAttention(ec2, now)).toBe(true);
    expect(needsAttention(ec2)).toBe(false);
  });
  it("respeta freshUntil de la fuente antes que el plazo por defecto", () => {
    const mac = res("computer:mac", { observedAt: ago(600), health: { presence: { state: "fresh", source: "mac", observedAt: ago(600), freshUntil: ago(-60) } } });
    expect(isStale(mac, now)).toBe(false);
  });
});

describe("hallazgo 3: órdenes inciertas", () => {
  const ec2 = { id: "ec2:a", state: "running", stateChangedAt: null };
  it("una observación posterior cualquiera no resuelve la orden", () => {
    expect(unresolvedOrders([op({})], [{ ...ec2 }])).toHaveLength(1);
  });
  it("el paso de 24 h no resuelve la orden", () => {
    expect(unresolvedOrders([op({ updatedAt: ago(3 * 86400) })], [ec2])).toHaveLength(1);
  });
  it("se reconcilia con una transición observada al estado esperado", () => {
    expect(unresolvedOrders([op({})], [{ id: "ec2:a", state: "stopped", stateChangedAt: ago(100) }])).toHaveLength(0);
  });
  it("una orden posterior de otra acción no la reconcilia; una de la misma acción sí", () => {
    const later = (action: Operation["action"]) => op({ id: "op2", action, state: "succeeded", updatedAt: ago(60) });
    expect(unresolvedOrders([op({}), later("refresh")], [ec2])).toHaveLength(1);
    expect(unresolvedOrders([op({}), later("stop")], [ec2])).toHaveLength(0);
  });
  it("mantiene fallo e incertidumbre distinguibles", () => {
    const rows = unresolvedOrders([op({ state: "failed", resourceId: "x" }), op({ id: "o2" })], [ec2]);
    expect(rows.map((o) => o.state).sort()).toEqual(["failed", "uncertain"]);
  });
});

describe("hallazgo 5: identidad de Hermes", () => {
  const reporter = (state: "healthy" | "unhealthy" | "unknown") => ({ service: { state, source: "hermes-systemd-reporter", observedAt: ago(5) } });
  it("EC2 encendida sin reporte no acredita servicio Hermes", () => {
    const host = res("ec2:h", { kind: "ec2", name: "orchestrator" });
    expect(isHermes(host)).toBe(true);
    expect(hermesServiceView(host).label).toBe("Servicio sin reporte");
    expect(displayName(host)).toBe("orchestrator · Hermes");
  });
  it("el host lo acredita el reporter del backend, no solo el nombre", () => {
    const host = res("ec2:h", { kind: "ec2", name: "otro-host", health: reporter("unhealthy") });
    expect(isHermes(host)).toBe(true);
    expect(hermesServiceView(host)).toMatchObject({ label: "Servicio con fallo", tone: "bad" });
  });
  it("Agentes lista solo actores observados en órdenes", () => {
    const agents = observedAgents([op({ actor: "hermes", updatedAt: ago(10) }), op({ actor: "hermes", updatedAt: ago(500) }), op({ actor: "admin" })]);
    expect(agents).toEqual([{ actor: "hermes", orders: 2, lastAt: ago(10) }]);
  });
});
