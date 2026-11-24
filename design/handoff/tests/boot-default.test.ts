import { describe, expect, it } from "vitest";
import type { BootPreference } from "../ui/src/contract.ts";
import { bootRowView, readBootPreference } from "../ui/src/lib/bootDefault.ts";

const base: BootPreference = {
  desired: "cachyos",
  effective: "cachyos",
  state: "applied",
  version: 3,
};

describe("readBootPreference", () => {
  it("rechaza respuestas sin la forma del contrato", () => {
    expect(readBootPreference({})).toBeNull();
    expect(readBootPreference(null)).toBeNull();
    expect(readBootPreference({ state: "applied" })).toBeNull();
  });

  it("acepta una preferencia con estado y versión", () => {
    expect(readBootPreference(base)).toEqual(base);
  });
});

describe("bootRowView", () => {
  it("no muestra nada mientras no hay preferencia", () => {
    expect(bootRowView(null, "windows")).toBeNull();
  });

  it("sin acción cuando el sistema marcado ya es el predeterminado", () => {
    const view = bootRowView(base, "cachyos");
    expect(view?.text).toBe("★ CachyOS arranca solo.");
    expect(view?.action).toBeNull();
  });

  it("ofrece hacer predeterminado el otro sistema, nombrando el actual", () => {
    const view = bootRowView(base, "windows");
    expect(view?.text).toBe("★ Predeterminado: CachyOS.");
    expect(view?.action).toEqual({ kind: "set", system: "windows", label: "Hacer predeterminado" });
  });

  it("no afirma un valor sin verificar: pide comprobar", () => {
    const view = bootRowView({ ...base, effective: null, state: "unknown" }, "windows");
    expect(view?.text).toBe("Predeterminado sin verificar.");
    expect(view?.action?.kind).toBe("verify");
  });

  it("un cambio pendiente se puede cancelar y no ofrece otro", () => {
    const view = bootRowView({ ...base, desired: "windows", state: "pending" }, "windows");
    expect(view?.text).toContain("Pendiente: Windows");
    expect(view?.action?.kind).toBe("cancel");
  });

  it("resultado incierto o con deriva solo permite comprobar, nunca repetir a ciegas", () => {
    for (const state of ["uncertain", "drift"] as const) {
      const view = bootRowView({ ...base, state }, "windows");
      expect(view?.action?.kind).toBe("verify");
    }
  });

  it("mientras se aplica no hay acciones", () => {
    const view = bootRowView({ ...base, state: "applying" }, "windows");
    expect(view?.action).toBeNull();
  });
});
