// FIXTURES DE PROTOTIPO con la forma exacta del contrato (contracts/api.ts). NO son datos reales:
// los nombres de equipos salen del inventario; IDs, horas e importes son inventados. Todas las fechas se
// calculan respecto a un ancla para que sean deterministas (las capturas congelan el reloj).
import type { CatalogServiceRecord, CostReport, DetailedResource, Operation, SecretRequest } from '../ui/src/contract.ts';

export const HERMES_RESOURCE_ID = 'aws:agents:i-fixture-hermes';
export const ROUTER_RESOURCE_ID = 'router:fiberhome';

const NOTE_EC2 = 'El estado de EC2 no verifica las aplicaciones que ejecuta.';
const NOTE_HERMES = 'Hermes · Apagar esta EC2 detiene también al orquestador. El panel seguirá disponible.';
const NOTE_COOLIFY = 'Estado reportado por Coolify. Control de despliegues pendiente de habilitar.';
const NOTE_ROUTER = 'Gestión remota sin PC en casa. Reportes cada 60 s; consultar no reinicia Internet.';

export function isoAgo(anchorMs: number, seconds: number): string {
  return new Date(anchorMs - seconds * 1000).toISOString();
}

export function makeResources(anchorMs: number): DetailedResource[] {
  return withCatalog(baseResources(anchorMs));
}

/** Identidad de catálogo de prototipo para enlazar servicios por catalogId, igual que el backend. */
const FIXTURE_CATALOG: Readonly<Record<string, [string, 'aws' | 'coolify']>> = {
  [HERMES_RESOURCE_ID]: ['cat-fixture-hermes', 'aws'],
  'aws:prod:i-fixture-erp': ['cat-fixture-erp', 'aws'],
  'aws:prod:i-fixture-evolution': ['cat-fixture-evolution', 'aws'],
  'coolify:fixture-rendicion': ['cat-fixture-rendicion', 'coolify'],
  'coolify:fixture-support': ['cat-fixture-support', 'coolify'],
};
function withCatalog(resources: DetailedResource[]): DetailedResource[] {
  return resources.map((r) => {
    const entry = FIXTURE_CATALOG[r.id];
    if (!entry) return r;
    const [catalogId, provider] = entry;
    return { ...r, catalog: { catalogId, provider, accountId: provider === 'aws' ? '000000000000' : 'coolify', region: r.location, resourceType: provider === 'aws' ? 'ec2-instance' : 'coolify-application', providerId: r.id, lifecycle: 'active' } };
  });
}

function baseResources(anchorMs: number): DetailedResource[] {
  const ago = (seconds: number): string => isoAgo(anchorMs, seconds);
  return [
    { id: HERMES_RESOURCE_ID, name: 'orchestrator', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'agents', detail: 't4g.large', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_HERMES },
    { id: ROUTER_RESOURCE_ID, name: 'FiberHome', kind: 'router', state: 'reporting', location: 'Red de casa', account: 'Casa', detail: 'SR1021D · RP0102', actions: ['refresh'], observedAt: ago(25), note: NOTE_ROUTER },
    { id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unconfigured', location: 'Windows / CachyOS', account: 'Casa', detail: 'Dual boot', actions: [], observedAt: null, note: 'Encendido WOL, apagado y selección de sistema pendientes de verificar. Linux offline no significa PC apagada.' },
    { id: 'computer:mac', name: 'MacBook', kind: 'computer', state: 'running', location: 'macOS', account: 'Personal', detail: 'Apple Silicon · reporter saliente', actions: [], observedAt: ago(6), note: 'La Mac informa presencia por HTTPS. No se consultan ni controlan sus servicios.' },
    { id: 'aws:agents:i-fixture-game', name: 'game-server', kind: 'ec2', state: 'stopped', location: 'us-east-1', account: 'agents', detail: 'r6g.large', actions: ['start', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:prod:i-fixture-cms', name: 'prod-cms', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'prod', detail: 't3.small', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:prod:i-fixture-erp', name: 'prod-erp', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'prod', detail: 't4g.medium', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 , stateChangedAt: ago(3 * 86400), hostMetrics: { cpu: { percent: 18.2, observedAt: ago(30) }, memory: { usedBytes: 2.6 * 1024 ** 3, totalBytes: 4 * 1024 ** 3, utilizationPercent: 65, observedAt: ago(30) }, filesystems: [{ device: 'nvme0n1p1', mountpoint: '/', utilizationPercent: 71, observedAt: ago(30) }] }, health: { telemetry: { state: 'fresh', source: 'otel-collector', observedAt: ago(30) }, service: { state: 'degraded', source: 'https-probe', observedAt: ago(45), reasonCode: 'probe_result_stale' } }, actionAvailability: { start: { allowed: false, reasonCode: 'state_mismatch' }, stop: { allowed: true, reasonCode: 'available' }, refresh: { allowed: true, reasonCode: 'available' } } },
    { id: 'aws:prod:i-fixture-evolution', name: 'prod-messaging', kind: 'ec2', state: 'running', location: 'us-east-2', account: 'prod', detail: 't4g.small', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:lab:i-fixture-retail', name: 'lab-app', kind: 'ec2', state: 'unknown', location: 'us-east-1', account: 'lab', detail: 'c7i-flex.large', actions: [], observedAt: null, note: 'No se pudo consultar AWS. Se volverá a intentar tras el período de espera.' },
    { id: 'coolify:fixture-rendicion', name: 'shop-rendicion-branch', kind: 'service', state: 'running:healthy', location: 'VPS · vps-provider', account: 'Coolify', detail: 'Aplicación', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY },
    { id: 'coolify:fixture-support', name: 'support-desk', kind: 'service', state: 'running:unknown', location: 'VPS · vps-provider', account: 'Coolify', detail: 'Servicio Docker', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY },
    { id: 'coolify:fixture-erp', name: 'erp-branch', kind: 'service', state: 'running:unknown', location: 'VPS · vps-provider', account: 'Coolify', detail: 'Servicio Docker', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY }
  ];
}

export function makeOperations(anchorMs: number): Operation[] {
  const ago = (seconds: number): string => isoAgo(anchorMs, seconds);
  return [
    { id: 'op_7f3k21', resourceId: ROUTER_RESOURCE_ID, resourceName: 'FiberHome', action: 'refresh', actor: 'hermes', state: 'running', message: 'Lectura encolada en el ACS. Llega con el siguiente reporte del router: hasta 150 s.', createdAt: ago(120), updatedAt: ago(100) },
    { id: 'op_k7f3q2', resourceId: HERMES_RESOURCE_ID, resourceName: 'orchestrator', action: 'stop', actor: 'admin', state: 'uncertain', message: 'AWS no confirmó la recepción de la orden. Comprueba el estado antes de repetir.', createdAt: ago(1000), updatedAt: ago(840) },
    { id: 'op_m2c19x', resourceId: 'aws:agents:i-fixture-game', resourceName: 'game-server', action: 'start', actor: 'hermes', state: 'succeeded', message: 'AWS confirmó la instancia encendida. La salud de sus aplicaciones no se ha comprobado.', createdAt: ago(5500), updatedAt: ago(5450) },
    { id: 'op_n9q2ab', resourceId: 'aws:prod:i-fixture-cms', resourceName: 'prod-cms', action: 'stop', actor: 'admin', state: 'failed', message: 'El panel no pudo completar ni verificar la orden. Comprueba el estado antes de decidir otra acción.', createdAt: ago(7900), updatedAt: ago(7720) },
    { id: 'op_c4s8zz', resourceId: 'coolify:fixture-rendicion', resourceName: 'shop-rendicion-branch', action: 'refresh', actor: 'hermes', state: 'succeeded', message: 'Estado leído en Coolify. Se respetó la caché compartida de 60 s.', createdAt: ago(9800), updatedAt: ago(9799) },
    { id: 'op_f1h0pp', resourceId: ROUTER_RESOURCE_ID, resourceName: 'FiberHome', action: 'refresh', actor: 'admin', state: 'succeeded', message: 'Tarea completada y datos del router recientes.', createdAt: ago(12100), updatedAt: ago(12020) }
  ];
}

export function makeCosts(anchorMs: number): CostReport {
  const day = (offset: number): string => new Date(Date.UTC(new Date(anchorMs).getUTCFullYear(), new Date(anchorMs).getUTCMonth(), offset)).toISOString().slice(0, 10);
  const fetchedAt = isoAgo(anchorMs, 1200);
  const nextRefreshAt = new Date(anchorMs - 1200 * 1000 + 24 * 3600 * 1000).toISOString();
  const daily = (amounts: number[]): { date: string; amount: number }[] => amounts.map((amount, index) => ({ date: day(index + 1), amount }));
  return {
    accounts: [
      {
        account: 'prod', status: 'available', net: 18.4, usage: 58.4, adjustments: -40, currency: 'USD', estimated: true,
        services: [
          { name: 'EC2 - Other', amount: 7.2 }, { name: 'Amazon Elastic Compute Cloud - Compute', amount: 6.1 },
          { name: 'Amazon Simple Storage Service', amount: 2.3 }, { name: 'Amazon Virtual Private Cloud', amount: 1.9 }, { name: 'AmazonCloudWatch', amount: 0.9 }
        ],
        daily: daily([0.9, 0.95, 0.9, 1.0, 0.9, 0.92, 0.88]),
        budgetsStatus: 'available',
        budgets: [{ name: 'Mensual prod', limit: 30, actual: 18.4, forecast: 29.1, currency: 'USD', updatedAt: fetchedAt }],
        fetchedAt
      },
      {
        account: 'agents', status: 'available', net: 23.2, usage: 31.2, adjustments: -8, currency: 'USD', estimated: true,
        services: [{ name: 'Amazon Elastic Compute Cloud - Compute', amount: 15.8 }, { name: 'EC2 - Other', amount: 5.1 }, { name: 'Amazon Virtual Private Cloud', amount: 2.3 }],
        daily: daily([1.1, 1.2, 1.1, 1.15, 1.2, 1.1, 1.1]),
        budgetsStatus: 'available',
        budgets: [{ name: 'Tope agents', limit: 25, actual: 23.2, forecast: null, currency: 'USD', updatedAt: fetchedAt }],
        fetchedAt
      },
      {
        account: 'lab', status: 'available', net: 4.1, usage: 4.1, adjustments: 0, currency: 'USD', estimated: true,
        services: [{ name: 'Amazon Elastic Compute Cloud - Compute', amount: 3.4 }, { name: 'EC2 - Other', amount: 0.7 }],
        daily: daily([0.2, 0.2, 0.2, 0.22, 0.2, 0.2, 0.2]),
        budgetsStatus: 'available', budgets: [], fetchedAt
      }
    ],
    fetchedAt,
    nextRefreshAt,
    periodStart: `${day(1)}T00:00:00.000Z`,
    periodEnd: new Date(anchorMs).toISOString(),
    policy: 'Cost Explorer: caché de 24 h, máximo 2 páginas por cuenta y ciclo, sin refresco forzado.'
  };
}

/** Servicios lógicos de prototipo; las relaciones apuntan por catalogId, nunca por nombre. */
export function makeServices(anchorMs: number): CatalogServiceRecord[] {
  const seen = isoAgo(anchorMs, 120);
  const first = isoAgo(anchorMs, 30 * 86400);
  const host = (name: string, catalogId: string, provider: "aws" | "coolify", region: string, state: string) =>
    ({ catalogId, name, provider, accountId: provider === "aws" ? "000000000000" : "coolify", region, state, lifecycle: "active" as const });
  const rel = (alias: string, relationType: "hosted_on" | "depends_on", resource?: ReturnType<typeof host>) => ({
    resourceAlias: alias, resourceId: resource ? resource.catalogId : null, resolved: Boolean(resource), relationType,
    evidence: "operator_confirmed" as const, active: true, firstSeen: first, lastSeen: seen, ...(resource ? { resource } : {}),
  });
  return [
    { id: "svc:rendicion", key: "shop-rendicion", name: "Rendición branch", projectId: "p:shop", project: "a small business", environment: "producción", criticality: "high", source: "config", active: true,
      relations: [rel("shop-rendicion-branch", "hosted_on", host("shop-rendicion-branch", "cat-fixture-rendicion", "coolify", "VPS · vps-provider", "running:healthy")), rel("prod-erp", "depends_on", host("prod-erp", "cat-fixture-erp", "aws", "us-east-1", "running"))] },
    { id: "svc:support", key: "shop-atencion", name: "Atención al cliente", projectId: "p:shop", project: "a small business", environment: "producción", criticality: "critical", source: "config", active: true,
      relations: [rel("support-desk", "hosted_on", host("support-desk", "cat-fixture-support", "coolify", "VPS · vps-provider", "running:unknown")), rel("prod-messaging", "depends_on", host("prod-messaging", "cat-fixture-evolution", "aws", "us-east-2", "running"))] },
    { id: "svc:hermes", key: "hermes", name: "Hermes", projectId: "p:personal", project: "Personal", environment: null, criticality: "normal", source: "config", active: true,
      relations: [rel("orchestrator", "hosted_on", host("orchestrator", "cat-fixture-hermes", "aws", "us-east-1", "running"))] },
    { id: "svc:retail", key: "retail-lab", name: "Retail SaaS lab", projectId: "p:lab", project: "Lab", environment: "pruebas", criticality: "low", source: "config", active: true,
      relations: [rel("lab-app-pendiente", "hosted_on")] },
  ];
}

/** Solicitudes de secretos de prototipo. Nunca incluyen valores. */
export function makeSecretRequests(anchorMs: number): SecretRequest[] {
  const ago = (seconds: number): string => isoAgo(anchorMs, seconds);
  return [
    { id: 'sec_pending1', agent: 'claude-mac', machine: 'MacBook Air', name: 'OPENAI_API_KEY', project: 'prod-erp', environment: 'dev',
      destination: { kind: 'dotenv', path: '.env.local' }, reason: 'Probar el asistente del ERP en local', state: 'pending', scope: null,
      createdAt: ago(90), expiresAt: ago(-1710), decidedAt: null, deliveredAt: null, auto: false },
    { id: 'sec_done1', agent: 'hermes', machine: 'EC2 orchestrator', name: 'DATABASE_URL', project: 'prod-erp', environment: 'dev',
      destination: { kind: 'dotenv', path: '.env' }, reason: 'Migración de la base de pruebas', state: 'delivered', scope: 'once',
      createdAt: ago(7200), expiresAt: ago(5400), decidedAt: ago(7000), deliveredAt: ago(6990), auto: false },
  ];
}
