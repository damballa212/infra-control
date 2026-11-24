import type { ReactNode } from "react";
import { useAppState } from "../app/AppState.tsx";
import { Icon } from "./ui.tsx";
import { Empty, Skeleton } from "./v2.tsx";

/** Piezas pequeñas de Agentes y Tú sobre los primitivos v2. */

/** Anillo de cuenta atrás (fracción restante del plazo). */
export function Ring({ fraction, size = 48 }: { fraction: number; size?: number }) {
  const r = 22; const c = 2 * Math.PI * r; const f = Math.min(1, Math.max(0, fraction));
  return <svg className="ag-ring" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true"><circle cx="24" cy="24" r={r} className="ag-ring__track" /><circle cx="24" cy="24" r={r} className="ag-ring__arc" strokeDasharray={`${(c * f).toFixed(1)} ${c.toFixed(1)}`} /></svg>;
}

/** Tile de llave con el anillo de plazo alrededor (peticiones pendientes). */
export function KeyTile({ fraction }: { fraction?: number }) {
  return <span className="ag-keytile" aria-hidden="true">{fraction !== undefined && <Ring fraction={fraction} />}<Icon name="key" /></span>;
}

/** Única forma de marcar lo que declara el cliente. */
export function Declared() { return <span className="ag-tag">declarado</span>; }
/** El equipo sí se comprueba: por su token. */
export function Verified() { return <span className="ag-tag ag-tag--ok">verificado</span>; }

interface ReadLike { data: unknown; error: unknown; loading: boolean; retryAt: number; refresh: () => void }

/**
 * Estado de una lectura en una línea: esqueleto mientras carga, error con «Volver a consultar» si no hay datos,
 * y aviso breve si se conserva una lectura anterior. Nunca convierte un fallo en lista vacía.
 */
export function ReadGate({ read, label, rows = 2, children }: { read: ReadLike; label: string; rows?: number; children?: ReactNode }) {
  const app = useAppState();
  const wait = app.now < read.retryAt;
  const retry = <button type="button" className="v2-pill ag-retry" disabled={read.loading || wait || !app.online} onClick={read.refresh}>{wait ? "Espera para consultar" : "Volver a consultar"}</button>;
  if (!read.data) {
    if (!app.online) return <Empty title={`Sin conexión: no hay lectura de ${label}.`} />;
    if (read.error) return <Empty tone="error" title={`No pude leer ${label}.`} action={retry} />;
    return <Skeleton rows={rows} label={`Cargando ${label}`} />;
  }
  return <>{read.error ? <p className="ag-stale" role="status"><span>No pude actualizar {label}; ves la lectura anterior.</span>{retry}</p> : null}{children}</>;
}

interface MoreLike { hasMore: boolean; canLoadMore: boolean; loadMore: () => void | Promise<void>; moreLoading: boolean; moreFailed: boolean; moreWait: boolean }

/** El único control de paginación: añade la página siguiente al final de la lista. */
export function LoadMore({ list, label }: { list: MoreLike; label: string }) {
  if (!list.hasMore) return null;
  return <div className="ag-more">
    <button type="button" className="ag-more__btn" disabled={!list.canLoadMore} aria-label={`Cargar más ${label}`} onClick={() => void list.loadMore()}>{list.moreLoading ? "Cargando…" : "Cargar más"}</button>
    {list.moreFailed && <p className="ag-more__note" role="status">{list.moreWait ? "El servidor pidió esperar antes de cargar más." : "No pude cargar más. Vuelve a intentarlo."}</p>}
  </div>;
}
