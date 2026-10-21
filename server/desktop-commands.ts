import { randomUUID } from 'node:crypto';

export type PcSystem = 'windows' | 'cachyos';
export type ChannelCommand = 'ping' | 'off' | 'windows' | 'cachyos' | 'default-windows' | 'default-cachyos';
export type ChannelCapability = 'ping' | 'power' | 'boot-default';

/** Qué capacidad declarada por el agente exige cada orden. El agente decide qué sabe hacer; el servidor nunca asume más. */
const REQUIRED: Readonly<Record<ChannelCommand, ChannelCapability>> = {
  ping: 'ping',
  off: 'power',
  windows: 'power',
  cachyos: 'power',
  'default-windows': 'boot-default',
  'default-cachyos': 'boot-default',
};

export const CHANNEL_CAPABILITIES: readonly ChannelCapability[] = ['ping', 'power', 'boot-default'];

export type DeliveredCommand = { id: string; command: ChannelCommand; expectedBootId: string; issuedAt: string };
export type SendResult =
  | { ok: true; deliveryMs: number; ackMs: number }
  | { ok: false; reason: 'unavailable' | 'not-delivered' | 'refused' | 'uncertain' };
export type ChannelAck = { accepted: boolean; bootId: string };
export type ChannelSnapshot = { connected: boolean; lastPollAt: string | null; caps: ChannelCapability[]; lastPingMs: number | null; lastPingAt: string | null };

export type ChannelOptions = {
  now?: () => number;
  /** Plazo para que el agente recoja y confirme la orden antes de caer al camino SSH. */
  ackTimeoutMs?: number;
  /** Tras entregarla, margen extra para recibir la confirmación antes de declarar la orden incierta. */
  deliveredGraceMs?: number;
  /** Cuánto tiempo cuenta como conectado un agente después de su último sondeo. */
  availableMs?: number;
};

type Entry = {
  id: string;
  os: PcSystem;
  command: ChannelCommand;
  expectedBootId: string;
  issuedAt: number;
  deliveredAt?: number;
  state: 'queued' | 'delivered' | 'settled';
  settle: (result: SendResult) => void;
  timers: NodeJS.Timeout[];
};
type Waiter = { caps: ReadonlySet<ChannelCapability>; resolve: (command: DeliveredCommand | null) => void; timer: NodeJS.Timeout };
type Agent = { lastPollAt: number; caps: ChannelCapability[]; lastPingMs: number | null; lastPingAt: number | null };

/**
 * Canal de órdenes iniciado por la PC. El agente mantiene una conexión HTTPS saliente que espera órdenes
 * (long-poll); el panel las entrega por ahí al instante. Es un acelerador: si el agente no está conectado o no
 * confirma, el llamador usa el camino SSH de siempre. Garantiza una sola ejecución: una orden ya entregada
 * nunca se cancela ni se reenvía por otra vía, queda incierta hasta que el estado real la resuelva.
 */
export class DesktopCommandChannel {
  private readonly now: () => number;
  private readonly ackTimeoutMs: number;
  private readonly deliveredGraceMs: number;
  private readonly availableMs: number;
  private readonly agents = new Map<PcSystem, Agent>();
  private readonly waiters = new Map<PcSystem, Waiter>();
  private readonly entries = new Map<string, Entry>();

  constructor(options: ChannelOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 3000;
    this.deliveredGraceMs = options.deliveredGraceMs ?? 5000;
    this.availableMs = options.availableMs ?? 40_000;
  }

  private agent(os: PcSystem): Agent {
    return this.agents.get(os) ?? { lastPollAt: 0, caps: [], lastPingMs: null, lastPingAt: null };
  }

  private touch(os: PcSystem, caps: readonly ChannelCapability[]): void {
    this.agents.set(os, { ...this.agent(os), lastPollAt: this.now(), caps: [...caps] });
  }

  /** ¿Hay un agente de ese sistema conectado y capaz de ejecutar esta orden? */
  available(os: PcSystem, command: ChannelCommand): boolean {
    const agent = this.agents.get(os);
    if (!agent) return false;
    const connected = this.waiters.has(os) || this.now() - agent.lastPollAt < this.availableMs;
    return connected && agent.caps.includes(REQUIRED[command]);
  }

  connected(os: PcSystem): boolean {
    const agent = this.agents.get(os);
    return Boolean(agent) && (this.waiters.has(os) || this.now() - (agent?.lastPollAt ?? 0) < this.availableMs);
  }

  snapshot(os: PcSystem): ChannelSnapshot {
    const agent = this.agent(os);
    return {
      connected: this.connected(os),
      lastPollAt: agent.lastPollAt ? new Date(agent.lastPollAt).toISOString() : null,
      caps: agent.caps,
      lastPingMs: agent.lastPingMs,
      lastPingAt: agent.lastPingAt ? new Date(agent.lastPingAt).toISOString() : null,
    };
  }

  /** Sondeo del agente: devuelve la siguiente orden pendiente o null al agotar la espera. */
  poll(os: PcSystem, caps: ReadonlySet<ChannelCapability>, waitMs: number, signal?: AbortSignal): Promise<DeliveredCommand | null> {
    this.touch(os, [...caps]);
    const previous = this.waiters.get(os);
    if (previous) {
      clearTimeout(previous.timer);
      this.waiters.delete(os);
      previous.resolve(null);
    }
    const queued = [...this.entries.values()].find(entry => entry.os === os && entry.state === 'queued' && caps.has(REQUIRED[entry.command]));
    if (queued) return Promise.resolve(this.deliver(queued));
    return new Promise(resolve => {
      const release = (): void => {
        if (this.waiters.get(os)?.resolve === resolve) this.waiters.delete(os);
        this.touch(os, [...caps]);
        resolve(null);
      };
      const timer = setTimeout(release, Math.max(0, waitMs));
      this.waiters.set(os, { caps, resolve, timer });
      // La conexión del agente se cerró (reinicio, corte de red): suelta SU espera, no la de un sondeo posterior.
      signal?.addEventListener('abort', () => { clearTimeout(timer); release(); }, { once: true });
    });
  }

  private deliver(entry: Entry): DeliveredCommand {
    entry.state = 'delivered';
    entry.deliveredAt = this.now();
    return { id: entry.id, command: entry.command, expectedBootId: entry.expectedBootId, issuedAt: new Date(entry.issuedAt).toISOString() };
  }

  /** Envía una orden al agente. Nunca lanza: informa por qué no pudo usarse el canal. */
  send(os: PcSystem, command: ChannelCommand, expectedBootId: string): Promise<SendResult> {
    if (!this.available(os, command)) return Promise.resolve({ ok: false, reason: 'unavailable' });
    return new Promise<SendResult>(resolve => {
      const entry: Entry = {
        id: randomUUID(), os, command, expectedBootId,
        issuedAt: this.now(), state: 'queued', timers: [],
        settle: result => {
          if (entry.state === 'settled') return;
          entry.state = 'settled';
          entry.timers.forEach(clearTimeout);
          setTimeout(() => this.entries.delete(entry.id), 60_000).unref();
          resolve(result);
        },
      };
      this.entries.set(entry.id, entry);
      const waiter = this.waiters.get(os);
      if (waiter && waiter.caps.has(REQUIRED[command])) {
        clearTimeout(waiter.timer);
        this.waiters.delete(os);
        waiter.resolve(this.deliver(entry));
      }
      entry.timers.push(setTimeout(() => {
        if (entry.state === 'queued') return entry.settle({ ok: false, reason: 'not-delivered' });
        if (entry.state === 'delivered') {
          entry.timers.push(setTimeout(() => entry.settle({ ok: false, reason: 'uncertain' }), this.deliveredGraceMs));
        }
      }, this.ackTimeoutMs));
    });
  }

  /** Confirmación del agente. Devuelve false si la orden no existe, es de otro sistema o el bootId no coincide. */
  ack(os: PcSystem, id: string, ack: ChannelAck): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.os !== os || entry.state !== 'delivered') return false;
    if (!ack.accepted) {
      entry.settle({ ok: false, reason: 'refused' });
      return true;
    }
    if (entry.command !== 'ping' && entry.expectedBootId !== ack.bootId) {
      entry.settle({ ok: false, reason: 'refused' });
      return false;
    }
    const at = this.now();
    const result: SendResult = { ok: true, deliveryMs: (entry.deliveredAt ?? at) - entry.issuedAt, ackMs: at - entry.issuedAt };
    if (entry.command === 'ping') this.agents.set(os, { ...this.agent(os), lastPingMs: result.ackMs, lastPingAt: at });
    entry.settle(result);
    return true;
  }
}
