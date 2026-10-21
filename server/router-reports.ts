import type { Store } from './store.js';
import type { HealthSignal, Resource } from './types.js';

export type RouterSample = {
  version: 1;
  bootId: string;
  streamId: string;
  sequence: number;
  uptimeSeconds: number;
  cpuPercent: number | null;
  memTotalBytes: number;
  memAvailableBytes: number;
};
export type RouterTelemetryState = 'unknown' | 'reporting' | 'recovering' | 'stale';
export type RouterSnapshot = RouterSample & { state: RouterTelemetryState; observedAt: string; freshUntil: string; ageSeconds: number };
export type RouterTunnelProbe = { state: 'available' | 'unavailable'; source: 'ssh-router-check'; observedAt: string; freshUntil: string; ageSeconds: number; reasonCode: 'router_check_succeeded' | 'router_check_failed' };
type Current = { sample: RouterSample; receivedAt: number };
type Journal = { current?: Current; tunnelProbe?: { available: boolean; receivedAt: number }; state: RouterTelemetryState; recoverySamples: number; retiredBoots: string[]; retiredStreams: string[]; alertedAt?: number };
const JOURNAL_KEY = 'router-telemetry';
const FRESHNESS_TTL = 45_000;
const ALERT_DELAY = 90_000;
const TUNNEL_PROBE_TTL = 30_000;

export function routerResource(snapshot?: RouterSnapshot, tunnelProbe?: RouterTunnelProbe, canCheckTunnel = false): Resource {
  const base: Resource = { id: 'router:fiberhome', name: 'FiberHome', kind: 'router', state: snapshot?.state ?? 'unknown', account: 'Casa', location: 'Red de casa', detail: 'SR1021D · telemetría del túnel privado', actions: canCheckTunnel ? ['refresh'] : [], observedAt: snapshot?.observedAt ?? null };
  const note = tunnelProbe?.state === 'unavailable'
    ? 'El último sondeo del túnel no respondió. Esto no confirma que el router esté apagado ni una caída de Internet.'
    : tunnelProbe?.state === 'available' && (!snapshot || snapshot.state === 'stale')
      ? 'El FiberHome respondió por el túnel privado, pero la telemetría está ausente o vencida. WAN e Internet no se midieron.'
      : snapshot
        ? 'Estado vivo recibido por el túnel privado. La conexión WAN e Internet no se miden con esta telemetría.'
        : 'Aún no se ha recibido telemetría por el túnel privado.';
  const presence: HealthSignal<'fresh' | 'stale' | 'unknown'> = {
    state: snapshot?.state === 'reporting' || snapshot?.state === 'recovering' ? 'fresh' : snapshot?.state === 'stale' ? 'stale' : 'unknown',
    source: 'ssh-telemetry', observedAt: snapshot?.observedAt ?? null, freshUntil: snapshot?.freshUntil ?? null,
    reasonCode: snapshot?.state === 'stale' ? 'telemetry_timeout' : snapshot ? 'recent_report' : 'no_report'
  };
  const tunnel: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'> = tunnelProbe ? {
    state: tunnelProbe.state, source: tunnelProbe.source, observedAt: tunnelProbe.observedAt,
    freshUntil: tunnelProbe.freshUntil, reasonCode: tunnelProbe.reasonCode
  } : {
    state: snapshot?.state === 'reporting' ? 'available' : snapshot?.state === 'recovering' ? 'degraded' : 'unknown',
    source: 'ssh-reverse-tunnel', observedAt: snapshot?.observedAt ?? null,
    reasonCode: snapshot?.state === 'reporting' ? 'telemetry_stream_open' : snapshot?.state === 'recovering' ? 'awaiting_second_sample' : 'no_current_probe'
  };
  const unknown = (source: string): HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'> => ({ state: 'unknown', source, observedAt: null, reasonCode: 'not_measured' });
  return {
    ...base,
    note,
    health: { presence, telemetry: presence, tunnel, cwmp: unknown('genieacs'), wanLink: unknown('router-interface'), internetProbe: unknown('internet-probe') }
  };
}

export class RouterReports {
  private expiryTimer?: NodeJS.Timeout;
  constructor(private store: Store, private now = Date.now, private canCheckTunnel = false) {
    const journal = this.read();
    if (journal.current && this.now() - journal.current.receivedAt >= FRESHNESS_TTL && journal.state !== 'stale') this.setState(journal, 'stale', 'telemetry_stale');
    this.scheduleExpiry();
  }

  private read(): Journal {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(JOURNAL_KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Journal : { state: 'unknown', recoverySamples: 0, retiredBoots: [], retiredStreams: [] };
  }

  private write(journal: Journal): void {
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(JOURNAL_KEY, JSON.stringify(journal));
  }

  private snapshot(journal = this.read()): RouterSnapshot | undefined {
    const current = journal.current;
    if (!current) return undefined;
    const now = this.now(), age = Math.max(0, now - current.receivedAt);
    const state = age >= FRESHNESS_TTL ? 'stale' : journal.state;
    return { ...current.sample, state, observedAt: new Date(current.receivedAt).toISOString(), freshUntil: new Date(current.receivedAt + FRESHNESS_TTL).toISOString(), ageSeconds: Math.floor(age / 1000) };
  }

  private tunnelProbeSnapshot(journal = this.read()): RouterTunnelProbe | undefined {
    const probe = journal.tunnelProbe;
    if (!probe) return undefined;
    const age = Math.max(0, this.now() - probe.receivedAt);
    if (age >= TUNNEL_PROBE_TTL) return undefined;
    return {
      state: probe.available ? 'available' : 'unavailable', source: 'ssh-router-check',
      observedAt: new Date(probe.receivedAt).toISOString(),
      freshUntil: new Date(probe.receivedAt + TUNNEL_PROBE_TTL).toISOString(), ageSeconds: Math.floor(age / 1000),
      reasonCode: probe.available ? 'router_check_succeeded' : 'router_check_failed'
    };
  }

  recordTunnelProbe(available: boolean): RouterTunnelProbe {
    const journal = this.read();
    const previous = journal.tunnelProbe?.available;
    journal.tunnelProbe = { available, receivedAt: this.now() };
    const probe = this.tunnelProbeSnapshot(journal)!;
    this.store.atomic(() => {
      this.write(journal);
      if (previous === undefined || previous !== available) {
        const resource = routerResource(this.snapshot(journal), probe, this.canCheckTunnel);
        this.store.appendEvent('resource', resource.id, {
          ...resource,
          transitionReason: available ? 'router_tunnel_probe_succeeded' : 'router_tunnel_probe_failed'
        } as unknown as Record<string, unknown>);
      }
    });
    return probe;
  }

  tunnelProbe(): RouterTunnelProbe | undefined { return this.tunnelProbeSnapshot(); }

  private setState(journal: Journal, state: RouterTelemetryState, reasonCode: string, bootChanged = false): void {
    journal.state = state;
    this.store.atomic(() => {
      this.write(journal);
      const snapshot = this.snapshot(journal);
      const resource = routerResource(snapshot, this.tunnelProbeSnapshot(journal), this.canCheckTunnel);
      this.store.appendEvent('resource', resource.id, { ...resource, transitionReason: reasonCode, ...(bootChanged ? { bootChanged: true } : {}) } as unknown as Record<string, unknown>);
    });
  }

  accept(sample: RouterSample): boolean {
    const journal = this.read(), old = journal.current;
    if (journal.retiredStreams.includes(sample.streamId) || journal.retiredBoots.includes(sample.bootId)) return false;
    let bootChanged = false;
    if (old) {
      const sameStream = old.sample.streamId === sample.streamId;
      if (sameStream) {
        if (sample.sequence < old.sample.sequence) return false;
        if (sample.sequence === old.sample.sequence) return JSON.stringify(sample) === JSON.stringify(old.sample);
      } else {
        if (sample.sequence !== 1) return false;
        journal.retiredStreams = [...journal.retiredStreams, old.sample.streamId].slice(-64);
      }
      if (old.sample.bootId !== sample.bootId) {
        if (journal.retiredBoots.includes(sample.bootId)) return false;
        journal.retiredBoots = [...journal.retiredBoots, old.sample.bootId].slice(-64);
        bootChanged = true;
      }
    } else if (sample.sequence !== 1) return false;

    journal.current = { sample, receivedAt: this.now() };
    if (journal.state === 'stale' || journal.state === 'recovering') {
      journal.recoverySamples++;
      const next = journal.recoverySamples >= 2 ? 'reporting' : 'recovering';
      const wasAlerted = Boolean(journal.alertedAt);
      if (next === 'reporting') journal.alertedAt = undefined;
      this.setState(journal, next, next === 'reporting' ? wasAlerted ? 'telemetry_recovered' : 'telemetry_recovered_unalerted' : 'recovery_probe', bootChanged);
    } else if (journal.state === 'unknown' || bootChanged) {
      journal.recoverySamples = 0;
      this.setState(journal, 'reporting', bootChanged ? 'router_reboot_observed' : 'first_report', bootChanged);
    } else {
      journal.state = 'reporting';
      journal.recoverySamples = 0;
      this.write(journal);
    }
    this.scheduleExpiry();
    return true;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const journal = this.read(), current = journal.current;
    if (!current) return;
    const age = this.now() - current.receivedAt;
    const boundary = age < FRESHNESS_TTL ? FRESHNESS_TTL
      : journal.state === 'stale' && !journal.alertedAt ? ALERT_DELAY : undefined;
    if (boundary === undefined) return;
    const expected = `${current.sample.bootId}:${current.sample.streamId}:${current.sample.sequence}:${current.receivedAt}`;
    this.expiryTimer = setTimeout(() => {
      const journal = this.read(), latest = journal.current;
      if (latest && `${latest.sample.bootId}:${latest.sample.streamId}:${latest.sample.sequence}:${latest.receivedAt}` === expected) {
        const currentAge = this.now() - latest.receivedAt;
        if (currentAge >= FRESHNESS_TTL && journal.state !== 'stale') {
          journal.recoverySamples = 0;
          this.setState(journal, 'stale', 'telemetry_stale');
        } else if (currentAge >= ALERT_DELAY && journal.state === 'stale' && !journal.alertedAt) {
          this.store.atomic(() => {
            journal.alertedAt = this.now();
            this.write(journal);
            this.store.appendEvent('incident', 'router:fiberhome', {
              category: 'infrastructure', resourceId: 'router:fiberhome', resourceName: 'FiberHome',
              from: 'reporting', to: 'stale', transitionReason: 'telemetry_timeout', silenceSeconds: Math.floor(currentAge / 1000)
            });
          });
        }
      }
      this.scheduleExpiry();
    }, Math.max(0, current.receivedAt + boundary - this.now()));
    this.expiryTimer.unref();
  }

  status(): RouterSnapshot | undefined { return this.snapshot(); }
  resource(): Resource { return routerResource(this.status(), this.tunnelProbe(), this.canCheckTunnel); }
  close(): void { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
}
