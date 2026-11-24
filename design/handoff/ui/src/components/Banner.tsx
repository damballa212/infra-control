import type { ReactNode } from "react";
import type { GlyphName } from "../lib/status.ts";
import { Glyph } from "./Glyph.tsx";

export type BannerTone = "night" | "warn" | "info" | "bad" | "ok";

export interface BannerProps {
  tone: BannerTone;
  glyph: GlyphName;
  title: string;
  children?: ReactNode;
  /** `alert` solo para errores críticos contextuales; el resto es `status` (educado, sin robar foco). */
  role?: "status" | "alert";
  spin?: boolean;
  action?: ReactNode;
  className?: string;
}

export function Banner({
  tone,
  glyph,
  title,
  children,
  role = "status",
  spin = false,
  action,
  className,
}: BannerProps) {
  return (
    <div
      className={[
        "banner",
        `banner--${tone}`,
        tone === "night" || tone === "bad" ? "on-night" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role={role}
    >
      <Glyph name={glyph} spin={spin} large />
      <div className="banner__body">
        <p className="t-body t-strong">{title}</p>
        {children === undefined ? null : <p className="t-small">{children}</p>}
        {action ?? null}
      </div>
    </div>
  );
}
