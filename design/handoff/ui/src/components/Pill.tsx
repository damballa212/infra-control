import type { ReactNode } from "react";
import type { Resource, OperationState } from "../contract.ts";
import {
  describeOperation,
  describeResourceState,
  type GlyphName,
  type Tone,
} from "../lib/status.ts";
import { Glyph } from "./Glyph.tsx";

export interface PillProps {
  tone: Tone;
  glyph: GlyphName;
  children: ReactNode;
  className?: string;
}

/** Píldora de estado: texto + símbolo + color (nunca solo color). */
export function Pill({ tone, glyph, children, className }: PillProps) {
  return (
    <span
      className={["pill", `tone-${tone}`, className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <Glyph name={glyph} spin={tone === "busy" && glyph === "half"} />
      {children}
    </span>
  );
}

export function StatePill({
  resource,
  className,
}: {
  resource: Pick<Resource, "kind" | "state">;
  className?: string;
}) {
  const view = describeResourceState(resource);
  return (
    <Pill tone={view.tone} glyph={view.glyph} className={className}>
      {view.label}
    </Pill>
  );
}

export function OperationPill({
  state,
  className,
}: {
  state: OperationState;
  className?: string;
}) {
  const view = describeOperation(state);
  return (
    <Pill tone={view.tone} glyph={view.glyph} className={className}>
      {view.label}
    </Pill>
  );
}

/** Cuadro con el símbolo del estado (para listas). Decorativo: el texto del estado va al lado. */
export function StateChip({
  resource,
}: {
  resource: Pick<Resource, "kind" | "state">;
}) {
  const view = describeResourceState(resource);
  return (
    <span className={`chip tone-${view.tone}`} aria-hidden="true">
      <Glyph name={view.glyph} spin={view.tone === "busy"} />
    </span>
  );
}

export function Stamp({ children }: { children: ReactNode }) {
  return <span className="pill pill--stamp">{children}</span>;
}
