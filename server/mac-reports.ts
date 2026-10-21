import type { Store } from './store.js';
import type { HealthSignal, Resource } from './types.js';

export type MacReportEvent = 'online' | 'heartbeat' | 'sleep' | 'wake';
export type MacEvent = { bootId: string; sequence: number; event: MacReportEvent };
export type MacSnapshot = { state: 'unknown' | 'reporting' | 'recovering' | 'sleep-announced' | 'stale'; bootId: string; sequence: number; observedAt: string; freshUntil: string; ageSeconds: number };
type Report = MacEvent & { receivedAt: number };
type Journal = { current?: Report; retiredBoots: string[]; state: MacSnapshot['state']; recoverySamples: number };
const JOURNAL_KEY = 'mac-telemetry';
const FRESHNESS_TTL = 45_000;

export function macResource(snapshot?: MacSnapshot, configured = false): Resource {
  const fresh = snapshot?.state === 'reporting' || snapshot?.state === 'recovering' || snapshot?.state === 'sleep-announced';
  const state = !snapshot ? configured ? 'unknown' : 'unconfigured'
    : snapshot.state === 'reporting' || snapshot.state === 'recovering' ? 'running'
      : snapshot.state === 'sleep-announced' ? 'asleep'
        : snapshot.state === 'stale' ? 'unreachable' : 'unknown';
  const presence: HealthSignal<'fresh' | 'stale' | 'unknown'> = {
    state: fresh ? 'fresh' : snapshot?.state === 'stale' ? 'stale' : 'unknown',
    source: 'mac-reporter', observedAt: snapshot?.observedAt ?? null,
    freshUntil: snapshot?.freshUntil ?? null,
    reasonCode: snapshot?.state === 'sleep-announced' ? 'sleep_announced' : snapshot?.state === 'stale' ? 'telemetry_timeout' : snapshot ? 'recent_report' : 'no_report'
  };
  const unknown: HealthSignal<'unknown'> = { state: 'unknown', source: 'not-probed', observedAt: null, reasonCode: 'not_measured' };
  return {
    id: 'computer:mac', name: 'MacBook', kind: 'computer', state,
    account: 'Personal', location: 'macOS', detail: 'Apple Silicon · reporter saliente',
    actions: [], observedAt: snapshot?.observedAt ?? null,
    note: snapshot?.state === 'sleep-announced'
      ? 'La Mac anunció que entraría en reposo. El aviso no confirma que la suspensión se completara.'
      : snapshot?.state === 'stale'
        ? 'El último aviso venció. Puede ser suspensión, tapa cerrada, apagado o pérdida de red.'
        : !snapshot && !configured
          ? 'Reporter no configurado; no hay una lectura actual.'
          : !snapshot
            ? 'Reporter configurado, pero todavía no ha llegado su primer aviso.'
            : 'La Mac informa presencia por HTTPS. No se consultan ni controlan sus servicios.',
    health: { presence, control: unknown, service: unknown }
  };
}

export class MacReports {
  private expiryTimer?: NodeJS.Timeout;
  constructor(private store: Store, private now = Date.now, private configured = false) {
    const journal = this.read();
    if (journal.current && this.now() - journal.current.receivedAt >= FRESHNESS_TTL && journal.state !== 'stale') this.setState(journal, 'stale');
    this.scheduleExpiry();
  }
  private read(): Journal {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(JOURNAL_KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Journal : { state: 'unknown', recoverySamples: 0, retiredBoots: [] };
  }
  private write(journal: Journal): void {
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(JOURNAL_KEY, JSON.stringify(journal));
  }
  private snapshot(journal = this.read()): MacSnapshot | undefined {
    const current = journal.current;
    if (!current) return undefined;
    const age = Math.max(0, this.now() - current.receivedAt);
    return {
      state: age >= FRESHNESS_TTL ? 'stale' : journal.state, bootId: current.bootId, sequence: current.sequence,
      observedAt: new Date(current.receivedAt).toISOString(), freshUntil: new Date(current.receivedAt + FRESHNESS_TTL).toISOString(),
      ageSeconds: Math.floor(age / 1000)
    };
  }
  private setState(journal: Journal, state: MacSnapshot['state'], reasonCode = 'presence_changed'): void {
    journal.state = state;
    this.store.atomic(() => {
      this.write(journal);
      const resource = macResource(this.snapshot(journal));
      this.store.appendEvent('resource', resource.id, { ...resource, transitionReason: reasonCode } as unknown as Record<string, unknown>);
    });
  }
  accept(event: MacEvent): boolean {
    const journal = this.read(), old = journal.current;
    if (!old && event.event !== 'online') return false;
    if (journal.retiredBoots.includes(event.bootId)) return false;
    if (old && old.bootId === event.bootId) {
      if (event.sequence < old.sequence) return false;
      if (event.sequence === old.sequence) return event.event === old.event;
    } else if (old) {
      if (event.event !== 'online') return false;
      journal.retiredBoots = [...journal.retiredBoots, old.bootId].slice(-64);
    }
    const previousState = journal.state, bootChanged = Boolean(old && old.bootId !== event.bootId);
    journal.current = { ...event, receivedAt: this.now() };
    if (event.event === 'sleep') {
      journal.recoverySamples = 0;
      journal.state = 'sleep-announced';
    } else if (journal.state === 'stale' || journal.state === 'recovering') {
      journal.recoverySamples++;
      journal.state = journal.recoverySamples >= 2 ? 'reporting' : 'recovering';
    } else {
      journal.recoverySamples = 0;
      journal.state = 'reporting';
    }
    if (previousState !== journal.state || bootChanged) {
      const reason = bootChanged ? 'mac_boot_changed'
        : event.event === 'sleep' ? 'mac_sleep_announced'
          : event.event === 'wake' && journal.state === 'recovering' ? 'mac_wake_recovering'
            : event.event === 'wake' ? 'mac_wake_reported'
              : journal.state === 'recovering' ? 'telemetry_recovering'
                : previousState === 'stale' || previousState === 'recovering' ? 'telemetry_recovered' : 'first_report';
      this.setState(journal, journal.state, reason);
    }
    else this.write(journal);
    this.scheduleExpiry();
    return true;
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const current = this.read().current;
    if (!current || this.now() - current.receivedAt >= FRESHNESS_TTL) return;
    const expected = current.bootId + ':' + current.sequence + ':' + current.receivedAt;
    this.expiryTimer = setTimeout(() => {
      const journal = this.read(), latest = journal.current;
      if (latest && latest.bootId + ':' + latest.sequence + ':' + latest.receivedAt === expected && this.now() - latest.receivedAt >= FRESHNESS_TTL && journal.state !== 'stale') {
        journal.recoverySamples = 0;
        this.setState(journal, 'stale', 'telemetry_timeout');
      }
      this.scheduleExpiry();
    }, Math.max(0, current.receivedAt + FRESHNESS_TTL - this.now()));
    this.expiryTimer.unref();
  }
  status(): MacSnapshot | undefined { return this.snapshot(); }
  resource(): Resource { return macResource(this.status(), this.configured); }
  close(): void { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
}
