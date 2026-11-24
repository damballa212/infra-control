import { useState } from 'react';
import type { PageInfo, PageQuery } from '../contract.ts';
import { initialPageState, nextPageState, pageFilterIdentity, pageRequestIdentity, pageStateFor, previousPageState } from '../lib/pageState.ts';
import { useRead } from './useRead.ts';
import { useNow, useOnline, usePageVisible } from './usePlatform.ts';

export interface PagedReadOptions {
  /** Debe identificar colección y contexto autenticado, además de los filtros. */
  identity: string;
  onUnauthorized: () => void;
  enabled?: boolean;
  interval?: number | null;
  pageSize?: number;
}
/** Una página por lectura. No acumula filas, no drena cursores y no persiste datos. */
export function usePagedRead<T extends PageInfo>(load: (query: PageQuery) => Promise<T>, filters: Omit<PageQuery, 'cursor'>, options: PagedReadOptions) {
  const limit = options.pageSize ?? filters.limit ?? 20;
  const identity = pageFilterIdentity(options.identity, filters, limit);
  const [navigation, setNavigation] = useState(() => initialPageState(identity));
  const current = pageStateFor(navigation, identity);
  // Ajuste condicionado por identidad: React descarta este render y aplica el reset antes de sus efectos.
  if (current !== navigation) setNavigation(current);
  const requestIdentity = pageRequestIdentity(current);
  const query: PageQuery = { ...filters, q: filters.q?.trim(), limit, cursor: current.cursors[current.index] };
  const enabled = options.enabled ?? true;
  const read = useRead(() => load(query), enabled, options.interval ?? null, options.onUnauthorized, true, { identity: requestIdentity });
  const online = useOnline(), visible = usePageVisible(), now = useNow();
  const blocked = !enabled || read.loading || !online || !visible || now < read.retryAt;
  const canNext = !blocked && !read.error && read.data !== null && read.data.hasMore && typeof read.data.nextCursor === 'string' && read.data.nextCursor.length > 0 && !current.cursors.includes(read.data.nextCursor);
  const canPrevious = !blocked && current.index > 0;
  const next = () => {
    const page = read.data;
    if (!canNext || !page) return;
    setNavigation(value => nextPageState(pageStateFor(value, identity), page, requestIdentity));
  };
  const previous = () => {
    if (canPrevious) setNavigation(value => previousPageState(pageStateFor(value, identity), requestIdentity));
  };
  const reset = () => setNavigation(value => initialPageState(identity, value.revision + 1));
  return { page: read.data, data: read.data, pageNumber: current.index + 1, next, previous, reset, canNext, canPrevious, loading: read.loading, error: read.error, retryAt: read.retryAt, refresh: read.refresh, online, visible, now };
}
