import { useEffect, useRef, useState } from "react";
import type { PageInfo, PageQuery } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { usePagedRead } from "../hooks/usePagedRead.ts";
import { pageFilterIdentity } from "./pageState.ts";
import { mergeRows } from "./activityModel.ts";

/**
 * Lista con «Cargar más»: la primera página es la lectura viva (refresco, pausa, Retry-After y descarte de
 * respuestas de filtros anteriores vía usePagedRead); cada página siguiente se pide con el cursor del servidor
 * y se añade al final. Cambiar de filtro o de sesión descarta las páginas añadidas y cualquier respuesta en vuelo.
 */
export interface FeedOptions { identity: string; onUnauthorized: () => void; enabled?: boolean; pageSize?: number }
interface MoreState<R> { identity: string; pages: R[][]; cursor: string | null; hasMore: boolean; seen: string[]; loading: boolean; error: unknown; retryAt: number }
const emptyMore = <R,>(identity: string): MoreState<R> => ({ identity, pages: [], cursor: null, hasMore: false, seen: [], loading: false, error: null, retryAt: 0 });

export interface FeedMore { can: boolean; loading: boolean; error: unknown; available: boolean; retryAt: number; load: () => void }
export interface Feed<R> { rows: R[]; data: unknown; error: unknown; loading: boolean; retryAt: number; refresh: () => void; online: boolean; visible: boolean; now: number; more: FeedMore }

export function useFeed<P extends PageInfo, R>(load: (query: PageQuery) => Promise<P>, filters: Omit<PageQuery, "cursor">, pick: (page: P) => readonly R[], key: (row: R) => string, options: FeedOptions): Feed<R> & { data: P | null } {
  const limit = options.pageSize ?? 20;
  const first = usePagedRead(load, filters, { identity: options.identity, onUnauthorized: options.onUnauthorized, enabled: options.enabled, pageSize: limit });
  const identity = pageFilterIdentity(options.identity, filters, limit);
  const [stored, setStored] = useState<MoreState<R>>(() => emptyMore(identity));
  const more = stored.identity === identity ? stored : emptyMore<R>(identity);
  if (more !== stored) setStored(more);
  const live = useRef({ identity, alive: true, lock: false });
  live.current.identity = identity;
  useEffect(() => { live.current.alive = true; return () => { live.current.alive = false; }; }, []);
  useEffect(() => { live.current.lock = false; }, [identity]);

  const cursor = more.pages.length ? more.cursor : first.data?.nextCursor ?? null;
  const hasMore = more.pages.length ? more.hasMore : !!first.data?.hasMore;
  const available = hasMore && typeof cursor === "string" && cursor.length > 0 && !more.seen.includes(cursor);
  const can = available && first.data !== null && !more.loading && first.online && first.visible && first.now >= more.retryAt && (options.enabled ?? true);

  const loadMore = () => {
    if (!can || !cursor || live.current.lock) return;
    const started = identity; live.current.lock = true;
    setStored(value => value.identity === started ? { ...value, loading: true, error: null } : value);
    load({ ...filters, q: filters.q?.trim(), limit, cursor }).then(page => {
      if (!live.current.alive || live.current.identity !== started) return;
      const rows = [...pick(page)];
      setStored(value => value.identity !== started ? value : { ...value, pages: [...value.pages, rows], cursor: page.nextCursor, hasMore: page.hasMore && !!page.nextCursor, seen: [...value.seen, cursor], loading: false, error: null });
    }, (error: unknown) => {
      if (!live.current.alive || live.current.identity !== started) return;
      if (error instanceof ProviderError && error.status === 401) { options.onUnauthorized(); return; }
      const wait = error instanceof ProviderError && error.retryAfterSeconds !== null ? Date.now() + error.retryAfterSeconds * 1000 : 0;
      setStored(value => value.identity !== started ? value : { ...value, loading: false, error, retryAt: Math.max(value.retryAt, wait) });
    }).finally(() => { if (live.current.identity === started) live.current.lock = false; });
  };

  const rows = first.data ? mergeRows(pick(first.data), more.pages, key) : [];
  const feedMore: FeedMore = { can, loading: more.loading, error: more.error, available, retryAt: more.retryAt, load: loadMore };
  return { rows, data: first.data, error: first.error, loading: first.loading, retryAt: first.retryAt, refresh: first.refresh, online: first.online, visible: first.visible, now: first.now, more: feedMore };
}
