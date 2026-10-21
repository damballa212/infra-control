import { request } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import type { ChannelCommand, PcSystem, SendResult } from './desktop-commands.js';
import { DesktopOfflineError, UncertainError } from './operation-error.js';
import type { Action, HealthSignal, Resource } from './types.js';
export type DesktopStatus = { ready: boolean; online: boolean; observedAt: string; controlled?: boolean; os?: 'windows' | 'cachyos'; defaultSystem?: 'windows' | 'cachyos'; bootId?: string; source?:'push'; phase?:'running'|'stopping'|'stopped'|'pending'|'unreachable'|'unknown' };
export function desktopResource(status?: DesktopStatus, now = Date.now()): Resource {
  const base: Resource = { id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unknown', account: 'Casa', location: 'Windows / CachyOS', detail: 'Dual boot · WOL por FiberHome', actions: ['refresh'], observedAt: null };
  const unknownHealth: HealthSignal<'unknown'> = { state: 'unknown', source: 'pc-reporter', observedAt: null, reasonCode: 'no_observation' };
  if (!status) return { ...base, health: { presence: unknownHealth, control: { ...unknownHealth, source: 'control-channel' }, service: { ...unknownHealth, source: 'host-services' } } };
  const controlled = status.controlled === true && (status.os === 'windows' || status.os === 'cachyos') && typeof status.bootId === 'string';
  let resource: Resource;
  if (status.source === 'push') resource = {
    ...base, state: status.phase ?? 'unknown', system: status.os, observedAt: status.observedAt,
    actions: controlled ? ['stop', 'boot-windows', 'boot-cachyos', 'refresh'] : ['stopped', 'unreachable', 'unknown'].includes(status.phase ?? 'unknown') ? ['start', 'boot-windows', 'boot-cachyos', 'refresh'] : ['refresh'],
    note: status.phase === 'running' ? 'Estado comunicado por la PC.' : status.phase === 'stopped' ? 'El sistema anunció su apagado.' : status.phase === 'unreachable' ? 'La PC dejó de enviar señales. No confirma que esté apagada.' : status.phase === 'pending' ? 'La PC está reiniciándose.' : status.phase === 'stopping' ? 'La PC anunció que se está apagando.' : 'Esperando el primer aviso de la PC.'
  };
  else resource = {
    ...base, state: status.online ? 'running' : status.ready ? 'unreachable' : 'unknown', observedAt: status.observedAt,
    ...(controlled ? { system: status.os } : {}), actions: controlled ? ['stop', 'boot-windows', 'boot-cachyos', 'refresh'] : status.ready && !status.online ? ['start', 'refresh'] : ['refresh'],
    note: controlled ? `${status.os === 'windows' ? 'Windows' : 'CachyOS'} confirmado por SSH autenticado. Apagar o cambiar de sistema cerrará las sesiones de la PC.` : status.online ? 'SSH responde, pero no se pudo autenticar el controlador. No se habilita apagado ni cambio de sistema.' : status.ready ? 'SSH no responde; no demuestra que esté apagada. Se puede enviar WOL desde el FiberHome.' : 'El túnel del FiberHome no está disponible. No se puede confirmar el estado de la PC.'
  };
  const observedAt = Number.isFinite(Date.parse(status.observedAt)) ? status.observedAt : null;
  const freshUntil = observedAt ? new Date(Date.parse(observedAt) + 45_000).toISOString() : null;
  const presence: HealthSignal<'fresh' | 'stale' | 'unknown'> = {
    state: observedAt ? now - Date.parse(observedAt) < 45_000 ? 'fresh' : 'stale' : 'unknown', source: 'pc-reporter', observedAt, freshUntil,
    ...(observedAt ? { evidence: 'Último aviso firmado por token exclusivo del sistema operativo.' } : { reasonCode: 'no_observation' })
  };
  const control: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'> = {
    state: status.source === 'push' ? controlled ? 'degraded' : 'unknown' : controlled ? 'available' : status.online ? 'degraded' : status.phase === 'unknown' ? 'unknown' : 'unavailable',
    source: status.source === 'push' ? 'pc-reporter' : 'ssh-controller', observedAt,
    reasonCode: controlled ? status.source === 'push' ? 'command_path_not_probed' : 'identity_confirmed' : status.online ? 'identity_unverified' : 'control_not_confirmed',
    ...(status.source === 'push' ? { evidence: 'La PC reporta su identidad. El canal para enviar órdenes aún no se ha probado en esta lectura.' } : {})
  };
  const service: HealthSignal<'unknown'> = { state: 'unknown', source: 'host-services', observedAt: null, reasonCode: 'application_health_not_probed' };
  const allActions: Action[] = ['start', 'stop', 'refresh', 'boot-windows', 'boot-cachyos'];
  const actionAvailability = Object.fromEntries(allActions.map(action => {
    const allowed = resource.actions.includes(action);
    const reasonCode = allowed ? 'available' : ['pending', 'stopping'].includes(resource.state) ? 'transition_in_progress'
      : resource.state === 'running' && action === 'start' ? 'already_running'
        : resource.state === 'stopped' && action !== 'start' && action !== 'refresh' ? 'device_offline'
        : !controlled && action !== 'start' && action !== 'refresh' ? 'identity_not_confirmed' : 'state_does_not_allow_action';
    return [action, { allowed, reasonCode, availableAt: null, observedAt }];
  })) as Resource['actionAvailability'];
  return { ...resource, health: { presence, control, service }, actionAvailability };
}
type Call = (method: 'GET' | 'POST', path: string) => Promise<unknown>;
export type DesktopProgress = (message: string) => void;
export function socketCall(socketPath: string): Call {
  return (method, path) => new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: method === 'POST' ? 25000 : 15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 4096) res.destroy(new Error('Broker response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Broker unavailable'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid broker response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Broker timeout')));
    req.on('error', reject); req.end();
  });
}
/** Canal directo opcional hacia el agente de la PC. Solo acelera: si no puede, el llamador usa el broker SSH. */
export type PowerChannel = {
  available(os: PcSystem, command: ChannelCommand): boolean;
  send(os: PcSystem, command: ChannelCommand, expectedBootId: string): Promise<SendResult>;
};

export class DesktopClient {
  private call: Call;
  constructor(socketPath: string, call?: Call, private pause: (ms: number) => Promise<unknown> = wait, private pushedStatus?:()=>DesktopStatus, private channel?: PowerChannel) { this.call = call ?? socketCall(socketPath); }
  /** Con avisos de la PC la consulta es local (memoria/SQLite): se revisa cada segundo. Sin ellos cada revisión es una llamada SSH y se mantiene el ritmo de 5 s. */
  private pollStep(): number {
    return this.pushedStatus ? 1000 : 5000;
  }
  private statusPath(): string {
    const status=this.pushedStatus?.(), observedAt=status?.observedAt?Date.parse(status.observedAt):NaN, age=Date.now()-observedAt;
    return status?.source==='push'&&status.phase==='running'&&status.controlled===true&&(status.os==='windows'||status.os==='cachyos')&&Number.isFinite(observedAt)&&age>=0&&age<45000
      ? `/status?os=${status.os}` : '/status';
  }
  private withStatusHint(path:string): string {
    const hint=this.statusPath();
    return hint==='/status'?path:`${path}?os=${hint.slice('/status?os='.length)}`;
  }
  async status(): Promise<DesktopStatus> {
    if(this.pushedStatus)return this.pushedStatus();
    const value = await this.call('GET', '/status') as Partial<DesktopStatus> | null;
    if (!value || typeof value.ready !== 'boolean' || typeof value.online !== 'boolean' || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('Invalid desktop status');
    return value as DesktopStatus;
  }
  async checkRouter(): Promise<{ ready: boolean }> {
    const value = await this.call('GET', '/router/status') as { ready?: unknown } | null;
    if (!value || typeof value.ready !== 'boolean') throw new Error('Invalid router status');
    return { ready: value.ready };
  }
  async resource(): Promise<Resource> {
    try {
      return desktopResource(await this.status());
    } catch { return { ...desktopResource(), note: 'No se pudo consultar el controlador privado. No implica que la PC esté apagada.' }; }
  }
  async wake(progress?: DesktopProgress): Promise<{ message: string }> {
    try {
      const sent = await this.call('POST', '/wake') as { sent?: boolean } | null;
      if (sent?.sent !== true) throw new Error('Unacknowledged');
    } catch { throw new UncertainError('No se confirmó la recepción de WOL. Comprueba el estado antes de repetir.'); }
    progress?.('WOL enviado por el FiberHome. Esperando el aviso de arranque de la PC.');
    const deadline = Date.now() + 120000;
    const step = this.pollStep();
    for (let attempt = 0; attempt < Math.ceil(120000 / step) && Date.now() < deadline; attempt++) {
      await this.pause(Math.min(step, deadline - Date.now()));
      if (Date.now() >= deadline) break;
      try {
        const status=await this.status();
        if(status.online){
          const message=status.source==='push'?`${status.os==='windows'?'Windows':'CachyOS'} comunicó su arranque al panel.`:'El FiberHome confirmó WOL y ahora responde SSH en la dirección configurada de la PC. El sistema operativo y el arranque no se han comprobado.';
          progress?.(message);
          return { message };
        }
      }
      catch { /* Read-only checks are bounded; never repeat the WOL write. */ }
    }
    throw new UncertainError(this.pushedStatus ? 'El FiberHome envió WOL, pero la PC no comunicó su arranque durante el plazo de verificación. Comprueba la PC antes de repetir.' : 'El FiberHome envió WOL, pero SSH no respondió durante el plazo de verificación. Comprueba la PC antes de repetir.');
  }
  async setBootDefault(system: 'windows' | 'cachyos'): Promise<{ defaultSystem: 'windows' | 'cachyos'; verifiedAt: string }> {
    let result: { accepted?: boolean; applied?: boolean; verified?: boolean; defaultSystem?: string; verifiedAt?: string } | null;
    try {
      let status:Partial<DesktopStatus>|null;
      try{status=await this.call('GET',this.statusPath()) as Partial<DesktopStatus>|null;}
      catch{throw new DesktopOfflineError('Private control route is unavailable');}
      if(!status?.ready||!status.online||status.controlled!==true||!status.os||!status.bootId)throw new DesktopOfflineError('PC identity is not currently reachable');
      result = await this.call('POST', this.withStatusHint(`/boot-default/${system}`)) as typeof result;
      if (result?.accepted !== true || result.applied !== true || result.verified !== true || result.defaultSystem !== system || !result.verifiedAt || !Number.isFinite(Date.parse(result.verifiedAt))) throw new Error('Unverified boot default');
      return { defaultSystem: system, verifiedAt: result.verifiedAt };
    } catch (error) {
      if (error instanceof DesktopOfflineError) throw error;
      throw new UncertainError('No se confirmó el arranque predeterminado en el firmware. Consulta la preferencia antes de repetir; la PC no se reinició.');
    }
  }
  async readBootDefault(): Promise<{ defaultSystem: 'windows' | 'cachyos'; observedAt: string }> {
    let status: Partial<DesktopStatus> | null;
    try { status=await this.call('GET',this.statusPath()) as Partial<DesktopStatus>|null; }
    catch { throw new DesktopOfflineError('Private control route is unavailable'); }
    if (!status?.ready || !status.online || status.controlled !== true || !status.os || !status.bootId) throw new DesktopOfflineError('PC identity is not currently reachable');
    if ((status.defaultSystem!=='windows'&&status.defaultSystem!=='cachyos')||typeof status.observedAt!=='string'||!Number.isFinite(Date.parse(status.observedAt))) throw new UncertainError('La PC respondió, pero no informó un valor predeterminado UEFI verificable.');
    return { defaultSystem: status.defaultSystem, observedAt: status.observedAt };
  }
  async power(action: 'stop' | 'boot-windows' | 'boot-cachyos', progress?: DesktopProgress): Promise<{ message: string }> {
    const target = action === 'stop' ? 'off' : action === 'boot-windows' ? 'windows' : 'cachyos';
    const initial=this.pushedStatus?.();
    if(target!=='off'&&initial?.source==='push'&&!initial.online){
      const wakingAt=Date.now();
      await this.wake(progress);
      const started=await this.status();
      if(started.controlled&&started.os===target){const message=`La PC encendió en ${target==='windows'?'Windows':'CachyOS'} y avisó al panel.`;progress?.(message);return{message};}
      if(!started.controlled)throw new UncertainError('La PC encendió, pero no confirmó su sistema. Consulta el estado antes de repetir.');
      progress?.(`La PC informó ${started.os==='windows'?'Windows':'CachyOS'}. Preparando el arranque temporal de ${target==='windows'?'Windows':'CachyOS'}; puede requerir un reinicio adicional.`);
      // The broker shares its 30s write cooldown between WOL and power.
      const remaining=31000-(Date.now()-wakingAt);
      if(remaining>0)await this.pause(remaining);
    }
    let before: DesktopStatus | undefined;
    let viaChannel = false;
    const live = this.pushedStatus?.();
    if (this.channel && live?.source === 'push' && live.online && live.controlled === true && live.os && live.bootId) {
      // Orden por el canal directo del agente (también reiniciar en el mismo sistema). Una sola ejecución: si ya se entregó, nunca se reenvía por SSH.
      const sent = await this.channel.send(live.os, target, live.bootId);
      if (sent.ok) { before = live; viaChannel = true; }
      else if (sent.reason === 'uncertain') throw new UncertainError('No se confirmó la recepción de la orden de la PC. Consulta su estado antes de repetir.');
      // 'unavailable' | 'not-delivered' | 'refused': la orden no se ejecutó; se usa el camino SSH de siempre.
    }
    if (!before) {
      try {
        const result = await this.call('POST', this.withStatusHint(`/power/${target}`)) as { accepted?: boolean; before?: DesktopStatus };
        if (result?.accepted !== true || !result.before?.bootId) throw new Error('Missing acknowledgement');
        before = result.before;
      } catch { throw new UncertainError('No se confirmó la recepción de la orden de la PC. Consulta su estado antes de repetir.'); }
    }
    const accepted = before;
    progress?.(viaChannel
      ? (target==='off' ? 'La PC aceptó apagar por el canal directo. Esperando el aviso final del reporter.' : `La PC aceptó por el canal directo preparar ${target==='windows'?'Windows':'CachyOS'}. Esperando un bootId nuevo y la confirmación del sistema.`)
      : target==='off'
      ? 'La PC aceptó apagar el sistema. Esperando el aviso final del reporter.'
      : `La PC aceptó preparar ${target==='windows'?'Windows':'CachyOS'} para el siguiente arranque. Esperando un bootId nuevo y la confirmación del sistema.`);
    const deadline = Date.now() + 240000;
    const step = this.pollStep();
    let absent = 0;
    for (let attempt = 0; attempt < Math.ceil(240000 / step) && Date.now() < deadline; attempt++) {
      await this.pause(step);
      try {
        const status = await this.status();
        if(target==='off'&&status.source==='push'&&status.phase==='stopped'&&status.bootId===accepted.bootId)return{message:'El sistema anunció su apagado al panel. No se mide el corte eléctrico.'};
        if (target === 'off') {
          absent = status.source!=='push'&&status.ready && !status.online ? absent + 1 : 0;
          if (absent >= 2) return { message: 'El sistema confirmó la orden de apagado y SSH dejó de responder. No se mide el corte eléctrico.' };
        } else if (status.controlled && status.os === target && status.bootId && status.bootId !== accepted.bootId) {
          return { message: `${target === 'windows' ? 'Windows' : 'CachyOS'} inició y ${status.source==='push'?'lo comunicó al panel':'fue confirmado por SSH autenticado'} tras el reinicio.` };
        }
      } catch { /* Read-only verification; never repeat a power mutation. */ }
    }
    throw new UncertainError('La PC recibió la orden, pero no se confirmó el resultado durante el plazo de verificación. Consulta su estado antes de repetir.');
  }
}
