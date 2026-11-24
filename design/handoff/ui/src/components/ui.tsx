import type { ReactNode } from "react";
import { Link, type Route } from "../lib/router.tsx";
import type { GlyphName, Tone } from "../lib/status.ts";

/** Íconos de trazo (24×24) para navegación y acciones. Decorativos: el texto acompaña siempre. */
export type IconName =
  | "home"
  | "inventory"
  | "activity"
  | "costs"
  | "agents"
  | "map"
  | "search"
  | "key"
  | "power"
  | "settings"
  | "bell"
  | "pulse"
  | "lock"
  | "info"
  | "refresh"
  | "pc";

const ICONS: Readonly<Record<IconName, ReactNode>> = {
  home: <path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z" />,
  inventory: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  costs: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5v11M15 9.3c-.5-.9-1.6-1.5-3-1.5-1.6 0-3 .8-3 2.1s1.4 1.7 3 2.1 3 .8 3 2.1-1.4 2.1-3 2.1c-1.4 0-2.5-.6-3-1.5" />
    </>
  ),
  agents: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="2" />
      <path d="M12 3v4M9.5 12h.01M14.5 12h.01M9.5 15.5h5" />
    </>
  ),
  map: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  power: <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  bell: <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />,
  pulse: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M5.3 5.3l2.1 2.1M2.5 12h3M18.7 5.3l-2.1 2.1M21.5 12h-3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />,
  pc: (
    <>
      <rect x="2" y="4" width="13" height="10" rx="1.5" />
      <path d="M6 18h5M8.5 14v4" />
      <rect x="17" y="3" width="5" height="16" rx="1" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ?? "icon"}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m2 1 4 5-4 5" />
    </svg>
  );
}

/** Tono visual de un estado. «warn» con «?» es una orden sin confirmar (violeta), no un dato viejo (ámbar). */
export type DotTone = "ok" | "bad" | "unc" | "stale" | "busy" | "off" | "unk" | "none" | "key";
export function dotTone(tone: Tone, glyph?: GlyphName): DotTone {
  switch (tone) {
    case "on":
      return "ok";
    case "bad":
      return "bad";
    case "busy":
      return "busy";
    case "off":
      return "off";
    case "warn":
      return glyph === "question" ? "unc" : "stale";
    case "unk":
      return "unk";
    case "none":
      return "none";
  }
}

export function StatusDot({ tone, small = false }: { tone: DotTone; small?: boolean }) {
  return <span className={`dot dot--${tone}${small ? " dot--sm" : ""}`} aria-hidden="true" />;
}

/** Enlace al avatar: en móvil abre Tú; en escritorio se oculta. Las peticiones se cuentan en la pestaña Agentes. */
export function AvatarLink() {
  return (
    <Link to={{ name: "me", tab: "system" }} className="avatar-link avatar-link--mobile" aria-label="Tú: sistema y ajustes">
      <span className="avatar" aria-hidden="true">M</span>
    </Link>
  );
}

export interface PageHeadProps {
  title: string;
  eyebrow?: ReactNode;
  sub?: ReactNode;
  /** Acción a la derecha en escritorio (en móvil se muestra el avatar si es una rama principal). */
  action?: ReactNode;
  /** Muestra el avatar en móvil: solo en las pantallas raíz de cada rama. */
  avatar?: boolean;
  back?: { to: Route | string; label: string };
}

export function PageHead({ title, eyebrow, sub, action, avatar = false, back }: PageHeadProps) {
  return (
    <header className="page-head-wrap">
      {back && (
        <Link to={back.to} className="back">
          <svg className="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          {back.label}
        </Link>
      )}
      <div className="page-head">
        <div className="grow">
          {eyebrow && <p className="page-head__eyebrow">{eyebrow}</p>}
          <h1 className="page__title">{title}</h1>
        </div>
        {action}
        {avatar && <AvatarLink />}
      </div>
      {sub && <div className="page-head__sub">{sub}</div>}
    </header>
  );
}

export interface SectionProps {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  id?: string;
  children: ReactNode;
}

/** Sección con encabezado discreto sobre un grupo. */
export function Section({ title, meta, action, id, children }: SectionProps) {
  const headingId = id ?? `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 className="sec" id={headingId}>
        <span>{title}</span>
        {meta !== undefined && <span className="sec__meta">{meta}</span>}
        {action}
      </h2>
      {children}
    </section>
  );
}
