import type { Store } from './store.js';
import type { DesktopStatus } from './desktop.js';
import { desktopResource } from './desktop.js';

export type PcEvent = { bootId: string; sequence: number; event: 'online' | 'heartbeat' | 'poweroff' | 'reboot' | 'stopping' };
type Report = PcEvent & { os: 'windows' | 'cachyos'; receivedAt: number; phaseEvent: PcEvent['event']; phaseAt: number };
type Journal = { current?: Report; retired: string[]; publishedKey?: string };
const PRESENCE_TTL = 45_000;
const POWER_OFF_GRACE = 12_000;

export class DesktopReports {
  private listeners = new Set<() => void>();
  private acceptedListeners = new Set<(os: Report['os'], event: PcEvent) => void>();
  private expiryTimer?: NodeJS.Timeout;

  constructor(private store: Store, private now = Date.now) {
    const journal = this.read();
    if (journal.current) {
      const currentKey = this.signature(this.statusFor(journal.current));
      if (journal.publishedKey !== currentKey) this.publish(journal, journal.current);
      this.scheduleExpiry();
    }
  }

  private read(): Journal {
    const row = this.store.db.prepare("SELECT value FROM settings WHERE key='desktop-report'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Journal : { retired: [] };
  }

  private write(journal: Journal): void {
    this.store.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('desktop-report',?)").run(JSON.stringify(journal));
  }

  private statusFor(current?: Report): DesktopStatus {
    if (!current) return { ready: true, online: false, controlled: false, observedAt: new Date(0).toISOString(), source: 'push', phase: 'unknown' };
    const age = this.now() - current.receivedAt;
    let phase: NonNullable<DesktopStatus['phase']>;
    if (current.phaseEvent === 'poweroff') phase = this.now() - current.phaseAt < POWER_OFF_GRACE ? 'stopping' : 'stopped';
    else if (age >= PRESENCE_TTL) phase = 'unreachable';
    else if (current.phaseEvent === 'reboot') phase = 'pending';
    else if (current.phaseEvent === 'stopping') phase = 'stopping';
    else phase = 'running';
    const online = phase === 'running';
    return { ready: true, online, controlled: online, os: current.os, bootId: current.bootId, observedAt: new Date(current.receivedAt).toISOString(), source: 'push', phase };
  }

  private signature(status: DesktopStatus): string {
    return `${status.os ?? 'unknown'}:${status.bootId ?? 'none'}:${status.phase ?? 'unknown'}`;
  }

  private publish(journal: Journal, current: Report): void {
    const status = this.statusFor(current);
    journal.publishedKey = this.signature(status);
    this.write(journal);
    this.store.appendEvent('desktop', 'computer:desktop', desktopResource(status) as unknown as Record<string, unknown>);
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Local stream consumers cannot invalidate a durable report. */ }
    }
  }

  accept(os: Report['os'], event: PcEvent): boolean {
    const journal = this.read(), old = journal.current, key = `${os}:${event.bootId}`;
    if (journal.retired.includes(key)) return false;
    if (old && old.os === os && old.bootId === event.bootId) {
      if (event.sequence < old.sequence) return false;
      if (event.sequence === old.sequence) return event.event === old.event;
    } else if (old) {
      if (event.event !== 'online' && event.event !== 'heartbeat') return false;
      journal.retired = [...journal.retired, `${old.os}:${old.bootId}`].slice(-64);
    }

    const wasPowerTransition = event.event === 'stopping' && old?.os === os && old.bootId === event.bootId && ['poweroff', 'reboot'].includes(old.phaseEvent);
    const current: Report = {
      ...event, os, receivedAt: this.now(),
      phaseEvent: wasPowerTransition ? old!.phaseEvent : event.event,
      phaseAt: wasPowerTransition ? old!.phaseAt : this.now()
    };
    journal.current = current;
    const nextKey = this.signature(this.statusFor(current));
    if (journal.publishedKey !== nextKey) this.publish(journal, current);
    else this.write(journal);
    this.scheduleExpiry();
    for (const listener of this.acceptedListeners) {
      try { listener(os, event); } catch { /* Report consumers cannot invalidate an accepted device signal. */ }
    }
    return true;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const current = this.read().current;
    if (!current) return;
    const now = this.now();
    const nextBoundary = current.phaseEvent === 'poweroff' && now < current.phaseAt + POWER_OFF_GRACE
      ? current.phaseAt + POWER_OFF_GRACE
      : current.phaseEvent !== 'poweroff' && now < current.receivedAt + PRESENCE_TTL
        ? current.receivedAt + PRESENCE_TTL
        : undefined;
    if (nextBoundary === undefined) return;
    const expected = `${current.os}:${current.bootId}:${current.receivedAt}:${current.phaseAt}`;
    this.expiryTimer = setTimeout(() => {
      const journal = this.read(), latest = journal.current;
      if (latest && `${latest.os}:${latest.bootId}:${latest.receivedAt}:${latest.phaseAt}` === expected) {
        const key = this.signature(this.statusFor(latest));
        if (journal.publishedKey !== key) this.publish(journal, latest);
      }
      this.scheduleExpiry();
    }, Math.max(0, nextBoundary - now));
    this.expiryTimer.unref();
  }

  status(): DesktopStatus { return this.statusFor(this.read().current); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeAccepted(listener: (os: Report['os'], event: PcEvent) => void): () => void {
    this.acceptedListeners.add(listener);
    return () => { this.acceptedListeners.delete(listener); };
  }

  close(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.listeners.clear();
    this.acceptedListeners.clear();
  }
}
