import { describe, it, expect } from "vitest";
import type { CatalogServiceRecord, OperationHistoryEvent } from "../ui/src/contract.ts";
import { blockedActions, formatBytes, groupServices, healthRows, historySteps, metricRows, reasonLabel } from "../ui/src/lib/insight.ts";
import { createFixtureProvider } from "../integration/fixtureProvider.ts";
import { makeServices } from "../states/fixtures.ts";

const at = "2026-11-11T12:00:00Z";

describe("detalle del equipo", () => {
  it("separa señales con etiquetas en español y motivo legible", () => {
    const rows = healthRows({
      presence: { state: "fresh", source: "pc", observedAt: at },
      service: { state: "unknown", source: "host-services", observedAt: null, reasonCode: "application_health_not_probed" },
    });
    expect(rows).toEqual([
      { key: "presence", label: "Presencia", state: "Al día", tone: "on", reason: null, observedAt: at },
      { key: "service", label: "Salud de la app", state: "Sin comprobar", tone: "unk", reason: "La salud de la app no se comprueba", observedAt: null },
    ]);
  });
  it("un código desconocido no se muestra crudo", () => {
    expect(reasonLabel("weird_code")).toBe("Motivo sin descripción en esta versión");
  });
  it("explica acciones bloqueadas y omite las obvias por estado", () => {
    expect(
      blockedActions({
        actionAvailability: {
          stop: { allowed: false, reasonCode: "observation_stale" },
          start: { allowed: false, reasonCode: "state_mismatch" },
          refresh: { allowed: true, reasonCode: "available" },
        },
      }),
    ).toEqual([{ action: "Apagar", reason: "La última lectura es antigua; consulta antes de actuar" }]);
  });
  it("presenta métricas con su hora y bytes humanos", () => {
    expect(formatBytes(8 * 1024 ** 3)).toBe("8 GB");
    const rows = metricRows({
      cpu: { percent: 12.4, observedAt: at },
      memory: { usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, utilizationPercent: 25, observedAt: at },
      filesystems: [{ device: "sda1", mountpoint: "/", utilizationPercent: 71.6, observedAt: at }],
    });
    expect(rows.map((r) => `${r.label}: ${r.value}`)).toEqual(["CPU: 12 %", "Memoria: 25 % · 2 GB de 8 GB", "Disco /: 72 %"]);
  });
});

describe("historial de la orden", () => {
  const ev = (id: number, state: string, createdAt: string, message = ""): OperationHistoryEvent => ({
    id, type: "operation", aggregateId: "operation:o1", payload: { state, message }, createdAt,
  });
  it("usa las horas del registro durable y colapsa repeticiones", () => {
    const steps = historySteps([
      ev(1, "accepted", "2026-11-11T12:00:00Z"),
      ev(2, "running", "2026-11-11T12:00:02Z", "Enviada"),
      ev(3, "running", "2026-11-11T12:00:05Z", "Enviada"),
      ev(4, "uncertain", "2026-11-11T12:01:00Z", "AWS no confirmó"),
    ]);
    expect(steps.map((s) => [s.label, s.at])).toEqual([
      ["Registrada", "2026-11-11T12:00:00Z"],
      ["En curso", "2026-11-11T12:00:02Z"],
      ["Sin confirmar", "2026-11-11T12:01:00Z"],
    ]);
  });
  it("el fixture registra creación y resultado de cada orden", async () => {
    const provider = createFixtureProvider({ latencyMs: 0 });
    const [first] = (await provider.getOperations()).operations;
    const { events } = await provider.getOperationHistory(first!.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.payload.state).toBe("accepted");
  });
});

describe("servicios por proyecto", () => {
  it("agrupa por proyecto y entorno declarados, sin proyecto al final", () => {
    const base = makeServices(Date.parse(at));
    const orphan: CatalogServiceRecord = { ...base[0]!, id: "x", projectId: null, project: null, environment: null };
    const titles = groupServices([orphan, ...base]).map((g) => g.title);
    expect(titles.at(-1)).toBe("Sin proyecto");
    expect(titles).toContain("a small business · producción");
  });
  it("omite servicios inactivos", () => {
    const [svc] = makeServices(Date.parse(at));
    expect(groupServices([{ ...svc!, active: false }])).toEqual([]);
  });
});
