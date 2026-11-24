import { describe, it, expect } from "vitest";
import type { SecretRequest } from "../ui/src/contract.ts";
import { destinationLabel, eventLabel, pendingCount, projectLabel, sortRequests } from "../ui/src/lib/secrets.ts";
import { createFixtureProvider } from "../integration/fixtureProvider.ts";

const base: SecretRequest = {
  id: "a", agent: "claude-mac", machine: "mac", name: "K", project: "p", environment: "dev", destination: { kind: "dotenv", path: ".env" },
  reason: "x", state: "pending", scope: null, createdAt: "2026-11-11T10:00:00Z", expiresAt: "2026-11-11T10:30:00Z", decidedAt: null, deliveredAt: null, auto: false,
};

describe("credenciales de agentes (UI)", () => {
  it("ordena pendientes primero y luego lo más reciente", () => {
    const rows = [
      { ...base, id: "old-done", state: "delivered" as const, createdAt: "2026-11-11T09:00:00Z" },
      { ...base, id: "new-done", state: "denied" as const, createdAt: "2026-11-11T11:00:00Z" },
      { ...base, id: "pend", createdAt: "2026-11-11T08:00:00Z" },
    ];
    expect(sortRequests(rows).map((r) => r.id)).toEqual(["pend", "new-done", "old-done"]);
    expect(pendingCount(rows)).toBe(1);
    expect(pendingCount(undefined)).toBe(0);
  });
  it("etiquetas en español y un evento desconocido nunca se muestra crudo", () => {
    expect(destinationLabel({ kind: "dotenv", path: ".env.local" })).toBe("Archivo .env.local");
    expect(destinationLabel({ kind: "process" })).toBe("Variable de entorno de un proceso");
    expect(projectLabel(base)).toBe("p · dev");
    expect(projectLabel({ project: "p", environment: null })).toBe("p");
    expect(eventLabel("auto_approved")).toBe("Aprobada por un permiso permanente");
    expect(eventLabel("raro_x")).toBe("Evento sin descripción");
  });
  it("la fixture aprueba con permiso permanente, lo revoca y audita sin valores", async () => {
    const provider = createFixtureProvider({ latencyMs: 0 });
    const secret = "FAKE_ONLY_" + "ab".repeat(16);
    const approved = await provider.approveSecret("sec_pending1", { mode: "paste", value: secret }, "machine_project");
    expect(approved.state).toBe("approved");
    expect(JSON.stringify(approved)).not.toContain(secret);
    const { grants } = await provider.getSecretGrants();
    expect(grants).toHaveLength(1);
    expect((await provider.revokeSecretGrant(grants[0]!.id)).revoked).toBe(true);
    expect(JSON.stringify(await provider.getSecretAudit())).not.toContain(secret);
    await expect(provider.approveSecret("sec_pending1", { mode: "paste", value: "x" }, "once")).rejects.toMatchObject({ status: 409 });
  });
  it("la fixture rechaza un valor vacío", async () => {
    const provider = createFixtureProvider({ latencyMs: 0 });
    await expect(provider.approveSecret("sec_pending1", { mode: "paste", value: "  " }, "once")).rejects.toMatchObject({ status: 400 });
  });
});
