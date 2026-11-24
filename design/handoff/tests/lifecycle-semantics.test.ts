import { describe, expect, it } from "vitest";
import type { DetailedResource } from "../ui/src/contract.ts";
import { describeResourceState, hasServiceProblem, isStale, needsAttention } from "../ui/src/lib/status.ts";
import { resourceAxes } from "../ui/src/lib/controlModel.ts";
const now = Date.parse("2026-11-12T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const resource = (patch: Partial<DetailedResource> = {}): DetailedResource => ({
  id: "fixture-resource", name: "Fixture", kind: "ec2", state: "running", location: "fixture", account: "fixture", detail: "fixture", actions: [], observedAt: ago(10), ...patch,
});
describe("normalidad y veracidad de evidencia", () => {
  it.each(["asleep", "stopped", "unreachable"])("un equipo personal %s no genera intervención por no seguir reportando", state => {
    const r = resource({ kind: "computer", state, observedAt: ago(86400), monitoring: { availability: "on-demand" } });
    expect(needsAttention(r, now)).toBe(false);
    expect(r.observedAt).toBe(ago(86400));
  });
  it("no exige configurar otra vez un portátil para que su ausencia sea normal", () => {
    expect(needsAttention(resource({ kind: "computer", state: "unknown", observedAt: null }), now)).toBe(false);
  });
  it("respeta la cadencia AWS sin fabricar nueva evidencia", () => {
    const r = resource({ observedAt: ago(300) });
    expect(isStale(r, now)).toBe(false);
    expect(needsAttention(r, now)).toBe(false);
    expect(r.observedAt).toBe(ago(300));
  });
  it("una lectura running de88h no es disponibilidad actual verde", () => {
    const r = resource({ observedAt: ago(88 * 3600) });
    expect(isStale(r, now)).toBe(true);
    expect(describeResourceState(r, now).tone).not.toBe("on");
    expect(resourceAxes([r], now).available).toBe(0);
  });
  it("el plazo explícito de una fuente prevalece sobre el fallback", () => {
    const r = resource({ health: { presence: { state: "fresh", source: "fixture", observedAt: ago(10), freshUntil: ago(1) } } });
    expect(isStale(r, now)).toBe(true);
  });
  it("HTTPS sano no esconde un fallo independiente de Hermes", () => {
    const r = resource({ health: { service: { state: "healthy", source: "https-probe", observedAt: ago(5) } }, serviceSignals: { hermes: { state: "unhealthy", source: "hermes-systemd-reporter", observedAt: ago(5) } } });
    expect(hasServiceProblem(r)).toBe(true);
    expect(needsAttention(r, now)).toBe(true);
  });
  it("un servicio bajo demanda detenido no se anuncia averiado por defecto", () => {
    const r = resource({ kind: "service", state: "exited", observedAt: ago(10) });
    expect(describeResourceState(r, now).tone).toBe("off");
    expect(needsAttention(r, now)).toBe(false);
  });
  it("no silencia una señal funcional explícita de un equipo encendido", () => {
    const r = resource({ kind: "computer", health: { service: { state: "unhealthy", source: "https-probe", observedAt: ago(5) } } });
    expect(needsAttention(r, now)).toBe(true);
  });
});
