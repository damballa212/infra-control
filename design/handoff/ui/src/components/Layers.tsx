import type { CSSProperties } from "react";
import {
  spriteKeys,
  type SpriteKey,
  type SpriteLayers,
} from "../sprites/generator.ts";

const TOKEN_FILL: Readonly<Record<SpriteKey, string>> = {
  K: "var(--color-sprite-k)",
  N: "var(--color-sprite-n)",
  V: "var(--color-sprite-v)",
  R: "var(--color-sprite-r)",
  O: "var(--color-sprite-o)",
  Y: "var(--color-sprite-y)",
  W: "var(--color-sprite-w)",
  P: "var(--color-sprite-p)",
  B: "var(--color-sprite-b)",
  M: "var(--color-sprite-m)",
  C: "var(--color-sprite-c)",
  S: "var(--color-sprite-s)",
};

export type Palette = Partial<Record<SpriteKey, string>>;

/** Variante sobre fondo oscuro: el azul noche sustituye al azul crepúsculo para mantener el contraste del cuerpo. */
export const ON_NIGHT_PALETTE: Palette = { N: "var(--color-brand-night)" };

export function fillFor(key: SpriteKey, palette?: Palette): string {
  return palette?.[key] ?? TOKEN_FILL[key];
}

export interface LayersProps {
  layers: SpriteLayers;
  palette?: Palette;
  /** Clase por capa de color (p. ej. { R: 'h-ball' } para animar solo esa capa). */
  layerClass?: Partial<Record<SpriteKey, string>>;
}

export function Layers({ layers, palette, layerClass }: LayersProps) {
  return (
    <>
      {spriteKeys().map((key) =>
        layers[key] === "" ? null : (
          <path
            key={key}
            d={layers[key]}
            className={layerClass?.[key]}
            style={{ fill: fillFor(key, palette) }}
          />
        ),
      )}
    </>
  );
}

export interface PathProps {
  d: string;
  fill: string;
  className?: string;
  style?: CSSProperties;
}

export function PixelPath({ d, fill, className, style }: PathProps) {
  return <path d={d} className={className} style={{ fill, ...style }} />;
}
