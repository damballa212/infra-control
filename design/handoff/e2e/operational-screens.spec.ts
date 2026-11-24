import { test, expect, type Page } from '@playwright/test';
import type { Operation, OperationalIncident, AttentionSummary, SecretRequest, DetailedResource } from '../ui/src/contract.ts';
test.use({ baseURL: 'http://127.0.0.1:4176' });
const at = () => new Date().toISOString();
const op = (id: string, patch: Partial<Operation> = {}): Operation => ({ id, resourceId: 'old-alias', resourceName: id, action: 'boot-cachyos', actor: 'Admin', state: 'uncertain', message: 'Resultado histórico sin confirmar', createdAt: at(), updatedAt: at(), review: { disposition: 'pending', version: 1, canonicalResourceId: 'catalog:physical', updatedAt: at(), reason: 'execution_not_confirmed', evidence: { kind: 'execution_result' } }, ...patch });
const incident = (id: string, actionable: boolean): OperationalIncident => ({ id, key: `probe:${id}`, component: 'probe', resourceId: id, canonicalResourceId: id, category: 'infrastructure', kind: 'application', source: 'https-probe', status: actionable ? 'open' : 'unknown', actionable, openedAt: at(), updatedAt: at(), openingEventId: 1, lastEventId: 1, version: 1, evidence: { reasonCode: actionable ? 'service_probe_unhealthy' : 'expected_host_transition', observedAt: at() } });
const pending = (id: string): SecretRequest => ({ id, agent: 'declared-worker', machine: 'equipo declarado', name: id, project: 'fixture', environment: null, destination: { kind: 'process' }, reason: 'fixture', state: 'pending', scope: null, createdAt: at(), expiresAt: new Date(Date.now() + 600000).toISOString(), decidedAt: null, deliveredAt: null, auto: false });
type Options = { loseReviewResponse?: boolean; summaryUnavailable?: boolean; conflict?: boolean; agent?: boolean; slow?: Promise<void>; reviewGate?: Promise<void> };
async function api(page: Page, options: Options = {}) {
  const calls: URL[] = [], writes: Array<{ path: string; body: unknown }> = [];
  let current = op('review-target');
  let auditActor = 'audit-owner';
  const resources: DetailedResource[] = [
    { id: 'computer:mac', name: 'Portátil en reposo', kind: 'computer', state: 'asleep', location: 'Casa', account: 'Personal', detail: 'macOS', actions: [], observedAt: new Date(Date.now() - 88 * 3600000).toISOString(), monitoring: { availability: 'on-demand' } },
    { id: 'current-alias', name: 'Host con identidad acreditada', kind: 'ec2', state: 'running', location: 'fixture', account: 'fixture', detail: 'fixture', actions: [], observedAt: at(), catalog: { catalogId: 'physical', provider: 'aws', accountId: 'fixture', region: 'fixture', resourceType: 'ec2-instance', providerId: 'fixture', lifecycle: 'active' } },
  ];
  const activeRows = Array.from({ length: 25 }, (_, index) => op(`active-${index}`, { state: 'running', action: 'start', review: undefined }));
  const reviewRows = Array.from({ length: 31 }, (_, index) => index === 0 ? current : op(`review-${index}`));
  const historyRows = [current, op('slow-result', { resourceName: 'slow-result' }), op('fast-result', { resourceName: 'fast-result' }), ...Array.from({ length: 130 }, (_, index) => op(`history-${index}`, { actor: 'other', action: 'refresh', state: 'succeeded', review: undefined }))];
  const episodes = [...Array.from({ length: 20 }, (_, index) => incident(`observation-${index}`, false)), incident('actionable-later-page', true)];
  const acknowledged = { ...incident('acknowledged-open', true), acknowledgement: { by: 'Admin', at: at(), reportVersion: 1 } };
  const recovered = { ...incident('recovered-episode', false), status: 'resolved' as const, resolvedAt: at(), recoveryEventId: 2 };
  const summary: AttentionSummary = { fetchedAt: at(), counts: { attentionGroups: 7, active: 25, pendingReviews: 31, openIncidents: 2, unknownIncidents: 1, coverageProblems: 0 }, coverage: { scopes: 0, healthy: 0, partial: 0, failed: 0, stale: 0 }, pendingApprovals: 42 };
  const pageOf = <T,>(rows: T[], url: URL, field: string) => {
    const offset = Number(url.searchParams.get('cursor')?.replace('page_', '') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
    return { [field]: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? `page_${offset + limit}` : null, hasMore: offset + limit < rows.length };
  };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname; calls.push(url);
    const send = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/auth/me') return send({ name: options.agent ? 'reader' : 'Admin', agent: options.agent ?? false, scopes: ['read', 'operate'] });
    if (path === '/api/resources') return send({ resources, fetchedAt: at(), refreshSeconds: 60, cursor: 0 });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path === '/api/attention/summary') return options.summaryUnavailable ? send({ error: 'Unavailable' }, 503) : send({ ...summary, fetchedAt: at() });
    if (path === '/api/secrets/requests/pending') return send({ ...pageOf(Array.from({ length: 42 }, (_, index) => pending(`pending-${index}`)), url, 'requests'), pendingCount: 42 });
    if (path === '/api/secrets/requests') return send({ requests: [], pendingCount: 42, nextCursor: null, hasMore: false });
    if (path === '/api/operations/active') return send(pageOf(activeRows, url, 'operations'));
    if (path === '/api/operations/review') return send(pageOf(reviewRows.map(row => row.id === current.id ? current : row).filter(row => row.review?.disposition === 'pending'), url, 'operations'));
    if (path === '/api/incidents/current') return send(pageOf(episodes, url, 'incidents'));
    if (path === '/api/incidents/history') {
      const rows = [acknowledged, recovered].filter(row => (!url.searchParams.get('state') || row.status === url.searchParams.get('state')) && (!url.searchParams.get('type') || row.kind === url.searchParams.get('type')) && (!url.searchParams.get('q') || row.resourceId?.includes(url.searchParams.get('q')!)));
      return send(pageOf(rows, url, 'incidents'));
    }
    if (path.startsWith('/api/incidents/') && path.endsWith('/history')) return send({ events: [acknowledged], nextCursor: null, hasMore: false });
    if (path === '/api/secrets/audit') {
      const rows = Array.from({ length: 45 }, (_, index) => ({ id: 45 - index, at: at(), requestId: null, event: 'created', actor: auditActor })).filter(row => (!url.searchParams.get('actor') || row.actor === url.searchParams.get('actor')) && (!url.searchParams.get('type') || row.event === url.searchParams.get('type')));
      return send(pageOf(rows, url, 'events'));
    }
    if (path === '/api/operations' && req.method() === 'GET') {
      if (url.searchParams.get('q') === 'slow-result' && options.slow) await options.slow;
      const rows = historyRows.map(row => row.id === current.id ? current : row).filter(row => (!url.searchParams.get('q') || row.resourceName.includes(url.searchParams.get('q')!)) && (!url.searchParams.get('actor') || row.actor === url.searchParams.get('actor')) && (!url.searchParams.get('state') || row.state === url.searchParams.get('state')) && (!url.searchParams.get('type') || row.action === url.searchParams.get('type')));
      return send(pageOf(rows, url, 'operations'));
    }
    if (path === '/api/operations/review-target') return send(current);
    if (path === '/api/operations/review-target/history') return send({ events: [{ id: 1, type: 'operation', aggregateId: 'operation:review-target', payload: current, createdAt: current.updatedAt }] });
    if (path === '/api/operations/review-target/review' && req.method() === 'POST') {
      const body = req.postDataJSON() as { expectedVersion: number; reason: string }; writes.push({ path, body });
      if (options.reviewGate) await options.reviewGate;
      if (options.agent) return send({ error: 'Forbidden' }, 403);
      if (options.conflict) { current = { ...current, review: { ...current.review!, disposition: 'superseded', version: 2, reason: 'later_confirmed_new_power_intention', supersededByOperationId: 'later-power' } }; return send({ error: 'Changed' }, 409); }
      expect(body.expectedVersion).toBe(current.review!.version);
      current = { ...current, review: { ...current.review!, disposition: 'reviewed', version: current.review!.version + 1, reason: body.reason, reviewedBy: 'Admin', reviewedAt: at(), evidence: { kind: 'human_review' } } };
      if (options.loseReviewResponse) return route.abort('failed');
      return send(current);
    }
    if (path === '/api/operations/later-power') return send(op('later-power', { action: 'boot-windows', state: 'succeeded', review: undefined }));
    if (path === '/api/operations/later-power/history') return send({ events: [] });
    if (req.method() !== 'GET') writes.push({ path, body: req.postData() });
    return send({ error: 'Not available in this fixture' }, 404);
  });
  return { calls, writes, summary, setAuditActor(value: string) { auditActor = value; }, setCurrent(patch: Partial<Operation>) { current = { ...current, ...patch, updatedAt: at() }; } };
}

test('Hoy usa conteos completos y deriva el resto a sus listas sin paginadores', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); const state = await api(page); await page.goto('/');
  // 42 peticiones pendientes + 7 grupos de atención: el veredicto usa los totales del servidor, no la página recibida.
  await expect(page.getByRole('heading', { level: 2, name: '49 cosas te tocan' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Cobertura/ })).toContainText('sin comprobar');
  await expect(page.getByText('0/0', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /peticiones más/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /asuntos? más en Actividad/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.writes).toHaveLength(0);
});

test('Hoy no convierte un resumen inaccesible en cero o cobertura sana', async ({ page }) => {
  await api(page, { summaryUnavailable: true }); await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'No pude comprobar' })).toBeVisible();
  await expect(page.getByText('Todo en orden', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Cobertura/ })).toContainText('sin comprobar');
});

test('Actividad filtra en servidor, carga más auditoría con cursor y descarta un filtro anterior en vuelo', async ({ page }) => {
  let release!: () => void; const slow = new Promise<void>(resolve => { release = resolve; });
  const state = await api(page, { slow }); await page.goto('/actividad');
  await expect(page.getByRole('button', { name: 'Todo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aplicar filtros' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Siguiente', exact: true })).toHaveCount(0);
  // El buscador se aplica en el servidor al dejar de teclear.
  await page.getByLabel('Buscar en la actividad', { exact: true }).fill('slow-result');
  await expect.poll(() => state.calls.some(url => url.pathname === '/api/operations' && url.searchParams.get('q') === 'slow-result')).toBe(true);
  // Mientras esa respuesta sigue en vuelo, cambian búsqueda, autor, chip de estado y tipo.
  await page.getByLabel('Buscar en la actividad', { exact: true }).fill('fast-result');
  await page.getByRole('button', { name: 'Más filtros' }).click();
  await page.getByLabel('Autor', { exact: true }).fill('Admin');
  await page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: 'Sin confirmar', exact: true }).click();
  await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption('boot-cachyos');
  // El lector es de una sola petición en vuelo: al soltar la lenta, su respuesta se descarta y sale la del filtro nuevo.
  release();
  await expect.poll(() => state.calls.some(url => url.searchParams.get('q') === 'fast-result' && url.searchParams.get('actor') === 'Admin' && url.searchParams.get('state') === 'uncertain' && url.searchParams.get('type') === 'boot-cachyos' && !url.searchParams.has('cursor'))).toBe(true);
  await expect(page.getByRole('link', { name: /Reiniciar en CachyOS fast-result/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Reiniciar en CachyOS slow-result/ })).toHaveCount(0);
  // Claves: autor en «Más filtros», evento como chip; «Cargar más» añade la página siguiente con el cursor del servidor.
  await page.getByRole('button', { name: 'Claves', exact: true }).click();
  if (await page.getByRole('button', { name: 'Más filtros', expanded: false }).count()) await page.getByRole('button', { name: 'Más filtros' }).click();
  await page.getByLabel('Autor', { exact: true }).fill('audit-owner');
  await page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: 'Solicitadas', exact: true }).click();
  await expect.poll(() => state.calls.some(url => url.pathname === '/api/secrets/audit' && url.searchParams.get('actor') === 'audit-owner' && url.searchParams.get('type') === 'created' && !url.searchParams.has('cursor'))).toBe(true);
  const rows = page.locator('[data-id^="audit-"]');
  await expect(rows).toHaveCount(20);
  const more = page.getByRole('button', { name: 'Cargar más', exact: true });
  await expect(more).toBeEnabled();
  await more.focus(); await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(40);
  expect(state.calls.some(url => url.pathname === '/api/secrets/audit' && url.searchParams.get('cursor') === 'page_20' && url.searchParams.get('actor') === 'audit-owner' && url.searchParams.get('type') === 'created')).toBe(true);
  await more.click(); await expect(rows).toHaveCount(45);
  expect(state.calls.some(url => url.pathname === '/api/secrets/audit' && url.searchParams.get('cursor') === 'page_40')).toBe(true);
  await expect(more).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('Incidentes muestra recuperación y reconocimiento sin cerrar un episodio abierto', async ({ page }) => {
  await api(page); await page.goto('/actividad'); await page.getByRole('button', { name: 'Incidentes', exact: true }).click();
  const open = page.locator('[data-incident-id="acknowledged-open"]');
  await expect(open).toContainText('Abierto');
  await expect(open).toContainText('Reconocido por Admin · sigue abierto');
  await expect(open).not.toContainText('Resuelto');
  await expect(page.locator('[data-incident-id="recovered-episode"]')).toContainText('Resuelto');
  await open.getByRole('button', { expanded: false }).click();
  await expect(open.getByRole('button', { expanded: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Versiones del incidente acknowledged-open', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Versiones del incidente acknowledged-open', exact: true })).toContainText('Abierto');
});

test('Revisión humana confirma versión una vez y conserva el resultado incierto y el alias acreditado', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await api(page, { reviewGate: gate }); await page.goto('/actividad/review-target');
  await expect(page.getByRole('link', { name: 'Host con identidad acreditada', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Marcar como revisada', exact: true }).click();
  const dialog = page.getByRole('alertdialog'); await expect(dialog).toContainText('no envía otra orden de energía');
  await dialog.getByLabel('Motivo de revisión').selectOption('accepted_uncertainty');
  await dialog.getByRole('button', { name: 'Confirmar revisión', exact: true }).dblclick();
  await expect.poll(() => state.writes.length).toBe(1); release();
  await expect(page.getByText('Revisión guardada. El resultado histórico se conserva.')).toBeVisible();
  await expect(page.locator('[data-operation-disposition="reviewed"]')).toBeVisible();
  await expect(page.getByText('Sin confirmar', { exact: true }).first()).toBeVisible();
  expect(state.writes).toEqual([{ path: '/api/operations/review-target/review', body: { expectedVersion: 1, reason: 'accepted_uncertainty' } }]);
});

for (const conflict of [false, true]) {
  test(`Revisión ${conflict ? '409' : 'ambigua'} exige reread y no repite la decisión`, async ({ page }) => {
    const state = await api(page, conflict ? { conflict: true } : { loseReviewResponse: true }); await page.goto('/actividad/review-target');
    await page.getByRole('button', { name: 'Marcar como revisada', exact: true }).click();
    await page.getByRole('alertdialog').getByLabel('Motivo de revisión').selectOption('checked_state');
    await page.getByRole('button', { name: 'Confirmar revisión', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Comprobar revisión guardada', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Comprobar revisión guardada', exact: true }).click();
    await expect(page.locator(`[data-operation-disposition="${conflict ? 'superseded' : 'reviewed'}"]`)).toBeVisible();
    if (conflict) await expect(page.getByRole('link', { name: 'Ver decisión posterior', exact: true })).toHaveAttribute('href', '/actividad/later-power');
    await expect(page.getByText('Sin confirmar', { exact: true }).first()).toBeVisible(); expect(state.writes).toHaveLength(1);
  });
}

test('Una sesión de agente no ofrece decisión humana', async ({ page }) => {
  const state = await api(page, { agent: true }); await page.goto('/actividad/review-target');
  await expect(page.getByText('La revisión durable corresponde a una sesión personal.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Marcar como revisada', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

async function stableSse(page: Page) {
  await page.addInitScript(() => {
    const streams: EventTarget[] = [];
    (window as unknown as { fixtureStreams: EventTarget[] }).fixtureStreams = streams;
    class Stream extends EventTarget { constructor(_url: string) { super(); streams.push(this); } close() {} }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: Stream });
  });
}
test('reconexión SSE actualiza Hoy y navbar sin esperar polling', async ({ page }) => {
  await stableSse(page); const state = await api(page); await page.goto('/');
  // Veredicto = 42 peticiones + grupos de atención del resumen recibido por SSE.
  const verdict = page.getByRole('heading', { level: 2, name: /cosas te tocan$/ });
  await expect(verdict).toHaveText('49 cosas te tocan');
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureStreams: EventTarget[] }).fixtureStreams.length)).toBeGreaterThan(0);
  state.summary.counts.attentionGroups = 19; state.summary.fetchedAt = at();
  await page.evaluate(summary => (window as unknown as { fixtureStreams: EventTarget[] }).fixtureStreams[0]!.dispatchEvent(new MessageEvent('attention', { data: JSON.stringify(summary) })), state.summary);
  await expect(verdict).toHaveText('61 cosas te tocan');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link', { name: 'Hoy', exact: true })).toHaveAccessibleDescription('19 grupos de atención');
  state.summary.counts.attentionGroups = 23;
  await page.evaluate(() => (window as unknown as { fixtureStreams: EventTarget[] }).fixtureStreams[0]!.dispatchEvent(new Event('open')));
  await expect(verdict).toHaveText('65 cosas te tocan');
});
test('Recurso y Agentes actualizan páginas montadas y conservan filtros inmediatos', async ({ page }) => {
  await stableSse(page); await page.clock.install(); const state = await api(page);
  state.setCurrent({ state: 'running', review: undefined, message: 'fixture-running' });
  await page.goto('/equipo/current-alias');
  await expect(page.getByRole('main').getByRole('link', { name: /fixture-running/ }).first()).toBeVisible();
  const resourceCalls = () => state.calls.filter(url => url.pathname === '/api/operations' && url.searchParams.get('resourceId') === 'current-alias').length;
  const initial = resourceCalls(); state.setCurrent({ state: 'succeeded', message: 'fixture-finished' });
  await page.clock.runFor(6000);
  await expect(page.getByRole('main').getByRole('link', { name: /fixture-finished/ }).first()).toBeVisible();
  expect(resourceCalls()).toBeGreaterThan(initial);
  await page.goto('/agentes'); await expect(page.getByRole('region', { name: /^Te espera/ })).toContainText('42');
  await expect(page.getByRole('link', { name: /Auditoría de claves/ })).toHaveAttribute('href', '/actividad');
  const pendingCalls = () => state.calls.filter(url => url.pathname === '/api/secrets/requests/pending').length;
  const before = pendingCalls(); await page.clock.runFor(61000);
  await expect.poll(pendingCalls).toBeGreaterThan(before);
  // «Cargar más» añade la página siguiente con el cursor del servidor; el total sigue saliendo del servidor.
  await page.getByRole('button', { name: 'Cargar más peticiones pendientes' }).click();
  await expect.poll(() => state.calls.some(url => url.pathname === '/api/secrets/requests/pending' && url.searchParams.get('cursor') === 'page_20')).toBe(true);
  await expect(page.getByRole('list', { name: 'Peticiones pendientes' }).getByRole('listitem')).toHaveCount(40);
  await expect(page.getByRole('button', { name: /^(Anterior|Siguiente)$/ })).toHaveCount(0);
  const input = page.getByRole('searchbox', { name: 'Buscar agentes o peticiones' });
  await input.fill('specific-filter');
  await expect.poll(() => state.calls.some(url => url.pathname === '/api/secrets/requests' && url.searchParams.get('q') === 'specific-filter')).toBe(true);
});
