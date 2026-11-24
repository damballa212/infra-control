import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it("la exclusión persiste tras recargar y solo la activación explícita la retira", async () => {
  vi.resetModules();
  const first = await import("../ui/src/lib/pushIntent.ts");
  first.setPushDisabled(true);
  vi.resetModules();
  const reloaded = await import("../ui/src/lib/pushIntent.ts");
  expect(reloaded.pushDisabled()).toBe(true);
  expect(Object.values(localStorage)).toEqual(["1"]);
  reloaded.setPushDisabled(false);
  expect(reloaded.pushDisabled()).toBe(false);
});
it("sin almacenamiento no registra automáticamente al recargar", async () => {
  vi.resetModules();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  const { pushDisabled, setPushDisabled } = await import("../ui/src/lib/pushIntent.ts");
  expect(pushDisabled()).toBe(true);
  setPushDisabled(false);
  expect(pushDisabled()).toBe(false);
  setPushDisabled(true);
  expect(pushDisabled()).toBe(true);
});
