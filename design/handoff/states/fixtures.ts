// FIXTURES DE PROTOTIPO con la forma exacta del contrato (contracts/api.ts). NO son datos reales:
// los nombres de equipos salen del inventario; IDs, horas e importes son inventados. Todas las fechas se
// calculan respecto a un ancla para que sean deterministas (las capturas congelan el reloj).
import type { CostReport, Operation, Resource } from '../ui/src/contract.ts';

export const HERMES_RESOURCE_ID = 'aws:agents:i-fixture-hermes';
export const ROUTER_RESOURCE_ID = 'router:fiberhome';

const NOTE_EC2 = 'El estado de EC2 no verifica las aplicaciones que ejecuta.';
const NOTE_HERMES = 'Hermes · Apagar esta EC2 detiene también al orquestador. El panel seguirá disponible.';
const NOTE_COOLIFY = 'Estado reportado por Coolify. Control de despliegues pendiente de habilitar.';
const NOTE_ROUTER = 'Gestión remota sin PC en casa. Reportes cada 60 s; consultar no reinicia Internet.';

export function isoAgo(anchorMs: number, seconds: number): string {
  return new Date(anchorMs - seconds * 1000).toISOString();
}

export function makeResources(anchorMs: number): Resource[] {
  const ago = (seconds: number): string => isoAgo(anchorMs, seconds);
  return [
    { id: HERMES_RESOURCE_ID, name: 'orchestrator', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'agents', detail: 't4g.large', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_HERMES },
    { id: ROUTER_RESOURCE_ID, name: 'FiberHome', kind: 'router', state: 'reporting', location: 'Red de casa', account: 'Casa', detail: 'SR1021D · RP0102', actions: ['refresh'], observedAt: ago(25), note: NOTE_ROUTER },
    { id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unconfigured', location: 'Windows / CachyOS', account: 'Casa', detail: 'Dual boot', actions: [], observedAt: null, note: 'Encendido WOL, apagado y selección de sistema pendientes de verificar. Linux offline no significa PC apagada.' },
    { id: 'computer:mac', name: 'MacBook', kind: 'computer', state: 'running', location: 'macOS', account: 'Personal', detail: 'Apple Silicon · reporter saliente', actions: [], observedAt: ago(6), note: 'La Mac informa presencia por HTTPS. No se consultan ni controlan sus servicios.' },
    { id: 'aws:agents:i-fixture-game', name: 'game-server', kind: 'ec2', state: 'stopped', location: 'us-east-1', account: 'agents', detail: 'r6g.large', actions: ['start', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:prod:i-fixture-cms', name: 'prod-cms', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'prod', detail: 't3.small', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:prod:i-fixture-erp', name: 'prod-erp', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'prod', detail: 't4g.medium', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:prod:i-fixture-evolution', name: 'prod-messaging', kind: 'ec2', state: 'running', location: 'us-east-2', account: 'prod', detail: 't4g.small', actions: ['stop', 'refresh'], observedAt: ago(40), note: NOTE_EC2 },
    { id: 'aws:lab:i-fixture-retail', name: 'lab-app', kind: 'ec2', state: 'unknown', location: 'us-east-1', account: 'lab', detail: 'c7i-flex.large', actions: [], observedAt: null, note: 'No se pudo consultar AWS. Se volverá a intentar tras el período de espera.' },
    { id: 'coolify:fixture-rendicion', name: 'expenses-app', kind: 'service', state: 'running:healthy', location: 'VPS · provider', account: 'Coolify', detail: 'Aplicación', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY },
    { id: 'coolify:fixture-support', name: 'support-desk', kind: 'service', state: 'running:unknown', location: 'VPS · provider', account: 'Coolify', detail: 'Servicio Docker', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY },
    { id: 'coolify:fixture-erp', name: 'erp-suite', kind: 'service', state: 'running:unknown', location: 'VPS · provider', account: 'Coolify', detail: 'Servicio Docker', actions: ['refresh'], observedAt: ago(52), note: NOTE_COOLIFY }
  ];
}

export function makeOperations(anchorMs: number): Operation[] {
  const ago = (seconds: number): string => isoAgo(anchorMs, seconds);
  return [
    { id: 'op_7f3k21', resourceId: ROUTER_RESOURCE_ID, resourceName: 'FiberHome', action: 'refresh', actor: 'hermes', state: 'running', message: 'Lectura encolada en el ACS. Llega con el siguiente reporte del router: hasta 150 s.', createdAt: ago(120), updatedAt: ago(100) },
    { id: 'op_k7f3q2', resourceId: HERMES_RESOURCE_ID, resourceName: 'orchestrator', action: 'stop', actor: 'admin', state: 'uncertain', message: 'AWS no confirmó la recepción de la orden. Comprueba el estado antes de repetir.', createdAt: ago(1000), updatedAt: ago(840) },
    { id: 'op_m2c19x', resourceId: 'aws:agents:i-fixture-game', resourceName: 'game-server', action: 'start', actor: 'hermes', state: 'succeeded', message: 'AWS confirmó la instancia encendida. La salud de sus aplicaciones no se ha comprobado.', createdAt: ago(5500), updatedAt: ago(5450) },
    { id: 'op_n9q2ab', resourceId: 'aws:prod:i-fixture-cms', resourceName: 'prod-cms', action: 'stop', actor: 'admin', state: 'failed', message: 'El panel no pudo completar ni verificar la orden. Comprueba el estado antes de decidir otra acción.', createdAt: ago(7900), updatedAt: ago(7720) },
    { id: 'op_c4s8zz', resourceId: 'coolify:fixture-rendicion', resourceName: 'expenses-app', action: 'refresh', actor: 'hermes', state: 'succeeded', message: 'Estado leído en Coolify. Se respetó la caché compartida de 60 s.', createdAt: ago(9800), updatedAt: ago(9799) },
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
