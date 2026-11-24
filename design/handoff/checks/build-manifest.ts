import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const files = walk("dist").map((path) => ({
  path,
  bytes: readFileSync(path).length,
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
}));
writeFileSync(
  "build-manifest.json",
  JSON.stringify(
    { version: "0.1.0", dataMode: process.env.VITE_DATA_MODE ?? "http", files },
    null,
    2,
  ) + "\n",
);
console.log(`Manifest: ${files.length} archivos de build.`);
