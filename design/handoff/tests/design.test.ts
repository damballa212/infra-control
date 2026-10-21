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
