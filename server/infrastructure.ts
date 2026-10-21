import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { setTimeout as wait } from 'node:timers/promises';
import { SharedCache } from './cache.js';
import { DesktopClient } from './desktop.js';
import { routerResource, type RouterSnapshot, type RouterTunnelProbe } from './router-reports.js';
import { macResource, type MacSnapshot } from './mac-reports.js';
import type { HermesSnapshot } from './hermes-reports.js';
import { UncertainError } from './operation-error.js';
import type { Action, Adapter, AwsAccount, Config, HealthSignal, Resource } from './types.js';

export { UncertainError } from './operation-error.js';
export type Transport = { ec2(account: AwsAccount, region: string, maxAttempts?: number): Pick<EC2Client, 'send'>; fetch: typeof fetch; wait: (ms: number) => Promise<unknown>; now: () => number };
const transport: Transport = { ec2: (account, region, maxAttempts = 2) => new EC2Client({ region, credentials: account, maxAttempts, requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 } }), fetch, wait, now: () => Date.now() };
const devicePaths = ['InternetGatewayDevice.DeviceInfo.ModelName', 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'InternetGatewayDevice.ManagementServer.PeriodicInformInterval'];
export function leaf(data: unknown, path: string): unknown {
  let value: unknown = data;
  for (const key of path.split('.')) { if (!value || typeof value !== 'object') return undefined; value = (value as Record<string, unknown>)[key]; }
  return value && typeof value === 'object' && '_value' in value ? value._value : value;
}
export class InfrastructureAdapter implements Adapter {
  private cache: SharedCache;
  private clients = new Map<string, Pick<EC2Client, 'send'>>();
  private lastRouterTask = 0;
  private cooldown = new Map<string, number>();
  private desktop?: DesktopClient;
  constructor(private config: Config, private io: Transport = transport, desktop?: DesktopClient, private routerTelemetry?: () => RouterSnapshot | undefined, private macTelemetry?: () => MacSnapshot | undefined, private hermesTelemetry?: () => HermesSnapshot | undefined, private routerProbe?: () => RouterTunnelProbe | undefined) { this.cache = new SharedCache(io.now); this.desktop = desktop ?? (config.desktop ? new DesktopClient(config.desktop.socketPath) : undefined); }
  private client(account: AwsAccount, region: string, maxAttempts = 2) {
    const key = `${account.name}:${region}:${maxAttempts}`;
    if (!this.clients.has(key)) this.clients.set(key, this.io.ec2(account, region, maxAttempts));
    return this.clients.get(key)!;
  }
  private withHermesHealth(resource: Resource): Resource {
    if (resource.id !== this.config.hermes?.resourceId) return resource;
    const snapshot=this.hermesTelemetry?.();
    const state: HealthSignal<'healthy'|'degraded'|'unhealthy'|'unknown'>['state']=snapshot?.state==='healthy'?'healthy':snapshot?.state==='unhealthy'?'unhealthy':snapshot?.state==='stale'?'degraded':'unknown';
    return {
      ...resource,
      health:{...resource.health,service:{state,source:'hermes-systemd-reporter',observedAt:snapshot?.observedAt??null,reasonCode:snapshot?.reasonCode??'no_hermes_report',...(snapshot?{evidence:`systemd=${snapshot.serviceState}; restarts=${snapshot.restartCount}; age=${snapshot.ageSeconds}s`}:{})}}
    };
  }
  private async json(url: string, init: RequestInit = {}) {
    const provider = new URL(url).origin;
    if ((this.cooldown.get(provider) ?? 0) > this.io.now()) throw new Error('Provider cooldown');
    const response = await this.io.fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
    if (response.status === 429 || response.status === 503) {
      const raw = response.headers.get('Retry-After');
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.max(0, (Date.parse(raw) - this.io.now()) / 1000) : 60;
      this.cooldown.set(provider, this.io.now() + (Number.isFinite(seconds) ? Math.max(60, seconds) : 60) * 1000);
    }
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
    return response.json();
  }
  private async aws(account: AwsAccount, region: string): Promise<Resource[]> {
    const configured = account.instances.filter(item => item.region === region);
    const base = (item: typeof configured[number]): Resource => ({ id: `aws:${account.name}:${item.id}`, name: item.name, kind: 'ec2', state: 'unknown', account: account.name, location: region, detail: item.type, actions: [], observedAt: null });
    try {
      const resources=await this.cache.get(`aws:${account.name}:${region}`, 60000, async () => {
        const response = await this.client(account, region).send(new DescribeInstancesCommand({ InstanceIds: configured.map(item => item.id) }));
        const instances = response.Reservations?.flatMap(item => item.Instances ?? []) ?? [];
        return configured.map(item => {
          const instance = instances.find(instance => instance.InstanceId === item.id);
          if (!instance) return { ...base(item), note: 'AWS no devolvió esta instancia configurada. No hay una observación de su estado.' };
          const state = instance?.State?.Name ?? 'unknown';
          return { ...base(item), state, observedAt: new Date(this.io.now()).toISOString(), actions: state === 'running' ? ['stop', 'refresh'] : state === 'stopped' ? ['start', 'refresh'] : ['refresh'], note: item.name === 'orchestrator' ? 'Hermes · Apagar esta EC2 detiene también al orquestador. El panel seguirá disponible.' : 'El estado de EC2 no verifica las aplicaciones que ejecuta.' } satisfies Resource;
        });
      });
      return resources.map(resource=>this.withHermesHealth(resource));
    } catch { return configured.map(item => this.withHermesHealth({ ...base(item), note: 'No se pudo consultar AWS. Se volverá a intentar tras el período de espera.' })); }
  }
  private async coolify(): Promise<Resource[]> {
    const base = (item: Config['coolify']['resources'][number]): Resource => ({ id: `coolify:${item.uuid}`, name: item.name, kind: 'service', state: 'unknown', account: 'Coolify', location: 'VPS · provider', detail: item.type === 'service' ? 'Servicio Docker' : 'Aplicación', actions: [], observedAt: null });
    try {
      return await this.cache.get('coolify', 60000, async () => {
        const rows = await this.json(`${this.config.coolify.url}/api/v1/resources`, { headers: { Authorization: `Bearer ${this.config.coolify.token}` } }) as { uuid: string; status: string }[];
        return this.config.coolify.resources.map(item => {
          const row = rows.find(row => row.uuid === item.uuid);
          if (!row) return { ...base(item), note: 'Coolify no devolvió este recurso configurado. No hay una observación de su estado.' };
          return { ...base(item), state: row?.status ?? 'unknown', observedAt: new Date(this.io.now()).toISOString(), actions: ['refresh'], note: 'Estado reportado por Coolify. Control de despliegues pendiente de habilitar.' } satisfies Resource;
        });
      });
    } catch { return this.config.coolify.resources.map(item => ({ ...base(item), note: 'Coolify no está disponible o ha limitado las solicitudes. Sin reintentos durante 60 s.' })); }
  }
  private async device() {
    const query = new URLSearchParams({ query: JSON.stringify({ _id: this.config.acs.deviceId }), projection: ['_id', '_lastInform', ...devicePaths].join(',') });
    const devices = await this.json(`${this.config.acs.url}/devices/?${query}`) as Record<string, unknown>[];
    if (!devices[0]) throw new Error('CPE not registered');
    return devices[0];
  }
  private withRouterTelemetry(base: Resource): Resource {
    const snapshot=this.routerTelemetry?.(), probe=this.routerProbe?.(), telemetry=routerResource(snapshot,probe,Boolean(this.desktop));
    const acsObservedAt=base.observedAt, acsAge=acsObservedAt?this.io.now()-Date.parse(acsObservedAt):Infinity;
    const acsFresh=Number.isFinite(acsAge)&&acsAge>=0&&acsAge<180000;
    const telemetryFresh=snapshot?.state==='reporting'||snapshot?.state==='recovering';
    const newestObservedAt=telemetryFresh?snapshot!.observedAt:acsFresh?acsObservedAt:telemetry.observedAt??acsObservedAt;
    const presenceState=telemetryFresh||acsFresh?'fresh':snapshot?.state==='stale'||base.state==='stale'?'stale':'unknown';
    const presence={state:presenceState,source:telemetryFresh?'ssh-telemetry':acsFresh?'cwmp-inform':'router-observation',observedAt:newestObservedAt,freshUntil:telemetryFresh?snapshot!.freshUntil:acsFresh?new Date(Date.parse(acsObservedAt!)+180000).toISOString():null,reasonCode:telemetryFresh?'router_stream_fresh':acsFresh?'recent_inform':presenceState==='stale'?'no_recent_signal':'no_observation'} as const;
    const cwmpState:HealthSignal<'available'|'degraded'|'unavailable'|'unknown'>['state']=acsFresh?'available':base.state==='stale'?'degraded':base.state==='unknown'?'unknown':'degraded';
    const cwmp:HealthSignal<'available'|'degraded'|'unavailable'|'unknown'>={state:cwmpState,source:'genieacs-inform',observedAt:acsObservedAt,reasonCode:acsFresh?'recent_inform':base.state==='stale'?'inform_stale':'not_verified'};
    const health:Resource['health']={...telemetry.health,presence,cwmp};
    if(telemetryFresh)return{...base,state:snapshot!.state,observedAt:snapshot!.observedAt,actions:this.desktop?['refresh']:base.actions,health,note:probe?.state==='unavailable'?telemetry.note:`El FiberHome reporta por túnel privado. CWMP ${acsFresh?'también está reciente':'no se ha confirmado reciente'}; WAN e Internet no se infieren.`};
    const staleTelemetry=snapshot?.state==='stale';
    return{...base,actions:this.desktop?['refresh']:base.actions,...(staleTelemetry&&base.state==='unknown'?{state:'stale',observedAt:snapshot!.observedAt}:{}),...(probe?{note:telemetry.note}:{}),health};
  }
  private async router(): Promise<Resource> {
    const base: Resource = { id: 'router:fiberhome', name: 'FiberHome', kind: 'router', state: 'unknown', account: 'Casa', location: 'Red de casa', detail: 'SR1021D · CWMP', actions: [], observedAt: null };
    try {
      const acs=await this.cache.get('router', 60000, async () => {
        const data = await this.device();
        const last = typeof data._lastInform === 'string' ? data._lastInform : null;
        const recent = last !== null && Number.isFinite(Date.parse(last)) && this.io.now() - Date.parse(last) < 180000;
        return { ...base, state: recent ? 'reporting' : 'stale', observedAt: last, detail: `${leaf(data, devicePaths[0]) ?? 'SR1021D'} · ${leaf(data, devicePaths[1]) ?? 'Firmware sin consultar'}`, actions: recent ? ['refresh'] : [], note: recent ? 'Gestión remota sin PC en casa. Reportes cada 60 s; consultar no reinicia Internet.' : 'No llegan reportes recientes. Esto no demuestra una caída de Internet.' } satisfies Resource;
      });
      return this.withRouterTelemetry(acs);
    } catch { return this.withRouterTelemetry({ ...base, note: 'No se pudo consultar el servidor ACS. No implica que el router esté apagado.' }); }
  }
  private cloudRequests():Promise<Resource[]>[] {
    const requests: Promise<Resource[]>[] = this.config.aws.flatMap(account => [...new Set(account.instances.map(item => item.region))].map(region => this.aws(account, region)));
    if (this.config.coolify.url) requests.push(this.coolify());
    return requests;
  }
  async cloudInventory():Promise<Resource[]> {
    return (await Promise.all(this.cloudRequests())).flat();
  }
  async inventory(): Promise<Resource[]> {
    const requests: Promise<Resource[]>[] = this.cloudRequests();
    if (this.config.acs.url) requests.push(this.router().then(router => [router]));
    else if (this.routerTelemetry) requests.push(Promise.resolve([this.withRouterTelemetry(routerResource(this.routerTelemetry(),this.routerProbe?.(),Boolean(this.desktop)))]));
    if (this.desktop) requests.push((this.config.desktop?.reportTokenHashes?this.desktop.resource():this.cache.get('desktop', 60000, () => this.desktop!.resource())).then(pc => [pc]));
    const groups = await Promise.all(requests);
    return [...groups.flat(),
      ...(!this.desktop ? [{ id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unconfigured', account: 'Casa', location: 'Windows / CachyOS', detail: 'Dual boot', actions: [], observedAt: null, note: 'Control de encendido pendiente de configurar. Linux offline no significa PC apagada.' } satisfies Resource] : []),
      ...(this.macTelemetry ? [macResource(this.macTelemetry(), true)] : [{ id: 'computer:mac', name: 'MacBook', kind: 'computer', state: 'unconfigured', account: 'Personal', location: 'macOS', detail: 'Apple Silicon', actions: [], observedAt: null, note: 'Reporter saliente pendiente de configurar. Sin agente no hay una lectura actual.' } satisfies Resource])
    ];
  }
  async perform(resource: Resource, action: Action, onProgress?: (message: string) => void): Promise<{ message: string }> {
    if (resource.id === 'computer:desktop' && this.desktop) {
      if (action === 'start' || action === 'stop' || action === 'boot-windows' || action === 'boot-cachyos') {
        try { return await (action === 'start' ? this.desktop.wake(onProgress) : this.desktop.power(action, onProgress)); }
        finally { this.cache.invalidate('desktop'); }
      }
      if (action === 'refresh') {
        this.cache.invalidate('desktop');
        const pc = await this.desktop.resource();
        if (pc.state === 'unknown') throw new Error('Desktop unavailable');
        return { message: this.config.desktop?.reportTokenHashes ? 'Último aviso de la PC leído. No se realizó una consulta al equipo.' : 'Estado SSH consultado. La ausencia de respuesta no demuestra que la PC esté apagada.' };
      }
      throw new Error('Unsupported operation');
    }
    if (resource.kind === 'ec2') {
      if (action !== 'start' && action !== 'stop' && action !== 'refresh') throw new Error('Unsupported operation');
      const [, profile, id] = resource.id.split(':');
      const account = this.config.aws.find(account => account.name === profile);
      const instance = account?.instances.find(item => item.id === id);
      if (!account || !instance) throw new Error('Resource not permitted');
      if (action === 'refresh') {
        const rows = await this.aws(account, instance.region);
        if (!rows.some(item => item.id === resource.id && item.state !== 'unknown')) throw new Error('Inventory unavailable');
        return { message: 'Estado consultado en AWS. Se respeta la caché compartida de 60 segundos.' };
      }
      const client = this.client(account, instance.region);
      // Power mutations are not retried: on ambiguous network errors we do not
      // risk repeating a write. State verification is bounded and independent.
      const input = { InstanceIds: [id] };
      try { await this.client(account, instance.region, 1).send(action === 'start' ? new StartInstancesCommand(input) : new StopInstancesCommand(input), { requestTimeout: 15000 }); }
      catch { throw new UncertainError('AWS no confirmó la recepción de la orden. Comprueba el estado antes de repetir.'); }
      const target = action === 'start' ? 'running' : 'stopped';
      for (let attempt = 0; attempt < 12; attempt++) {
        await this.io.wait(15000);
        try {
          const result = await client.send(new DescribeInstancesCommand(input));
          if (result.Reservations?.some(reservation => reservation.Instances?.some(item => item.InstanceId === id && item.State?.Name === target))) {
            return { message: action === 'start' ? 'AWS confirmó la instancia encendida. La salud de sus aplicaciones no se ha comprobado.' : 'AWS confirmó la instancia detenida.' };
          }
        } catch { /* Bounded state checks continue; no power command is repeated. */ }
      }
      throw new UncertainError('AWS recibió la orden, pero no confirmó el estado final en 3 minutos. Comprueba la instancia.');
    }
    if (resource.kind === 'service' && action === 'refresh') {
      const resources = await this.coolify();
      if (!resources.some(item => item.id === resource.id && item.state !== 'unknown')) throw new Error('Coolify unavailable');
      return { message: 'Estado consultado en Coolify. Se respeta la caché compartida de 60 segundos.' };
    }
    if (resource.id === 'router:fiberhome' && action === 'refresh') {
      if (this.lastRouterTask && this.io.now() - this.lastRouterTask < 120000) throw new UncertainError('Ya se solicitó una lectura al router hace menos de 2 minutos. Espera al siguiente reporte.');
      this.lastRouterTask = this.io.now();
      const sentAt = this.io.now();
      let task: { _id?: string };
      try {
        task = await this.json(`${this.config.acs.url}/devices/${encodeURIComponent(this.config.acs.deviceId)}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'getParameterValues', parameterNames: devicePaths }) }) as { _id?: string };
      } catch { throw new UncertainError('ACS no confirmó la recepción de la lectura. Puede haber quedado encolada; espera al próximo reporte antes de repetir.'); }
      if (!task._id) throw new UncertainError('ACS no devolvió un identificador de tarea. Comprueba el próximo reporte antes de repetir.');
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.io.wait(15000);
        try {
          const data = await this.device();
          const tasks = await this.json(`${this.config.acs.url}/tasks/?${new URLSearchParams({ query: JSON.stringify({ _id: task._id }), projection: '_id' })}`) as { _id: string }[];
          const parameters = devicePaths.map(path => {
            let value: unknown = data;
            for (const key of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
            return value as { _value?: unknown; _timestamp?: string } | undefined;
          });
          const fresh = parameters.every(value => value?._timestamp && Date.parse(value._timestamp) >= sentAt - 1000);
          if (tasks.length === 0 && fresh && parameters[0]?._value === 'SR1021D' && typeof parameters[1]?._value === 'string' && typeof parameters[2]?._value === 'number' && parameters[2]._value > 0) return { message: 'ACS completó la tarea y el FiberHome devolvió modelo, firmware e intervalo de reporte actualizados. Internet no se reinició.' };
        } catch { /* Already queued: retain uncertainty, bounded checks, no duplicate POST. */ }
      }
      throw new UncertainError('La lectura quedó encolada en ACS, pero no se confirmó dentro de 150 segundos. No se reinició el router.');
    }
    throw new Error('Unsupported operation');
  }
  async setBootDefault(system: 'windows' | 'cachyos'): Promise<{ defaultSystem: 'windows' | 'cachyos'; verifiedAt: string }> {
    if (!this.desktop) throw new Error('PC control unavailable');
    return this.desktop.setBootDefault(system);
  }
  async checkRouter(): Promise<{ ready: boolean }> {
    if (!this.desktop) throw new Error('Router check is not configured');
    return this.desktop.checkRouter();
  }
  async readBootDefault(): Promise<{ defaultSystem: 'windows' | 'cachyos'; observedAt: string }> {
    if (!this.desktop) throw new Error('PC control unavailable');
    return this.desktop.readBootDefault();
  }
}
