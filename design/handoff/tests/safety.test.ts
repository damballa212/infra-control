import { describe, it, expect } from "vitest";
import { makeCosts, makeResources } from "../states/fixtures.ts";
import { summarizeCosts } from "../ui/src/lib/costs.ts";
import { inventoryNotice } from "../ui/src/lib/inventoryNotice.ts";
import { hermesMood } from "../ui/src/lib/mood.ts";
import { formatUsd } from "../ui/src/lib/format.ts";
import { describeResourceState, kindLabel } from "../ui/src/lib/status.ts";
const anchor = Date.parse("2026-10-21T03:00:00Z");
describe("datos reales y estados honestos", () => {
  it("señal ausente de la PC no equivale a apagada", () => {
    expect(describeResourceState({ kind: "computer", state: "unreachable" })).toMatchObject({ label: "Sin señal", tone: "unk" });
  });
  it("una PC integrada no aparece como pendiente de conectar", () => {
    expect(kindLabel({ kind: "computer", detail: "WOL", state: "running" })).toBe("EQUIPO · ACCESO REMOTO");
  });
  it("excluye cuentas parciales, inaccesibles y monedas distintas de la suma", () => {
    const accounts = makeCosts(anchor).accounts;
    accounts[1] = { ...accounts[1]!, status: "partial" };
    accounts[2] = { ...accounts[2]!, currency: "EUR" };
    expect(summarizeCosts(accounts)).toMatchObject({
      net: 18.4,
      count: 1,
      complete: false,
    });
  });
  it("no convierte ausencias en cero ni presenta un total vacío", () => {
    expect(formatUsd(null)).toBe("—");
    expect(summarizeCosts([]).net).toBeNull();
    expect(
      summarizeCosts(
        makeCosts(anchor).accounts.map((a) => ({ ...a, net: null })),
      ).net,
    ).toBeNull();
  });
  it("un resultado incierto nunca representa Hermes dormido", () => {
    expect(hermesMood({ state: "running" }, { state: "uncertain" })).toBe(
      "unsure",
    );
  });
  it("distingue sin conexión de reporte antiguo y de fallo parcial", () => {
    const resources = makeResources(anchor);
    expect(
      inventoryNotice({
        online: false,
        error: null,
        resources,
        now: anchor,
        loading: false,
      })?.title,
    ).toBe("Sin conexión");
    expect(
      inventoryNotice({
        online: true,
        error: null,
        resources: resources.map((r) => ({
          ...r,
          observedAt: new Date(anchor - 360000).toISOString(),
        })),
        now: anchor,
        loading: false,
      })?.title,
    ).toBe("Datos antiguos");
  });
  it("Coolify running:unhealthy es fallo, no estado saludable o desconocido", () => {
    expect(
      describeResourceState({ kind: "service", state: "running:unhealthy" })
        .tone,
    ).toBe("bad");
  });
});
