// Genera tokens/tokens.css y tokens/tokens.ts desde tokens/tokens.json (única fuente de verdad).
// Uso: node checks/build-tokens.ts [--check]   (--check falla si lo generado difiere de lo commiteado)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TokenValue = string | number | { [key: string]: TokenValue };
type TokenTree = { [key: string]: TokenValue };

const here = dirname(fileURLToPath(import.meta.url));
const tokensDir = resolve(here, "..", "tokens");
const source: TokenTree = JSON.parse(
  readFileSync(resolve(tokensDir, "tokens.json"), "utf8"),
) as TokenTree;

const REFERENCE = /\{([A-Za-z0-9_.]+)\}/g;

function lookup(path: string): TokenValue {
  let node: TokenValue = source;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || !(key in node))
      throw new Error(`Referencia inexistente: {${path}}`);
    node = node[key] as TokenValue;
  }
  return node;
}

function resolveValue(value: string, trail: readonly string[] = []): string {
  return value.replace(REFERENCE, (_match, path: string) => {
    if (trail.includes(path))
      throw new Error(`Referencia circular: ${[...trail, path].join(" -> ")}`);
    const target = lookup(path);
    if (typeof target !== "string")
      throw new Error(`{${path}} no es un valor simple`);
    return resolveValue(target, [...trail, path]);
  });
}

type Flat = { name: string; path: string; value: string };

function flatten(tree: TokenTree, prefix: readonly string[] = []): Flat[] {
  const out: Flat[] = [];
  for (const [key, raw] of Object.entries(tree)) {
    if (key.startsWith("$")) continue;
    const path = [...prefix, key];
    if (typeof raw === "object" && raw !== null) {
      out.push(...flatten(raw, path));
    } else {
      const text = typeof raw === "number" ? String(raw) : raw;
      out.push({
        name: path
          .join("-")
          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
          .toLowerCase(),
        path: path.join("."),
        value: resolveValue(text),
      });
    }
  }
  return out;
}

const flat = flatten(source);
const cssTokens = flat.filter((token) => !token.path.startsWith("breakpoint."));

const css = [
  "/* GENERADO por `npm run tokens` desde tokens.json. No editar a mano. */",
  ":root {",
  ...cssTokens.map((token) => `  --${token.name}: ${token.value};`),
  "}",
  "",
].join("\n");

function toTree(tree: TokenTree): TokenTree {
  const out: TokenTree = {};
  for (const [key, raw] of Object.entries(tree)) {
    if (key.startsWith("$")) continue;
    out[key] =
      typeof raw === "object" && raw !== null
        ? toTree(raw)
        : typeof raw === "number"
          ? raw
          : resolveValue(raw);
  }
  return out;
}

const ts = [
  "// GENERADO por `npm run tokens` desde tokens.json. No editar a mano.",
  `export const tokens = ${JSON.stringify(toTree(source), null, 2)} as const;`,
  "",
  "export type Tokens = typeof tokens;",
  "",
].join("\n");

const outputs: Array<[string, string]> = [
  [resolve(tokensDir, "tokens.css"), css],
  [resolve(tokensDir, "tokens.ts"), ts],
];

if (process.argv.includes("--check")) {
  const stale = outputs.filter(
    ([file, text]) => !existsSync(file) || readFileSync(file, "utf8") !== text,
  );
  if (stale.length > 0) {
    console.error(
      `Tokens desactualizados: ${stale.map(([file]) => file).join(", ")}. Ejecuta npm run tokens.`,
    );
    process.exit(1);
  }
  console.log("Tokens al día.");
} else {
  for (const [file, text] of outputs) writeFileSync(file, text);
  console.log(`Tokens generados: ${cssTokens.length} variables CSS.`);
}
