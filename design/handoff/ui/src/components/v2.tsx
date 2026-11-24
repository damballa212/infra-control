import type { ReactNode } from "react";
import { Link, type Route } from "../lib/router.tsx";
import { AvatarLink, Chevron } from "./ui.tsx";

/**
 * Primitivos v2 («Hoy y Login v2»): una sola forma de encabezado, tarjeta, fila, chip y carga para todas
 * las pantallas. Reglas: el estado se ve (tono + símbolo + edad), no se explica; máximo una línea de ayuda.
 */

export type V2Tone = "key" | "bad" | "unc" | "stale" | "busy" | "ok" | "off" | "neutral";

interface ScreenHeadProps {
  /** Línea pequeña superior (mono): contexto o frescura, p. ej. «En vivo · hace 12 s». */
  eyebrow?: ReactNode;
  /** Punto «en vivo» junto al eyebrow. `off` cuando la lectura no es actual. */
  live?: "on" | "off";
  title: ReactNode;
  /** Una sola línea de detalle bajo el título. */
  detail?: ReactNode;
  /** Acción a la derecha (escritorio y móvil). */
  trailing?: ReactNode;
  /** Muestra el avatar de «Tú» en móvil: solo en raíces de pestaña. */
  avatar?: boolean;
  back?: { to: Route | string; label: string };
  /** Nivel del título: h1 por defecto. */
  level?: 1 | 2;
}

export function ScreenHead({ eyebrow, live, title, detail, trailing, avatar = false, back, level = 1 }: ScreenHeadProps) {
  const Title = level === 1 ? "h1" : "h2";
  return <header className="v2-head page-head-wrap">
    {back && <Link to={back.to} className="v2-back"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>{back.label}</Link>}
    <div className="v2-head__row">
      <div className="v2-head__text">
        {eyebrow && <p className="v2-eyebrow">{live && <span className={`v2-live${live === "off" ? " v2-live--off" : ""}`} aria-hidden="true" />}{eyebrow}</p>}
        <Title className="v2-title">{title}</Title>
        {detail && <p className="v2-detail">{detail}</p>}
      </div>
      {trailing}
      {avatar && <AvatarLink />}
    </div>
  </header>;
}

interface CardProps {
  title?: ReactNode;
  /** Conteo o dato breve a la derecha del título. */
  meta?: ReactNode;
  /** Enlace o botón pequeño a la derecha del título (reemplaza a meta en ese lado). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Sin relleno interno: para listas de filas. */
  flush?: boolean;
  id?: string;
  label?: string;
}

export function Card({ title, meta, action, children, className = "", flush = false, id, label }: CardProps) {
  const headingId = id ? `${id}-title` : undefined;
  return <section className={`v2-card${flush ? " v2-card--flush" : ""} ${className}`.trim()} aria-labelledby={title ? headingId : undefined} aria-label={!title ? label : undefined} id={id}>
    {title && <h2 className="v2-card__title" id={headingId}><span>{title}</span>{action ?? (meta !== undefined && <span className="v2-card__meta">{meta}</span>)}</h2>}
    {children}
  </section>;
}

export function IconTile({ tone = "neutral", children }: { tone?: V2Tone; children: ReactNode }) {
  return <span className={`v2-tile v2-tile--${tone}`} aria-hidden="true">{children}</span>;
}

interface RowProps {
  /** Si hay destino, la fila entera es un enlace. */
  to?: Route | string;
  onClick?: () => void;
  /** Icono a la izquierda (usa IconTile) o un punto de estado. */
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** Edad del dato («hace 4 min»), en mono. */
  age?: ReactNode;
  /** Pastilla de acción o estado a la derecha. */
  trailing?: ReactNode;
  chevron?: boolean;
  tone?: V2Tone;
  dataId?: string;
}

/** Fila estándar: entera tocable (≥ 56 px), título de una idea, sub de una línea, edad y chevron. */
export function Row({ to, onClick, lead, title, sub, age, trailing, chevron, tone, dataId }: RowProps) {
  const body = <>
    {lead}
    <span className="v2-row__text"><span className="v2-row__title">{title}</span>{sub && <span className="v2-row__sub">{sub}</span>}</span>
    {age && <span className="t-age v2-row__age">{age}</span>}
    {trailing}
    {(chevron ?? (!!to || !!onClick)) && <span className="v2-row__chev"><Chevron /></span>}
  </>;
  const cls = `v2-row${tone ? ` v2-row--${tone}` : ""}`;
  if (to) return <Link to={to} className={cls} data-id={dataId}>{body}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} data-id={dataId}>{body}</button>;
  return <div className={cls} data-id={dataId}>{body}</div>;
}

export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="v2-rows" aria-label={label}>{children}</ul>;
}

/** Pastilla de acción o estado (no ocupa más que su texto). */
export function Pill({ tone = "neutral", children }: { tone?: V2Tone; children: ReactNode }) {
  return <span className={`v2-pill v2-pill--${tone}`}>{children}</span>;
}

interface ChipProps {
  children: ReactNode;
  /** Enlace (navega) o botón conmutador con aria-pressed. */
  to?: Route | string;
  pressed?: boolean;
  onClick?: () => void;
  /** Punto de estado opcional delante del texto. */
  dot?: V2Tone;
  count?: number;
}

export function Chip({ children, to, pressed, onClick, dot, count }: ChipProps) {
  const inner = <>{dot && <span className={`v2-dot v2-dot--${dot}`} aria-hidden="true" />}{count !== undefined && <b>{count}</b>}{children}</>;
  if (to) return <Link to={to} className="v2-chip">{inner}</Link>;
  return <button type="button" className="v2-chip" aria-pressed={pressed} onClick={onClick}>{inner}</button>;
}

export function Chips({ children, label }: { children: ReactNode; label: string }) {
  return <div className="v2-chips" role="group" aria-label={label}>{children}</div>;
}

interface SegmentedProps<K extends string> {
  label: string;
  value: K;
  items: readonly { key: K; label: ReactNode; to?: Route | string }[];
  onChange?: (key: K) => void;
}

/** Selector de vistas. Con `to` son enlaces (vistas con URL); sin él, botones. */
export function Segmented<K extends string>({ label, value, items, onChange }: SegmentedProps<K>) {
  return <nav className="v2-seg" aria-label={label}>{items.map(item => item.to
    ? <Link key={item.key} to={item.to} className="v2-seg__item" aria-current={item.key === value ? "page" : undefined}>{item.label}</Link>
    : <button key={item.key} type="button" className="v2-seg__item" aria-pressed={item.key === value} onClick={() => onChange?.(item.key)}>{item.label}</button>)}</nav>;
}

export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <label className="v2-search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    <span className="visually-hidden">{label}</span>
    <input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} enterKeyHint="search" autoCapitalize="none" spellCheck={false} />
  </label>;
}

export function Skeleton({ rows = 3, label = "Cargando" }: { rows?: number; label?: string }) {
  return <div className="v2-card v2-card--flush" aria-busy="true" aria-label={label}>{Array.from({ length: rows }, (_, i) => <div key={i} className="v2-sk-row"><span className="v2-sk v2-sk--tile" /><span className="v2-sk-row__lines"><span className="v2-sk v2-sk--l1" /><span className="v2-sk v2-sk--l2" /></span></div>)}</div>;
}

/** Vacío o error de lectura: un título y, como mucho, una acción. */
export function Empty({ title, action, tone }: { title: ReactNode; action?: ReactNode; tone?: "error" }) {
  return <div className={`v2-empty${tone ? " v2-empty--error" : ""}`} role="status"><p>{title}</p>{action}</div>;
}

/** Una línea de ayuda: la única explicación permitida por pantalla o sección. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="v2-hint">{children}</p>;
}

/** Número protagonista (importe, conteo) con etiqueta y una línea. */
export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return <div className="v2-stat"><span className="v2-stat__label">{label}</span><span className="v2-stat__value">{value}</span>{sub && <span className="v2-stat__sub">{sub}</span>}</div>;
}

/** Pares clave-valor compactos dentro de una tarjeta. */
export function Facts({ items }: { items: readonly { label: ReactNode; value: ReactNode; age?: ReactNode }[] }) {
  return <dl className="v2-facts">{items.map((item, i) => <div key={i} className="v2-facts__row"><dt>{item.label}</dt><dd>{item.value}</dd>{item.age !== undefined && <dd className="t-age">{item.age}</dd>}</div>)}</dl>;
}
