import { useCallback, useRef, useState } from "react";
import type { PageInfo, PageQuery } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { usePagedRead } from "../hooks/usePagedRead.ts";

interface LoadMoreOptions<P, I> {
  /** Identifica colección y contexto autenticado (además de los filtros). */
  identity: string;
  onUnauthorized: () => void;
  enabled?: boolean;
  pageSize?: number;
  items: (page: P) => readonly I[];
  key: (item: I) => string;
}

interface Extra<I> { identity: string; items: I[]; cursor: string | null; hasMore: boolean }

/**
 * Lista con un único «Cargar más» al final. La primera página es la de `usePagedRead` (se refresca sola);
 * cada «Cargar más» pide la página siguiente con el cursor del servidor y la añade. Cambiar filtros vacía lo añadido.
 * Nunca drena cursores por su cuenta ni calcula totales con las filas cargadas.
 */
export function useLoadMore<P extends PageInfo, I>(load: (query: PageQuery) => Promise<P>, filters: Omit<PageQuery, "cursor">, options: LoadMoreOptions<P, I>) {
  const limit = options.pageSize ?? filters.limit ?? 20;
  const first = usePagedRead(load, filters, { identity: options.identity, onUnauthorized: options.onUnauthorized, enabled: options.enabled, pageSize: limit });
  const identity = JSON.stringify([options.identity, filters, limit]);
  const [extra, setExtra] = useState<Extra<I> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const live = useRef(identity); live.current = identity;
  const lock = useRef(false);

  const own = extra && extra.identity === identity ? extra : null;
  const page = first.data;
  const cursor = own ? own.cursor : page?.nextCursor ?? null;
  const hasMore = own ? own.hasMore : !!page?.hasMore;
  const enabled = options.enabled ?? true;
  const blocked = !enabled || !first.online || !first.visible || first.now < retryAt || busy || !page || !!first.error;
  const canLoadMore = !blocked && hasMore && typeof cursor === "string" && cursor.length > 0;

  const seen = new Set<string>();
  const items: I[] = [];
  for (const item of [...(page ? options.items(page) : []), ...(own?.items ?? [])]) {
    const k = options.key(item); if (seen.has(k)) continue; seen.add(k); items.push(item);
  }

  const loadMore = async () => {
    if (!canLoadMore || lock.current || !cursor) return;
    const ticket = identity; lock.current = true; setBusy(true); setFailed(null);
    try {
      const next = await load({ ...filters, q: filters.q?.trim(), limit, cursor });
      if (live.current !== ticket) return;
      const loaded = options.items(next);
      setExtra(previous => {
        const base = previous && previous.identity === ticket ? previous.items : [];
        return { identity: ticket, items: [...base, ...loaded], cursor: next.nextCursor, hasMore: next.hasMore && !!next.nextCursor && next.nextCursor !== cursor };
      });
    } catch (error) {
      if (live.current !== ticket) return;
      if (error instanceof ProviderError && error.status === 401) { options.onUnauthorized(); return; }
      if (error instanceof ProviderError && error.retryAfterSeconds) setRetryAt(Date.now() + error.retryAfterSeconds * 1000);
      setFailed(ticket);
    } finally { lock.current = false; setBusy(false); }
  };

  const resetPages = first.reset;
  const reset = useCallback(() => { setExtra(null); setFailed(null); resetPages(); }, [resetPages]);

  return {
    data: page, items, error: first.error, loading: first.loading, retryAt: first.retryAt, refresh: first.refresh, reset,
    hasMore, canLoadMore, loadMore, moreLoading: busy, moreFailed: failed === identity, moreWait: first.now < retryAt,
  };
}

export type LoadMoreList = ReturnType<typeof useLoadMore<PageInfo, unknown>>;
