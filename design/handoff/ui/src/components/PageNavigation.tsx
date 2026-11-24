export interface PageNavigationState {
  pageNumber: number; canNext: boolean; canPrevious: boolean; loading: boolean;
  online: boolean; visible: boolean; retryAt: number; now: number;
  next: () => void; previous: () => void; reset: () => void;
}
export function PageNavigation({ paging, label = 'Páginas de resultados' }: { paging: PageNavigationState; label?: string }) {
  const blocked = paging.loading || !paging.online || !paging.visible || paging.now < paging.retryAt;
  const style = { minHeight: 48, minWidth: 48 };
  return <nav aria-label={label} className="mt-14" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
    <button className="btn" style={style} type="button" disabled={blocked || !paging.canPrevious} onClick={paging.previous}>Anterior</button>
    <span className="t-small" role="status" aria-live="polite">Página {paging.pageNumber}{paging.loading ? ' · leyendo…' : ''}</span>
    <button className="btn" style={style} type="button" disabled={blocked || !paging.canNext} onClick={paging.next}>Siguiente</button>
    {paging.pageNumber > 1 && <button className="btn" style={style} type="button" disabled={blocked} onClick={paging.reset}>Primera página</button>}
  </nav>;
}
