import type { ReactNode } from "react";
import { useAppState } from "../app/AppState.tsx";
import { dateTime } from "../lib/controlModel.ts";
import type { DayGroup } from "../lib/activityModel.ts";
import type { FeedMore } from "../lib/activityFeed.ts";
import { Empty, IconTile, Rows, Skeleton, type V2Tone } from "./v2.tsx";

/** Piezas de Actividad: tiles por estado, etiqueta de resultado, avisos de lectura, grupos por día y «Cargar más». */

export type ActGlyphName = "check" | "cross" | "question" | "busy" | "bang" | "key" | "dot" | "power" | "refresh";

export function ActGlyph({ name }: { name: ActGlyphName }) {
  if (name === "question") return <span className="act-glyph-q">?</span>;
  if (name === "busy") return <span className="act-spinner" />;
  const paths: Record<Exclude<ActGlyphName, "question" | "busy">, ReactNode> = {
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    cross: <path d="M7 7l10 10M17 7 7 17" />,
    bang: <><path d="M12 6v8" /><path d="M12 18h.01" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2" /></>,
    dot: <circle cx="12" cy="12" r="3" />,
    power: <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />,
    refresh: <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const TONE_GLYPH: Record<V2Tone, ActGlyphName> = { ok: "check", bad: "cross", unc: "question", busy: "busy", stale: "bang", key: "key", off: "dot", neutral: "dot" };
export function StateTile({ tone, glyph }: { tone: V2Tone; glyph?: ActGlyphName }) {
  return <IconTile tone={tone}><ActGlyph name={glyph ?? TONE_GLYPH[tone]} /></IconTile>;
}

/** Resultado a la derecha de una fila: etiqueta en su tono y, debajo, la edad. */
export function ResultTag({ tone, label, age }: { tone: V2Tone; label: ReactNode; age?: ReactNode }) {
  return <span className="act-result"><span className={`act-tag act-tag--${tone}`}>{label}</span>{age && <span className="t-age">{age}</span>}</span>;
}

interface ReadLike { data: unknown; error: unknown; loading: boolean; retryAt: number; refresh: () => void }

/** Estado de una lectura: carga con skeleton, error con reintento (respeta Retry-After) o lectura anterior. */
export function ReadState({ read, what, rows = 4 }: { read: ReadLike; what: string; rows?: number }) {
  const app = useAppState();
  const waiting = app.now < read.retryAt;
  const retry = <button type="button" className="btn btn--sm" disabled={read.loading || waiting || !app.online} onClick={read.refresh}>{waiting ? `Espera hasta ${dateTime(new Date(read.retryAt).toISOString(), app.now)}` : "Volver a consultar"}</button>;
  if (read.error && !read.data) return <div className="v2-card"><Empty tone="error" title={`No pude leer ${what}.`} action={retry} /></div>;
  if (read.error) return <p className="act-stale" role="status"><span className="v2-dot v2-dot--stale" aria-hidden="true" />No pude actualizar {what}; ves la lectura anterior.{retry}</p>;
  if (!read.data) return app.online ? <Skeleton rows={rows} label={`Cargando ${what}`} /> : <div className="v2-card"><Empty title={`Sin conexión: no hay una lectura de ${what}.`} /></div>;
  return null;
}

/** Lista agrupada por día: un encabezado por día y una tarjeta de filas debajo. */
export function DayList<T>({ groups, label, render, rowKey }: { groups: DayGroup<T>[]; label: string; render: (row: T) => ReactNode; rowKey: (row: T) => string }) {
  return <div className="act-days">{groups.map(group => <section key={group.key} className="act-day" aria-label={`${label} · ${group.label}`}>
    <h2 className="act-day__head"><span>{group.label}</span>{group.meta && <span className="act-day__meta">{group.meta}</span>}</h2>
    <div className="v2-card v2-card--flush"><Rows label={`${label} · ${group.label}`}>{group.rows.map(row => <li key={rowKey(row)}>{render(row)}</li>)}</Rows></div>
  </section>)}</div>;
}

/** Un único botón al final: añade la página siguiente con el cursor del servidor. */
export function LoadMore({ more, what }: { more: FeedMore; what: string }) {
  const app = useAppState();
  if (!more.available && !more.error) return null;
  const waiting = app.now < more.retryAt;
  return <div className="act-more-load">
    <button type="button" className="btn btn--block act-load" disabled={!more.can || waiting} aria-busy={more.loading} onClick={more.load}>{more.loading ? "Cargando…" : "Cargar más"}</button>
    {!!more.error && <p className="act-reason" role="status">{waiting ? `El servidor pidió esperar hasta ${dateTime(new Date(more.retryAt).toISOString(), app.now)}.` : `No pude cargar más ${what}. Vuelve a intentarlo.`}</p>}
  </div>;
}
