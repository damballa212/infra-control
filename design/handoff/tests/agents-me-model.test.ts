import { describe, expect, it } from "vitest";
import type { DetailedResource, SecretGrant, SecretRequest } from "../ui/src/contract.ts";
import { countdown, deadlineText, historyChips, knownCollections, needsProductionConfirm, tokenMachines, validPastedValue } from "../ui/src/lib/agentsModel.ts";
import { healthExtras, inventorySources } from "../ui/src/lib/meModel.ts";

const now = Date.parse("2026-11-13T12:00:00Z");
const iso = (min: number) => new Date(now + min * 60000).toISOString();
const req = (patch: Partial<SecretRequest> = {}): SecretRequest => ({ id: "r", agent: "claude", machine: "Mac", name: "K", project: "p", environment: "dev", destination: { kind: "process" }, reason: "x", state: "pending", scope: null, createdAt: iso(-1), expiresAt: iso(29), decidedAt: null, deliveredAt: null, auto: false, ...patch });
const res = (patch: Partial<DetailedResource>): DetailedResource => ({ id: "x", name: "x", kind: "ec2", state: "running", location: "us-east-1", account: "acc", detail: "", actions: [], observedAt: iso(-1), ...patch });

describe("modelo de Agentes", () => {
  it("cuenta atrás honesta: plazo desconocido nunca se inventa", () => {
    const c = countdown(req(), now);
    expect(c).toMatchObject({ known: true, minutes: 29, expired: false });
    expect(c.fraction).toBeCloseTo(29 / 30);
    expect(deadlineText(c)).toBe("vence en 29 min");
    expect(deadlineText(countdown(req({ expiresAt: iso(-1) }), now))).toBe("plazo cumplido");
    expect(deadlineText(countdown(req({ expiresAt: "nope" }), now))).toBe("plazo sin comprobar");
    expect(deadlineText(countdown(req({ expiresAt: iso(185) }), now))).toBe("vence en 3 h 5 min");
  });
  it("colecciones y equipos sin duplicados, más reciente primero", () => {
    expect(knownCollections([req(), req({ id: "b" }), req({ environment: null })]).map(c => c.environment)).toEqual([null, "dev"]);
    const grant: SecretGrant = { id: "g", agent: "hermes", machine: "EC2", project: "p", environment: null, name: "K", scope: "machine_project", createdAt: iso(-60) };
    const machines = tokenMachines([req(), req({ id: "c", agent: "codex", state: "delivered" })], [grant]);
    expect(machines.map(m => m.machine)).toEqual(["Mac", "EC2"]);
    expect(machines[0]).toMatchObject({ agents: ["claude", "codex"], pending: 1 });
  });
  it("los chips del historial usan totales del servidor y los ocultan al buscar", () => {
    const counts = { pending: 1, delivered: 3, denied: 0, approved: 0, expired: 0, failed: 0 };
    expect(historyChips(counts, "", false).map(c => [c.key, c.count])).toEqual([["", 4], ["pending", 1], ["delivered", 3]]);
    expect(historyChips(counts, "denied", false).some(c => c.key === "denied")).toBe(true);
    expect(historyChips(counts, "", true).every(c => c.count === undefined)).toBe(true);
    expect(historyChips(null, "", false).every(c => c.count === undefined)).toBe(true);
  });
  it("valida el valor pegado y la confirmación de producción", () => {
    expect(validPastedValue("abc")).toBe(true);
    expect(validPastedValue("a\nb")).toBe(false);
    expect(validPastedValue("x".repeat(8193))).toBe(false);
    expect(needsProductionConfirm("prod", "always")).toBe(true);
    expect(needsProductionConfirm("prod", "once")).toBe(false);
    expect(needsProductionConfirm("dev", "machine_project")).toBe(false);
  });
});

describe("modelo de Estado del sistema", () => {
  it("una fila por proveedor · cuenta aunque cambie el catálogo, y sin datos no es sano", () => {
    const rows = inventorySources([
      res({ id: "a", account: "agents", catalog: { catalogId: "1", provider: "aws", accountId: "123", region: "us-east-1", resourceType: "ec2", providerId: "i", lifecycle: "active" } }),
      res({ id: "b", account: "agents" }),
      res({ id: "c", account: "lab", observedAt: null }),
      res({ id: "d", kind: "service", account: "Coolify", location: "VPS · vps-provider" }),
      res({ id: "e", kind: "computer", account: "Casa" }),
    ], now);
    expect(rows.map(r => r.title)).toEqual(["AWS · agents", "AWS · lab", "Coolify · VPS · vps-provider"]);
    expect(rows[0]).toMatchObject({ sub: "us-east-1 · 2 recursos", tone: "ok", every: "cada 15 min" });
    expect(rows[1]).toMatchObject({ tone: "unc", status: "sin datos", lastAt: null });
    expect(rows[2]).toMatchObject({ sub: "1 recurso", every: "cada 2 min" });
  });
  it("una fuente con fallo o lectura antigua no sale sana", () => {
    expect(inventorySources([res({ coverage: { state: "failed", observedAt: null, freshUntil: null } })], now)[0]!.tone).toBe("bad");
    expect(inventorySources([res({ observedAt: iso(-45) })], now)[0]!.status).toBe("antigua");
  });
  it("solo acepta bloques extra bien formados", () => {
    expect(healthExtras({ push: { enabled: true, subscriptions: 2, pending: 0, dead: 0 } }).push).toEqual({ enabled: true, subscriptions: 2, pending: 0, dead: 0 });
    expect(healthExtras({ push: { enabled: true, subscriptions: -1, pending: 0, dead: 0 }, costCache: { configuredAccounts: "3" } })).toEqual({});
    expect(healthExtras(null)).toEqual({});
  });
});
