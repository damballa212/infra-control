import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { initialPageState, nextPageState, pageFilterIdentity, pageRequestIdentity, pageStateFor, previousPageState } from '../ui/src/lib/pageState.ts';
import { PageNavigation } from '../ui/src/components/PageNavigation.tsx';

describe('estado usado por usePagedRead', () => {
  it('usa 20 por defecto, limita tamaño y normaliza el orden de propiedades', () => {
    expect(pageFilterIdentity('orders', { q: ' test ', actor: 'a' })).toBe(pageFilterIdentity('orders', { actor: 'a', q: 'test' }, 20));
    expect(() => pageFilterIdentity('orders', {}, 0)).toThrow(RangeError);
    expect(() => pageFilterIdentity('orders', {}, 101)).toThrow(RangeError);
  });
  it('conserva cursores opacos al avanzar/volver y no inventa una página final', () => {
    let state = initialPageState('orders');
    state = nextPageState(state, { hasMore: true, nextCursor: 'opaque-A' }, pageRequestIdentity(state));
    expect(state.index).toBe(1); expect(state.cursors).toEqual([undefined, 'opaque-A']);
    state = nextPageState(state, { hasMore: true, nextCursor: 'opaque-B' }, pageRequestIdentity(state));
    state = previousPageState(state, pageRequestIdentity(state));
    expect(state.index).toBe(1); expect(state.cursors[state.index]).toBe('opaque-A');
    const same = nextPageState(state, { hasMore: false, nextCursor: null }, pageRequestIdentity(state)); expect(same).toBe(state);
    const restarted = initialPageState(state.identity, state.revision + 1); expect(restarted.index).toBe(0); expect(restarted.cursors).toEqual([undefined]);
  });
  it('un resultado tardío no puede avanzar otro filtro ni sobrevivir a A→B→A', async () => {
    let state = initialPageState('A'); const ticket = pageRequestIdentity(state);
    let finish!: (page: { hasMore: boolean; nextCursor: string }) => void;
    const pending = new Promise<{ hasMore: boolean; nextCursor: string }>(resolve => { finish = resolve; });
    const completion = pending.then(page => { state = nextPageState(state, page, ticket); });
    state = pageStateFor(state, 'B'); state = pageStateFor(state, 'A');
    const current = pageRequestIdentity(state); expect(current).not.toBe(ticket);
    finish({ hasMore: true, nextCursor: 'old-filter-cursor' }); await completion;
    expect(pageRequestIdentity(state)).toBe(current); expect(state.index).toBe(0); expect(state.cursors).toEqual([undefined]);
  });
  it('reset durante una lectura y doble clic invalidan la identidad previa', () => {
    let state = initialPageState('orders'); const first = pageRequestIdentity(state);
    state = nextPageState(state, { hasMore: true, nextCursor: 'next' }, first);
    const once = state;
    state = nextPageState(state, { hasMore: true, nextCursor: 'next' }, first); expect(state).toBe(once);
    const second = pageRequestIdentity(state);
    state = initialPageState(state.identity, state.revision + 1);
    expect(pageRequestIdentity(state)).not.toBe(first);
    expect(previousPageState(state, second)).toBe(state);
    expect(nextPageState(state, { hasMore: true, nextCursor: 'stale' }, second)).toBe(state);
  });
  it('no acepta cursores repetidos que producirían un bucle', () => {
    let state = initialPageState('orders');
    state = nextPageState(state, { hasMore: true, nextCursor: 'same' }, pageRequestIdentity(state));
    expect(nextPageState(state, { hasMore: true, nextCursor: 'same' }, pageRequestIdentity(state))).toBe(state);
  });
});
describe('navegación accesible sin total inventado', () => {
  it('usa nav semántico, botones táctiles y bloquea navegación offline o durante Retry-After', () => {
    const base = { pageNumber: 2, canNext: true, canPrevious: true, loading: false, online: false, visible: true, retryAt: 0, now: 100, next() {}, previous() {}, reset() {} };
    const offline = renderToStaticMarkup(createElement(PageNavigation, { paging: base }));
    expect(offline).toContain('aria-label="Páginas de resultados"'); expect(offline).toContain('min-height:48px'); expect(offline).toContain('role="status"');
    expect((offline.match(/disabled=""/g) ?? []).length).toBe(3); expect(offline).toContain('Anterior'); expect(offline).toContain('Siguiente'); expect(offline).toContain('Página 2'); expect(offline).not.toMatch(/Página \d+\s+de\s+\d+/);
    const waiting = renderToStaticMarkup(createElement(PageNavigation, { paging: { ...base, online: true, retryAt: 101 } }));
    expect((waiting.match(/disabled=""/g) ?? []).length).toBe(3);
    const ready = renderToStaticMarkup(createElement(PageNavigation, { paging: { ...base, online: true } })); expect(ready).not.toContain('disabled=""');
  });
});
