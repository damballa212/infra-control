import { describe, expect, it } from "vitest";
import { activeMoreCount, activityQuery, dayGroups, incidentView, mergeRows, orderTone } from "../ui/src/lib/activityModel.ts";
import { accountStanding, budgetView, dailyBars, serviceBreakdown, summarizeCosts, untilLabel } from "../ui/src/lib/costs.ts";
import { makeCosts } from "../states/fixtures.ts";

const now = new Date(2026, 10, 13, 15, 0).getTime();
describe("modelo de Actividad", () => {
  it("traduce chips y más filtros a parámetros del servidor", () => {
    expect(activityQuery("orders", "uncertain", " fast ", { actor: " Admin ", type: "boot-cachyos" })).toEqual({ state: "uncertain", q: "fast", actor: "Admin", type: "boot-cachyos" });
    expect(activityQuery("orders", "active", "", { actor: "", type: "" })).toEqual({ view: "active" });
    expect(activityQuery("keys", "created", "", { actor: "audit-owner", type: "stop" })).toEqual({ type: "created", actor: "audit-owner" });
    expect(activityQuery("incidents", "open", "", { actor: "x", type: "budget" })).toEqual({ state: "open", type: "budget" });
    expect(activityQuery("orders", "desconocido", "", { actor: "", type: "" })).toEqual({});
    expect(activeMoreCount("incidents", { actor: "x", type: "" })).toBe(0);
    expect(activeMoreCount("orders", { actor: "x", type: "start" })).toBe(2);
  });
  it("une páginas sin duplicar y conserva el orden del servidor", () => {
    expect(mergeRows([{ id: "a" }, { id: "b" }], [[{ id: "b" }, { id: "c" }], [{ id: "d" }]], row => row.id).map(row => row.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("agrupa por día local: Hoy, Ayer y fecha; sin fecha aparte", () => {
    const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
    const groups = dayGroups([{ at: at(13, 9) }, { at: at(13, 1) }, { at: at(12, 22) }, { at: at(3, 8) }, { at: "no" }], row => row.at, now);
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([["Hoy", 2], ["Ayer", 1], [groups[2]!.label, 1], ["Sin fecha", 1]]);
    expect(groups[2]!.label).toMatch(/^[A-ZÁÉÍÓÚ].*3/);
  });
  it("un reconocimiento no cambia el tono ni la etiqueta de un episodio abierto", () => {
    expect(incidentView({ status: "open", actionable: true, kind: "application" })).toEqual({ label: "Abierto", tone: "bad" });
    expect(incidentView({ status: "resolved", actionable: false, kind: "application" }).label).toBe("Resuelto");
    expect(orderTone("uncertain")).toBe("unc"); expect(orderTone("raro")).toBe("neutral");
  });
});
describe("modelo de Costes", () => {
  const accounts = makeCosts(now).accounts;
  it("explica por qué una cuenta no se suma y nunca la muestra como cero", () => {
    expect(accountStanding({ ...accounts[0]!, status: "unavailable", net: null })).toEqual({ counted: false, note: "sin datos · no se suma" });
    expect(accountStanding({ ...accounts[0]!, status: "partial" }).note).toBe("parcial · no se suma");
    expect(accountStanding({ ...accounts[0]!, currency: "EUR" }).note).toBe("EUR · no se suma");
    expect(accountStanding(accounts[0]!).counted).toBe(true);
  });
  it("el desglose agregado usa solo cuentas que suman", () => {
    const partial = [accounts[0]!, { ...accounts[1]!, status: "partial" as const }];
    const all = serviceBreakdown(partial, 10);
    expect(all.rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(18.4);
    expect(serviceBreakdown([partial[1]!]).partial).toBe(true);
    expect(serviceBreakdown(accounts, 2).rows.at(-1)!.name).toBe("Otros");
    expect(summarizeCosts(partial).count).toBe(1);
  });
  it("presupuesto que se va a pasar y días parciales", () => {
    expect(budgetView({ name: "b", limit: 25, actual: 20, forecast: 31, currency: "USD", updatedAt: null }).over).toBeCloseTo(6);
    expect(budgetView({ name: "b", limit: 25, actual: null, forecast: null, currency: "USD", updatedAt: null })).toEqual({ spent: null, forecast: null, over: null });
    const today = new Date(now).toISOString().slice(0, 10);
    const bars = dailyBars([{ date: "2026-11-01", amount: 2 }, { date: "2026-11-02", amount: null }, { date: today, amount: 1 }], now);
    expect(bars.map(b => [b.height, b.partial])).toEqual([[100, false], [0, false], [50, true]]);
    expect(untilLabel(new Date(now + 23 * 3600000).toISOString(), now)).toBe("en 23 h");
    expect(untilLabel(new Date(now - 1000).toISOString(), now)).toBe("pendiente");
  });
});
