import type { ReactElement } from "react";
import type { GlyphName } from "../lib/status.ts";

/** Trazos vectoriales en una cuadrícula de 16×16. Relleno = currentColor; trazo = currentColor. */
const SHAPES: Readonly<Record<GlyphName, ReactElement>> = {
  dot: <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />,
  square: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />,
  half: <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />,
  threeQuarter: <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5A5.5 5.5 0 0 1 5 3.3" />,
  ring: <circle cx="8" cy="8" r="4.5" />,
  question: (
    <>
      <path d="M6 6.2a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4v.4" />
      <circle cx="8" cy="12.2" r=".6" fill="currentColor" stroke="none" />
    </>
  ),
  bang: (
    <>
      <path d="M8 3.5v5.5" />
      <circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  cross: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  ellipsis: (
    <>
      <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  arrowRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  arrowLeft: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  caretDown: <path d="m4 6 4 4 4-4" />,
  bolt: <path d="M12 2.5a6.5 6.5 0 1 1-8 0M8 1v6" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4" />
      <circle cx="8" cy="5" r=".6" fill="currentColor" stroke="none" />
    </>
  ),
};

export interface GlyphProps {
  name: GlyphName;
  large?: boolean;
  spin?: boolean;
  className?: string;
}

/** Símbolo decorativo (aria-hidden): el estado SIEMPRE se comunica también con texto. */
export function Glyph({ name, large = false, spin = false, className }: GlyphProps) {
  const classes = ["glyph", large ? "glyph--lg" : "", spin ? "glyph--spin" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
