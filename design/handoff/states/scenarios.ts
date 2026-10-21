// Escenarios de prototipo: cada estado aprobado del diseño es un escenario con nombre (`?s=<id>` en el prototipo).
// Los usa fixtureProvider.ts; el adaptador de producción NO los conoce.
import type { CostReport, Operation, Resource } from '../ui/src/contract.ts';
import { isoAgo, ROUTER_RESOURCE_ID } from './fixtures.ts';

export interface ProviderErrorInit {
  kind: 'network' | 'http';
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  ambiguous?: boolean;
}

export interface ScenarioConfig {
  session: 'authed' | 'anonymous';
  login: 'ok' | 'bad-credentials' | 'rate-limited';
  changePassword: 'ok' | 'bad-current' | 'rate-limited';
  resources: (base: Resource[], anchorMs: number) => Resource[];
  /** A partir de la llamada N (1 = primera) `getResources` falla así. */
  resourcesFailure: { fromCall: number; error: ProviderErrorInit } | null;
  /** Latencia por número de llamada a `getResources` (ms). */
  resourcesLatencyMs: Readonly<Record<number, number>>;
  operations: (base: Operation[], anchorMs: number) => Operation[];
  costs: (base: CostReport, anchorMs: number) => CostReport;
  /** El informe de costes nunca termina de calcularse (esqueleto de carga). */
  costsPending: boolean;
  powerOutcome: 'succeeded' | 'uncertain' | 'failed';
  createOperation: 'ok' | 'ambiguous' | 'conflict';
}

export interface Scenario {
  id: string;
  description: string;
  config: ScenarioConfig;
}

const identity = <T,>(value: T): T => value;

export const DEFAULT_CONFIG: ScenarioConfig = {
  session: 'authed',
  login: 'ok',
  changePassword: 'ok',
  resources: identity,
  resourcesFailure: null,
  resourcesLatencyMs: {},
  operations: (base) => base.filter((operation) => operation.id !== 'op_7f3k21'),
  costs: identity,
  costsPending: false,
  powerOutcome: 'succeeded',
  createOperation: 'ok'
};

const registry = new Map<string, Scenario>();

function define(id: string, description: string, patch: Partial<ScenarioConfig> = {}): void {
  registry.set(id, { id, description, config: { ...DEFAULT_CONFIG, ...patch } });
}

function mapResource(match: (resource: Resource) => boolean, change: (resource: Resource) => Resource) {
  return (base: Resource[]): Resource[] => base.map((resource) => (match(resource) ? change(resource) : resource));
}

const isRouter = (resource: Resource): boolean => resource.kind === 'router';
const isCoolify = (resource: Resource): boolean => resource.kind === 'service';

const coolifyDown = mapResource(isCoolify, (resource) => ({
  ...resource,
  state: 'unknown',
  actions: [],
  observedAt: null,
  note: 'Coolify no está disponible o ha limitado las solicitudes. Sin reintentos durante 60 s.'
}));

function routerOp(anchorMs: number, state: Operation['state'], message: string, extra: Partial<Operation> = {}): Operation {
  return {
    id: 'op_router_fixture', resourceId: ROUTER_RESOURCE_ID, resourceName: 'FiberHome', action: 'refresh', actor: 'admin',
    state, message, createdAt: isoAgo(anchorMs, 150), updatedAt: isoAgo(anchorMs, 3), ...extra
  };
}

define('normal', 'Todo reportando; sin órdenes activas.');
define('login-bad', 'Sin sesión; las credenciales siempre son incorrectas.', { session: 'anonymous', login: 'bad-credentials' });
define('login-limited', 'Sin sesión; tras el intento, límite de 5 fallos (429, 15 min).', { session: 'anonymous', login: 'rate-limited' });
define('login-ok', 'Sin sesión; el acceso es correcto.', { session: 'anonymous', login: 'ok' });
define('session-expires', 'La sesión caduca en el segundo ciclo de inventario (401).', {
  resourcesFailure: { fromCall: 2, error: { kind: 'http', status: 401, message: 'Sesión caducada' } }
});
define('server-down', 'El inventario carga una vez y después el panel no responde.', {
  resourcesFailure: { fromCall: 2, error: { kind: 'network', message: 'No se pudo contactar con el panel' } }
});
define('rate-limited', 'El inventario carga una vez y después responde 429 con espera de 45 s.', {
  resourcesFailure: { fromCall: 2, error: { kind: 'http', status: 429, retryAfterSeconds: 45, message: 'Demasiadas solicitudes' } }
});
define('stale-data', 'Todas las observaciones tienen 6 minutos.', {
  resources: (base, anchorMs) => base.map((resource) => (resource.observedAt === null ? resource : { ...resource, observedAt: isoAgo(anchorMs, 360) }))
});
define('partial-coolify', 'Coolify no respondió; EC2 y router están al día.', { resources: coolifyDown });
define('return-from-background', 'La segunda lectura del inventario tarda (regreso del segundo plano).', { resourcesLatencyMs: { 2: 4000 } });

define('fh-stale', 'FiberHome con el último reporte de hace 14 min.', {
  resources: mapResource(isRouter, (resource) => ({
    ...resource, state: 'stale', actions: [], observedAt: new Date(Date.parse(resource.observedAt ?? '') - 14 * 60 * 1000).toISOString(),
    note: 'No llegan reportes recientes. Esto no demuestra una caída de Internet.'
  }))
});
define('fh-acs', 'El servidor ACS no responde.', {
  resources: mapResource(isRouter, (resource) => ({
    ...resource, state: 'unknown', actions: [], observedAt: null, detail: 'SR1021D · CWMP',
    note: 'No se pudo consultar el servidor ACS. No implica que el router esté apagado.'
  }))
});
define('fh-read-running', 'Lectura del router encolada (en curso).', {
  operations: (_base, anchorMs) => [routerOp(anchorMs, 'running', 'Lectura encolada en el ACS. Llega con el siguiente reporte del router: hasta 150 s.', { updatedAt: isoAgo(anchorMs, 20) })]
});
define('fh-read-ok', 'Lectura del router finalizada y confirmada.', {
  operations: (_base, anchorMs) => [routerOp(anchorMs, 'succeeded', 'Tarea completada y datos del router recientes.')]
});
define('fh-read-uncertain', 'La lectura del router no se pudo confirmar.', {
  operations: (_base, anchorMs) => [routerOp(anchorMs, 'uncertain', 'El router no confirmó la lectura a tiempo. Puede llegar con el próximo reporte; comprueba el estado antes de pedir otra.')]
});
define('ec2-pending', 'game-server está iniciando.', {
  resources: mapResource((resource) => resource.name === 'game-server', (resource) => ({ ...resource, state: 'pending', actions: ['refresh'] }))
});
define('coolify-failed', 'erp-suite con fallo reportado por Coolify.', {
  resources: mapResource((resource) => resource.name === 'erp-suite', (resource) => ({ ...resource, state: 'exited:unhealthy' }))
});
define('coolify-down', 'Coolify no disponible.', { resources: coolifyDown });

define('activity', 'Actividad con una lectura en curso, una incierta y una fallida.', { operations: identity });
define('ops-empty', 'Aún no hay órdenes.', { operations: () => [] });

define('power-succeeds', 'Las órdenes de energía terminan confirmadas.', { powerOutcome: 'succeeded' });
define('power-uncertain', 'Las órdenes de energía terminan sin confirmar.', { powerOutcome: 'uncertain' });
define('power-fails', 'Las órdenes de energía fallan.', { powerOutcome: 'failed' });
define('power-ambiguous', 'El envío de la orden se corta tras salir (ambiguo): se puede recuperar con la misma clave.', { createOperation: 'ambiguous' });

define('costs-loading', 'Primer cálculo de costes en curso.', { costsPending: true });
define('costs-partial', 'agents quedó parcial por el límite de páginas.', {
  costs: (base) => ({
    ...base,
    accounts: base.accounts.map((account) =>
      account.account === 'agents'
        ? { ...account, status: 'partial', net: 19.8, usage: 27.8, services: [{ name: 'Amazon Elastic Compute Cloud - Compute', amount: 15.8 }, { name: 'EC2 - Other', amount: 4 }] }
        : account
    )
  })
});
define('costs-denied', 'lab no tiene permiso en Cost Explorer ni en Budgets.', {
  costs: (base) => ({
    ...base,
    accounts: base.accounts.map((account) =>
      account.account === 'lab'
        ? { ...account, status: 'unavailable', net: null, usage: null, adjustments: null, services: [], daily: [], budgetsStatus: 'unavailable', budgets: [] }
        : account
    )
  })
});
define('costs-no-budget', 'AWS no devolvió presupuestos de coste para prod.', {
  costs: (base) => ({ ...base, accounts: base.accounts.map((account) => (account.account === 'prod' ? { ...account, budgets: [] } : account)) })
});
define('costs-first-day', 'Primer día del mes: AWS aún no publica el consumo.', {
  costs: (base) => ({
    ...base,
    accounts: base.accounts.map((account) => ({
      ...account, net: null, usage: null, adjustments: null, services: [], daily: [],
      budgets: account.budgets.map((budget) => ({ ...budget, actual: null, forecast: null }))
    }))
  })
});
define('password-bad-current', 'Cambio de contraseña: la actual es incorrecta.', { changePassword: 'bad-current' });
define('password-limited', 'Cambio de contraseña: demasiados intentos.', { changePassword: 'rate-limited' });

export function getScenario(id: string | null | undefined): Scenario {
  const found = registry.get(id ?? 'normal');
  if (found === undefined) throw new Error(`Escenario desconocido: ${id ?? ''}`);
  return found;
}

export function hasScenario(id: string): boolean {
  return registry.has(id);
}

export function listScenarios(): Scenario[] {
  return Array.from(registry.values());
}
