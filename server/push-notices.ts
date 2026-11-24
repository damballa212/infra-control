import { createHash } from 'node:crypto';
import type { DurableEvent, PushCategory } from './store.js';

/**
 * Catálogo de avisos push: qué evento produce qué texto y bajo qué reglas se entrega.
 * Los textos son para una persona: nada de nombres de unidades, estados internos ni advertencias técnicas
 * (esas viven en la app, donde hay espacio para explicarlas).
 */
export type PushPolicy = {
  /** Espera antes de entregar un aviso de pérdida; una recuperación a tiempo lo cancela (oscilaciones). */
  holdSeconds?: number;
  /** Identifica un aviso de pérdida que una recuperación puede cancelar. */
  lossKey?: string;
  /** Esta recuperación cancela las pérdidas retenidas con esa clave. */
  recoversKey?: string;
  /** Solo avisar la recuperación si la pérdida llegó a entregarse. */
  recoveryNeedsLoss?: boolean;
  /** Si ya salió un aviso con la misma etiqueta hace instantes, este sobra (varias señales de un mismo hecho). */
  coalesce?: boolean;
  /** Avisos de ausencia personal sujetos a opt-in explícito del servidor. */
  device?: 'desktop' | 'mac';
};
export type PushNotification = {
  title: string; body: string; category: PushCategory; tag: string; url: string; icon: string; badge: string; ttlSeconds: number;
  policy?: PushPolicy;
};

/** Ventana en la que varias señales del mismo equipo cuentan como un solo hecho. */
export const COALESCE_WINDOW_MS = 90_000;
const DESKTOP_POWER_TAG = 'infra-desktop-power';
const DESKTOP_SIGNAL_TAG = 'infra-desktop-signal';
const DESKTOP_HOLD_SECONDS = 180;
const ROUTER_HOLD_SECONDS = 180;
const HERMES_HOLD_SECONDS = 120;
const MAC_HOLD_SECONDS = 1800;
const DESKTOP_PATH = '/equipo/computer%3Adesktop';

export function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value: unknown, currency: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
}

const OPERATION_PHRASES: Readonly<Record<string, { done: string; failed: string; uncertain: string }>> = {
  stop: { done: 'apagada', failed: 'No se pudo apagar', uncertain: 'Confirma si se apagó' },
  start: { done: 'encendida', failed: 'No se pudo encender', uncertain: 'Confirma si encendió' },
  'boot-windows': { done: 'arrancó en Windows', failed: 'No se pudo iniciar Windows en', uncertain: 'Confirma si Windows inició en' },
  'boot-cachyos': { done: 'arrancó en CachyOS', failed: 'No se pudo iniciar CachyOS en', uncertain: 'Confirma si CachyOS inició en' },
  refresh: { done: 'actualizada', failed: 'No se pudo actualizar', uncertain: 'Confirma el estado de' },
};

/** Una orden en lenguaje de persona: «PC de casa apagada», «No se pudo encender orchestrator». */
function operationTitle(action: string, state: string, name: string): string {
  const phrase = OPERATION_PHRASES[action];
  if (!phrase) return state === 'succeeded' ? `${name} · orden completada` : state === 'failed' ? `${name} · orden fallida` : `${name} · confirma el estado`;
  if (state === 'succeeded') return `${name} ${phrase.done}`;
  return `${phrase[state === 'failed' ? 'failed' : 'uncertain']} ${name}`;
}

const PROVIDER_STATES: Readonly<Record<string, string>> = {
  running: 'encendida', stopped: 'detenida', stopping: 'deteniéndose', pending: 'arrancando',
  'shutting-down': 'apagándose', terminated: 'terminada',
};
const providerState = (value: unknown): string => PROVIDER_STATES[text(value, 40)] ?? text(value, 40);

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 24);
}

type Draft = { category: PushCategory; title: string; body: string; url: string; ttlSeconds?: number; tag?: string; policy?: PushPolicy };

function fromOperation(data: Record<string, unknown>): Draft | undefined {
  if(data.reviewChange===true)return undefined;
  const state = text(data.state, 24);
  if (!['succeeded', 'failed', 'uncertain'].includes(state)) return undefined;
  const action = text(data.action, 20);
  if (state === 'succeeded' && action === 'refresh') return undefined;
  const operationId = text(data.id, 80);
  const onDesktop = data.resourceId === 'computer:desktop';
  return {
    category: 'operations',
    title: operationTitle(action, state, text(data.resourceName, 40) || 'Infraestructura'),
    body: state === 'succeeded' ? 'Orden completada.' : text(data.message, 110) || 'Abre Actividad para ver el detalle.',
    url: operationId ? `/actividad?operation=${encodeURIComponent(operationId)}` : '/',
    ...(onDesktop ? { tag: DESKTOP_POWER_TAG } : {}),
    // Un fallo nunca se funde con otro aviso: es justo lo que hay que ver.
    ...(onDesktop && state === 'succeeded' ? { policy: { coalesce: true } } : {}),
  };
}

function fromDesktop(data: Record<string, unknown>): Draft | undefined {
  const state = text(data.state, 24);
  const system = data.system === 'windows' ? 'Windows' : data.system === 'cachyos' ? 'CachyOS' : undefined;
  const base = { category: 'devices' as const, url: DESKTOP_PATH };
  if (state === 'running') {
    if (!system) return undefined;
    return { ...base, title: 'PC de casa en línea', body: `${system} ya inició.`, tag: DESKTOP_POWER_TAG, policy: { coalesce: true, recoversKey: 'desktop-signal' } };
  }
  if (state === 'stopped') return { ...base, title: 'PC de casa apagada', body: 'El sistema avisó que se apagó.', tag: DESKTOP_POWER_TAG, policy: { coalesce: true } };
  if (state === 'unreachable') {
    return { ...base, title: 'PC de casa sin señal', body: 'No llegan reportes. Puede seguir encendida.', tag: DESKTOP_SIGNAL_TAG,
      policy: { holdSeconds: DESKTOP_HOLD_SECONDS, lossKey: 'desktop-signal', device: 'desktop' } };
  }
  // «pending» (reinicio en curso) no se avisa: lo inició la persona y la app lo muestra en vivo.
  return undefined;
}

function fromBootPreference(data: Record<string, unknown>): Draft | undefined {
  const state = text(data.state, 24);
  if (!['applied', 'pending', 'uncertain', 'failed', 'drift'].includes(state)) return undefined;
  const system = data.desired === 'windows' ? 'Windows' : data.desired === 'cachyos' ? 'CachyOS' : 'el sistema solicitado';
  return {
    category: 'devices', url: DESKTOP_PATH,
    title: state === 'applied' ? 'Arranque predeterminado actualizado' : state === 'drift' ? 'El arranque predeterminado cambió' : state === 'pending' ? 'Cambio de arranque pendiente' : 'No se pudo confirmar el arranque',
    body: state === 'applied' ? `La PC iniciará normalmente en ${system}.` : text(data.message, 130) || `Revisa la preferencia de arranque de ${system}.`,
  };
}

function fromMac(data: Record<string, unknown>): Draft | undefined {
  const reason = text(data.transitionReason, 40);
  const base = { category: 'devices' as const, url: '/equipo/computer%3Amac' };
  // Que la MacBook duerma es normal: el reposo anunciado no se avisa.
  if (reason === 'telemetry_timeout') {
    return { ...base, title: 'MacBook sin señal', body: 'No llegan reportes desde hace un rato. Puede estar dormida o sin red.',
      policy: { holdSeconds: MAC_HOLD_SECONDS, lossKey: 'mac-signal', coalesce: true, device: 'mac' } };
  }
  if (reason === 'telemetry_recovered' || reason === 'mac_wake_reported') {
    return { ...base, title: 'MacBook de vuelta', body: 'Vuelve a reportar.', policy: { recoversKey: 'mac-signal', recoveryNeedsLoss: true, coalesce: true } };
  }
  return undefined;
}

function fromRouterResource(data: Record<string, unknown>): Draft | undefined {
  const reason = text(data.transitionReason, 40);
  const base = { category: 'router' as const, url: '/equipo/router%3Afiberhome' };
  if (reason === 'telemetry_timeout') return routerLoss(base.url);
  if (reason === 'telemetry_recovered') {
    return { ...base, title: 'FiberHome de vuelta', body: 'Vuelve a llegar telemetría del router.', policy: { recoversKey: 'router-signal', recoveryNeedsLoss: true } };
  }
  if (reason === 'router_reboot_observed') return { ...base, title: 'FiberHome se reinició', body: 'Se observó un nuevo arranque del router.' };
  return undefined;
}

function routerLoss(url: string): Draft {
  return { category: 'router', url, title: 'FiberHome sin telemetría', body: 'El panel no recibe métricas del túnel. No confirma que se haya caído Internet.',
    policy: { holdSeconds: ROUTER_HOLD_SECONDS, lossKey: 'router-signal', coalesce: true } };
}

function fromHermes(data: Record<string, unknown>): Draft {
  const state = text(data.to, 24);
  const id = text(data.resourceId, 120);
  const base = { category: 'infrastructure' as const, url: id ? `/equipo/${encodeURIComponent(id)}` : '/', ttlSeconds: 900 };
  if (state === 'healthy') return { ...base, title: 'Hermes recuperado', body: 'El servicio vuelve a responder.', policy: { recoversKey: 'hermes-signal', recoveryNeedsLoss: true } };
  const stale = state === 'stale';
  return { ...base, title: stale ? 'Hermes sin señal' : 'Hermes caído',
    body: stale ? 'No llegan reportes. La instancia puede seguir encendida.' : 'El servicio no está activo. La instancia puede seguir encendida.',
    policy: { holdSeconds: HERMES_HOLD_SECONDS, lossKey: 'hermes-signal' } };
}

function fromProviderChange(data: Record<string, unknown>): Draft {
  const name = text(data.resourceName, 55) || 'Recurso';
  const from = providerState(data.from), to = providerState(data.to);
  const id = text(data.resourceId, 120);
  const rawTo = text(data.to, 40);
  return {
    category: 'infrastructure', url: id ? `/equipo/${encodeURIComponent(id)}` : '/', ttlSeconds: 900,
    title: rawTo === 'running' ? `${name} se encendió` : rawTo === 'stopped' ? `${name} se detuvo` : `${name} cambió de estado`,
    body: from && to ? `Pasó de ${from} a ${to} sin una orden del panel.` : 'Cambió sin una orden del panel.',
  };
}

function fromBudget(data: Record<string, unknown>): Draft {
  const name = text(data.budgetName, 50) || 'Presupuesto AWS';
  const account = text(data.account, 35) || 'AWS';
  const percent = typeof data.percent === 'number' && Number.isFinite(data.percent) ? Math.max(0, Math.min(999, Math.round(data.percent))) : null;
  const source = data.source === 'forecast' ? 'previsión' : 'gasto estimado';
  const amount = money(data.amount, data.currency), limit = money(data.limit, data.currency);
  const comparison = amount && limit ? ` ${amount} de ${limit}` : amount ? ` ${amount}` : '';
  return {
    category: 'budgets', url: '/costes', ttlSeconds: 86400,
    title: `AWS · presupuesto${percent === null ? '' : ` al ${percent}%`}`,
    body: `${account} · ${name}: ${source}${comparison}${percent === null ? '' : ` (${percent}%)`}. Datos al ${text(data.asOf, 16) || 'último cálculo'}.`,
  };
}

export function serviceProbeSignalKey(resourceId:string):string { return `service-probe-${hash(resourceId)}`; }

function fromServiceProbe(data:Record<string,unknown>):Draft|undefined {
  const resourceId=text(data.resourceId,160),state=text(data.to,24),reason=text(data.transitionReason,48);
  if(!resourceId)return undefined;
  const key=serviceProbeSignalKey(text(data.signalResourceId,220)||resourceId);
  const url=resourceId.startsWith('catalog:')?'/':`/equipo/${encodeURIComponent(resourceId)}`;
  if(reason==='service_probe_unhealthy'&&state==='unhealthy')return {
    category:'infrastructure',title:'Servicio sin respuesta',
    body:'El control de salud recibió una respuesta inesperada. Abre Infra Control para revisar el estado.',
    url,ttlSeconds:900,tag:`infra-${key}`,
    policy:{holdSeconds:120,lossKey:key,coalesce:true}
  };
  if(reason==='service_probe_observability_lost'&&state==='unknown')return {
    category:'infrastructure',title:'Salud del servicio sin comprobar',
    body:'La comprobación lleva un tiempo sin obtener evidencia concluyente. No confirma que la aplicación esté caída.',
    url,ttlSeconds:900,tag:`infra-${key}`,policy:{lossKey:key}
  };
  if(reason==='service_probe_recovered'&&state==='healthy')return {
    category:'infrastructure',title:text(data.from,24)==='unknown'?'Comprobación restablecida':'Servicio recuperado',
    body:'El control de salud volvió a responder correctamente.',
    url,ttlSeconds:900,tag:`infra-${key}`,
    policy:{recoversKey:key,recoveryNeedsLoss:true,coalesce:true}
  };
  return undefined;
}

function fromCoverage(data:Record<string,unknown>):Draft|undefined {
  const state=text(data.state,16),connection=text(data.connectionName,48)||'Proveedor',scope=text(data.scopeKey,100);
  if(!['partial','failed','healthy'].includes(state))return undefined;
  const scopeLabel=scope==='aws:identity'?'la identidad de AWS'
    :scope==='aws:regions'?'las regiones de AWS'
    :scope.startsWith('aws:ec2:')?`las instancias EC2 de ${scope.slice('aws:ec2:'.length)}`
    :scope==='coolify:resources'?'los recursos de Coolify':'el inventario de infraestructura';
  const key=`catalog-coverage-${hash(`${text(data.connectionId,80)}:${scope}`)}`;
  if(state==='healthy'){
    if(!['partial','failed'].includes(text(data.previousState,16)))return undefined;
    return {category:'infrastructure',url:'/',title:'Inventario actualizado',body:`${scopeLabel} de ${connection} vuelve a sincronizarse.`,tag:`${key}:recovered`,policy:{recoversKey:key,recoveryNeedsLoss:true}};
  }
  const body=state==='failed'?`No se pudo consultar ${scopeLabel} de ${connection}. El catálogo puede estar desactualizado.`:`La revisión de ${scopeLabel} de ${connection} quedó incompleta. Algunos datos pueden estar atrasados.`;
  return {category:'infrastructure',url:'/',title:state==='failed'?'Sin acceso al inventario':'Inventario incompleto',body,tag:`${key}:loss`,ttlSeconds:900,policy:{holdSeconds:90,lossKey:key,coalesce:true}};
}

const HOST_COMPONENTS = {
  'host-cpu': 'Uso de CPU', 'host-memory': 'Uso de memoria', 'host-disk': 'Uso de disco',
  'docker-health': 'Salud del contenedor', 'host-availability': 'Disponibilidad del recurso',
} as const;

function hostSignal(event: DurableEvent) {
  const data = event.payload, component = data.component;
  if (event.type !== 'incident' || data.source !== 'host-native-monitor' || data.category !== 'infrastructure' ||
      typeof component !== 'string' || !Object.hasOwn(HOST_COMPONENTS, component) ||
      data.resourceId !== event.aggregateId) return;
  let reference: string;
  if (event.aggregateId.startsWith('host:')) {
    if (typeof data.catalogId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.catalogId)) return;
    reference = `catalog:${data.catalogId}`;
  } else if (event.aggregateId.startsWith('catalog:')) {
    if (data.catalogId !== undefined && `catalog:${data.catalogId}` !== event.aggregateId) return;
    reference = event.aggregateId;
  } else return;
  return { key: `native-host-${hash(JSON.stringify([reference, component]))}`, label: HOST_COMPONENTS[component as keyof typeof HOST_COMPONENTS] };
}

function fromNativeHost(event: DurableEvent): Draft | undefined {
  const signal = hostSignal(event);
  if (!signal) return;
  const { key, label } = signal, data = event.payload;
  const name = text(data.resourceName, 55) || 'Infraestructura';
  const base = { category: 'infrastructure' as const, url: '/actividad', tag: `infra-${key}` };
  if (data.status === 'open' && data.actionable === true) return {
    ...base, title: `${label} · alerta`, body: `${name}: el monitor detectó un problema. Revisa Actividad.`,
    policy: { lossKey: key },
  };
  if (data.status === 'resolved' && data.from === 'bad') return {
    ...base, title: `${label} · normal`, body: `${name}: las observaciones volvieron a valores normales.`,
    policy: { recoversKey: key, recoveryNeedsLoss: true },
  };
}

function draftFor(event: DurableEvent): Draft | undefined {
  const data = event.payload;
  if(event.type==='coverage')return fromCoverage(data);
  if (event.type === 'operation') return fromOperation(data);
  if (event.type === 'desktop' && event.aggregateId === 'computer:desktop') return fromDesktop(data);
  if (event.type === 'resource' && event.aggregateId === 'computer:desktop:boot-preference') return fromBootPreference(data);
  if (event.type === 'resource' && event.aggregateId === 'computer:mac') return fromMac(data);
  if (event.type === 'resource' && event.aggregateId === 'router:fiberhome') return fromRouterResource(data);
  if (event.type === 'incident' && data.category === 'budget') return fromBudget(data);
  if (event.type !== 'incident' || data.category !== 'infrastructure') return undefined;
  if(data.source==='https-probe')return fromServiceProbe(data);
  if(data.source==='host-native-monitor')return fromNativeHost(event);
  if (event.aggregateId === 'router:fiberhome') return data.transitionReason === 'telemetry_timeout' ? routerLoss('/equipo/router%3Afiberhome') : undefined;
  if (event.aggregateId === 'hermes:orchestrator') return fromHermes(data);
  return fromProviderChange(data);
}

export type PushSignalDirective = { key: string; role: 'loss' | 'recovery' | 'explained' | 'inconclusive'; mode: string };
export function signalForEvent(event: DurableEvent): PushSignalDirective | undefined {
  const data=event.payload,reason=text(data.transitionReason,64);
  const host = hostSignal(event);
  if(host && data.status === 'unknown') return {key:host.key,role:'inconclusive',mode:'unknown'};
  if(host && data.status === 'information') return {key:host.key,role:'explained',mode:'baseline'};
  if(event.aggregateId==='computer:mac'&&['mac_sleep_announced','mac_sleep_observation_expired'].includes(reason))return {key:'mac-signal',role:'explained',mode:'sleep'};
  if(event.aggregateId==='computer:desktop'&&(reason==='device_poweroff_announced'||event.type==='desktop'&&data.state==='stopped'))return {key:'desktop-signal',role:'explained',mode:'poweroff'};
  if(data.source==='https-probe'&&['service_probe_inconclusive','service_probe_suspended'].includes(reason))return {key:serviceProbeSignalKey(text(data.signalResourceId,220)||event.aggregateId),role:'inconclusive',mode:reason==='service_probe_suspended'?'suspended':'inconclusive'};
  const policy=notificationForEvent(event)?.policy;
  if(policy?.lossKey)return {key:policy.lossKey,role:'loss',mode:data.source==='https-probe'?reason==='service_probe_observability_lost'?'observability':'application':'default'};
  if(policy?.recoversKey)return {key:policy.recoversKey,role:'recovery',mode:'recovered'};
  return undefined;
}

export function notificationForEvent(event: DurableEvent): PushNotification | undefined {
  const draft = draftFor(event);
  if (!draft) return undefined;
  const category = draft.category;
  const ttlSeconds = draft.ttlSeconds ?? (category === 'router' || category === 'infrastructure' ? 900 : 600);
  return {
    category, title: text(draft.title, 64), body: text(draft.body, 180),
    tag: draft.tag ?? `infra-${hash(`${event.aggregateId}:${category}`)}`,
    url: draft.url, icon: '/icon-192.png', badge: '/icon-192.png', ttlSeconds,
    ...(draft.policy ? { policy: draft.policy } : {}),
  };
}
