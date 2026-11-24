import type { PageInfo, PageQuery } from '../contract.ts';
export type PageState = { identity: string; revision: number; cursors: (string | undefined)[]; index: number };
export function pageFilterIdentity(identity: string, filters: Omit<PageQuery, 'cursor'>, pageSize = filters.limit ?? 20): string {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('El tamaño de página debe estar entre 1 y 100.');
  return JSON.stringify([identity, pageSize, ...(['q', 'actor', 'state', 'type', 'resourceId', 'view'] as const).map(key => key === 'q' ? filters[key]?.trim() ?? null : filters[key] ?? null)]);
}
export function initialPageState(identity: string, revision = 0): PageState { return { identity, revision, cursors: [undefined], index: 0 }; }
export function pageStateFor(state: PageState, identity: string): PageState { return state.identity === identity ? state : initialPageState(identity, state.revision + 1); }
export function pageRequestIdentity(state: PageState): string { return JSON.stringify([state.identity, state.revision, state.index, state.cursors[state.index] ?? null]); }
export function nextPageState(state: PageState, page: PageInfo, expectedRequest: string): PageState {
  if (pageRequestIdentity(state) !== expectedRequest || !page.hasMore || !page.nextCursor || state.cursors.includes(page.nextCursor)) return state;
  return { ...state, revision: state.revision + 1, cursors: [...state.cursors.slice(0, state.index + 1), page.nextCursor], index: state.index + 1 };
}
export function previousPageState(state: PageState, expectedRequest: string): PageState {
  return pageRequestIdentity(state) !== expectedRequest || state.index === 0 ? state : { ...state, revision: state.revision + 1, index: state.index - 1 };
}
