import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type Route } from "../lib/router.tsx";
import { Glyph } from "./Glyph.tsx";
import type { GlyphName } from "../lib/status.ts";

export type KeyVariant =
  "sun" | "paper" | "night" | "danger" | "red" | "cream" | "sunOnNight";
export type KeySize = "sm" | "md" | "lg";

const VARIANT_CLASS: Readonly<Record<KeyVariant, string>> = {
  sun: "key--sun",
  paper: "key--paper",
  night: "key--night",
  danger: "key--danger",
  red: "key--red",
  cream: "key--cream",
  sunOnNight: "key--sun-on-night",
};

function keyClass(
  variant: KeyVariant,
  size: KeySize,
  block: boolean,
  extra: string,
): string {
  return [
    "key",
    VARIANT_CLASS[variant],
    size === "lg" ? "key--lg" : size === "sm" ? "key--sm" : "",
    block ? "key--block" : "",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface KeyProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> {
  variant: KeyVariant;
  size?: KeySize;
  block?: boolean;
  /** Muestra el símbolo giratorio y marca la tecla como ocupada (sin cambiar su ancho). */
  loading?: boolean;
  className?: string;
}

export function Key({
  variant,
  size = "md",
  block = false,
  loading = false,
  className,
  children,
  type = "button",
  ...rest
}: KeyProps) {
  return (
    <button
      {...rest}
      type={type}
      className={keyClass(
        variant,
        size,
        block,
        [loading ? "is-loading" : "", className ?? ""]
          .filter(Boolean)
          .join(" "),
      )}
      aria-busy={loading || undefined}
    >
      {loading ? <Glyph name="half" spin /> : null}
      {children}
    </button>
  );
}

export interface LinkKeyProps {
  to: Route | string;
  variant: KeyVariant;
  size?: KeySize;
  block?: boolean;
  className?: string;
  children: ReactNode;
}

export function LinkKey({
  to,
  variant,
  size = "md",
  block = false,
  className,
  children,
}: LinkKeyProps) {
  return (
    <Link to={to} className={keyClass(variant, size, block, className ?? "")}>
      {children}
    </Link>
  );
}

export interface BackKeyProps {
  to: Route | string;
  children: ReactNode;
}

export function BackKey({ to, children }: BackKeyProps) {
  return (
    <Link to={to} className="back">
      <Glyph name="arrowLeft" />
      {children}
    </Link>
  );
}

export interface IconKeyProps {
  to: Route | string;
  label: string;
  glyph: "search" | "settings";
}

const ICON_PATH: Readonly<Record<IconKeyProps["glyph"], string>> = {
  search:
    "M2 0h4v1h-4zM1 1h1v1h-1zM6 1h1v1h-1zM0 2h1v3h-1zM7 2h1v3h-1zM1 5h1v1h-1zM6 5h1v1h-1zM2 6h4v1h-4zM7 7h1v1h-1zM8 8h1v1h-1zM9 9h1v1h-1z",
  settings:
    "M4 0h2v2h-2zM4 8h2v2h-2zM0 4h2v2h-2zM8 4h2v2h-2zM2 2h6v6h-6zM4 4h2v2h-2z",
};

export function IconKey({ to, label, glyph }: IconKeyProps) {
  return (
    <Link to={to} className="icon-key" aria-label={label}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        <path d={ICON_PATH[glyph]} fill="currentColor" fillRule="evenodd" />
      </svg>
    </Link>
  );
}

export type { GlyphName };
