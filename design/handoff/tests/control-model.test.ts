import { describe, expect, it } from "vitest";
import { makeCosts, makeResources, makeServices } from "../states/fixtures.ts";
import { actionBlocker, age, dailyCosts, groupedResources, mapLayout, operationView, relatedResource, resourceAxes, secretView, serviceObservation } from "../ui/src/lib/controlModel.ts";
const now = Date.parse("2026-11-12T12:00:00Z");
const resources = makeResources(now);
const services = makeServices(now);
const context = { online: true, visible: true, canWrite: true, sending: false, ambiguous: false, now, retryAt: 0, inventory: { loading: false, error: null, data: {} }, operations: { error: null, data: {} } };
describe("relaciones y mapa", () => {
  it("no enlaza por nombre ni materializa aliases sin resolver", () => {
    const relation = services[0]!.relations[0]!;
    expect(relatedResource(relation, resources)?.catalog?.catalogId).toBe(relation.resource?.catalogId);
    expect(relatedResource({ ...relation, resolved: false }, resources)).toBeUndefined();
    expect(relatedResource({ ...relation, resource: undefined, resourceId: "inexistente" }, resources)).toBeUndefined();
    const layout = mapLayout(resources, services, "location", now);
    expect(layout.nodes).toHaveLength(resources.length + services.length);
    expect(layout.edges.map(edge => edge.key)).toEqual(["svc:rendicion:0", "svc:rendicion:1", "svc:support:0", "svc:support:1", "svc:hermes:0"]);
    expect(layout.nodes.some(n => n.id === "lab-app-pendiente")).toBe(false);
  });
  it("busca, filtra problemas y cambia agrupación usando datos", () => {
    const searched = mapLayout(resources, services, "location", now, "Rendición branch");
    expect(searched.nodes.map(n => n.id)).toEqual(["svc:rendicion"]);
    const problems = mapLayout(resources, services, "project", now, "", true);
    expect(problems.nodes.every(n => n.problem)).toBe(true);
    expect(problems.nodes.some(n => n.id === "svc:retail")).toBe(true);
    expect(groupedResources(resources).some(g => g.title.includes("us-east-2"))).toBe(true);
  });
  it("no acredita salud lógica por una EC2 encendida", () => {
    const hermes = services.find(s => s.id === "svc:hermes")!;
    expect(serviceObservation(hermes, resources, now).label).toBe("Salud del servicio sin comprobar");
  });
});
describe("autoridad de acciones y estados", () => {
  it("exige actions incluso si actionAvailability afirma permiso", () => {
    expect(actionBlocker({ ...resources[0]!, actions: [], actionAvailability: { stop: { allowed: true, reasonCode: "available" } } }, "stop", context, [])).not.toBeNull();
    expect(actionBlocker(resources[0]!, "stop", { ...context, ambiguous: true }, [])).toContain("mismo envío");
    expect(actionBlocker(resources[0]!, "stop", { ...context, online: false }, [])).toContain("Sin conexión");
    expect(actionBlocker(resources[0]!, "stop", context, [])).toBeNull();
  });
  it("nuevos estados no producen éxito ni excepciones", () => {
    expect(operationView("nuevo")).toMatchObject({ label: "Estado desconocido", final: false, tone: "unk" });
    expect(operationView("toString").tone).toBe("unk");
    expect(secretView("nuevo").label).toBe("Estado desconocido");
    expect(age("fecha inválida", now)).toBe("sin observación");
  });
  it("cuenta cobertura y salud separadas", () => {
    const axes = resourceAxes(resources, now);
    expect(axes.total).toBe(resources.length);
    expect(axes.observed).toBeLessThan(axes.total);
    expect(axes.healthProblems).toBeGreaterThan(0);
  });
});
describe("costes diarios", () => {
  it("excluye parciales, monedas incompatibles y conserva días ausentes", () => {
    const accounts = makeCosts(now).accounts;
    const first = accounts[0]!;
    const second = { ...accounts[1]!, daily: accounts[1]!.daily.slice(1) };
    const rows = dailyCosts([first, second, { ...accounts[2]!, currency: "EUR" }]);
    expect(rows[0]!.amount).toBeNull();
    expect(rows[1]!.amount).toBeCloseTo(first.daily[1]!.amount + second.daily[0]!.amount);
    expect(dailyCosts([{ ...first, status: "partial" }])).toEqual([]);
  });
});
