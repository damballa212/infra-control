import { GLYPH_SIZE, GLYPH_BITMAPS } from "../ui/src/sprites/glyphs.ts";
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tokens } from "../tokens/tokens.ts";
import {
  isValidIdempotencyKey,
  newIdempotencyKey,
} from "../ui/src/lib/idempotency.ts";
import { parseRoute, pathFor } from "../ui/src/lib/router.tsx";
it("tokens generados siguen iguales a su fuente", () => {
  expect(
    execFileSync(process.execPath, ["checks/build-tokens.ts", "--check"], {
      encoding: "utf8",
    }),
  ).toContain("Tokens al día");
});
it("breakpoints y áreas táctiles mantienen el contrato de diseño", () => {
  const css = readFileSync("ui/src/styles/layout.css", "utf8");
  expect(css).toContain(
    `min-width: ${Number(tokens.breakpoint.compact) + 1}px`,
  );
  expect(css).toContain(`min-width: ${Number(tokens.breakpoint.medium) + 1}px`);
  expect(parseFloat(tokens.size.hitbox)).toBeGreaterThanOrEqual(48);
});
it("IDs opacos sobreviven al viaje URL sin convertirlos en comandos", () => {
  const route = { name: "resource" as const, id: "aws:opaque/one?two#three" };
  expect(parseRoute(pathFor(route))).toEqual(route);
});
it("el filtro de problemas del inventario viaja en la URL para que Hoy abra la lista filtrada", () => {
  for (const view of ["services", "devices", "map"] as const) {
    const route = { name: "inventory" as const, view, problems: true };
    expect(parseRoute(pathFor(route))).toEqual(route);
    expect(parseRoute(pathFor({ name: "inventory", view }))).toEqual({ name: "inventory", view });
  }
  expect(pathFor({ name: "inventory", view: "devices", problems: true })).toBe("/inventario/equipos/problemas");
  expect(parseRoute("/inventario/equipos/problemas/x")).toEqual({ name: "notFound" });
});
it("las rutas del piloto de credenciales retirado llevan a Agentes", () => {
  expect(parseRoute("/ajustes/credenciales")).toEqual({ name: "agents" });
  expect(parseRoute("/ajustes/credenciales/abc")).toEqual({ name: "agents" });
});
it("los enlaces de infra-secrets y de los avisos siguen abriendo la petición", () => {
  expect(parseRoute("/secretos/req_1")).toEqual({ name: "secretRequest", id: "req_1" });
  expect(parseRoute("/secretos")).toEqual({ name: "agents" });
  expect(pathFor({ name: "secretRequest", id: "req_1" })).toBe("/secretos/req_1");
});
it("las rutas viejas de Buscar y Ajustes llegan a su rama nueva", () => {
  expect(parseRoute("/buscar")).toEqual({ name: "inventory", view: "devices" });
  expect(parseRoute("/ajustes")).toEqual({ name: "me", tab: "settings" });
  expect(parseRoute("/ajustes/contrasena")).toEqual({ name: "password" });
  for (const route of [
    { name: "inventory", view: "services" },
    { name: "inventory", view: "map" },
    { name: "me", tab: "devices" },
    { name: "me", tab: "system" },
    { name: "agents" },
  ] as const)
    expect(parseRoute(pathFor(route))).toEqual(route);
});
it("claves son únicas y cumplen el formato del backend", () => {
  const keys = Array.from({ length: 100 }, () => newIdempotencyKey());
  expect(new Set(keys).size).toBe(100);
  expect(keys.every(isValidIdempotencyKey)).toBe(true);
  expect(isValidIdempotencyKey("key with spaces")).toBe(false);
});

it("los símbolos conservan nueve filas y nueve píxeles por fila", () => {
  expect(GLYPH_SIZE).toBe(9);
  for (const rows of Object.values(GLYPH_BITMAPS)) {
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.length === 9 && /^[.#]+$/.test(row))).toBe(
      true,
    );
  }
});
