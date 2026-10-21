import type { GlyphName } from "../lib/status.ts";
import { GLYPH_BITMAPS, GLYPH_SIZE } from "../sprites/glyphs.ts";
import { bitmapPath } from "../sprites/generator.ts";

const PATHS = new Map<GlyphName, string>();

function pathFor(name: GlyphName): string {
  const cached = PATHS.get(name);
  if (cached !== undefined) return cached;
  const path = bitmapPath(GLYPH_BITMAPS[name]);
  PATHS.set(name, path);
  return path;
}

export interface GlyphProps {
  name: GlyphName;
  large?: boolean;
  spin?: boolean;
  className?: string;
}

/** Símbolo pixel decorativo (aria-hidden): el estado SIEMPRE se comunica también con texto. */
export function Glyph({
  name,
  large = false,
  spin = false,
  className,
}: GlyphProps) {
  const classes = [
    "glyph",
    large ? "glyph--lg" : "",
    spin ? "glyph--spin" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={pathFor(name)} fill="currentColor" />
    </svg>
  );
}
