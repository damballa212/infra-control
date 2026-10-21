import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { appIconSvg } from "./app-icon.ts";

const svg = appIconSvg();
mkdirSync("assets/sprites", { recursive: true });
writeFileSync("assets/sprites/app-icon.svg", svg);
const browser = await chromium.launch();
try {
  for (const [name, size] of [
    ["icon-192", 192],
    ["icon-512", 512],
    ["apple-touch-icon", 180],
    // Nombre versionado: un service worker antiguo sirve apple-touch-icon.png desde su caché y iOS lo copiaría.
    ["apple-touch-icon-v3", 180],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({ path: `ui/public/${name}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("Iconos exportados desde la composición app-icon.ts (yelmo de Hermes).");
