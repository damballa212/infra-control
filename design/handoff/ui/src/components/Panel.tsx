import type { ReactNode } from "react";

export type PanelTone = "paper" | "night" | "sun";
export type PanelAccent = "violet" | "coral" | "orange" | "none";

export interface PanelProps {
  tone: PanelTone;
  accent?: PanelAccent;
  as?: "section" | "div" | "article" | "aside";
  className?: string;
  flush?: boolean;
  /** `id` del encabezado que nombra la región. */
  labelledBy?: string;
  ariaLabel?: string;
  role?: "status" | "alert";
  children: ReactNode;
}

export function Panel({
  tone,
  accent = "none",
  as: Tag = "section",
  className,
  flush = false,
  labelledBy,
  ariaLabel,
  role,
  children,
}: PanelProps) {
  const classes = [
    "panel",
    `panel--${tone}`,
    accent === "none" ? "" : `panel--${accent}`,
    flush ? "panel--flush" : "",
    tone === "night" ? "on-night" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag
      className={classes}
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      role={role}
    >
      {children}
    </Tag>
  );
}
