import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { MacReports } from '../server/mac-reports.js';

const stores: Store[] = [], reporters: MacReports[] = [];
afterEach(() => {
  reporters.splice(0).forEach(reporter => reporter.close());
  stores.splice(0).forEach(store => store.close());
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  const store = new Store(':memory:'); stores.push(store);
  const reports = new MacReports(store, () => Date.now()); reporters.push(reports);
  return { store, reports };
}
const online = { bootId: 'mac-1761032337', sequence: 1761032337, event: 'online' as const };

describe('presencia saliente del MacBook', () => {
  it('no sondea el Mac, no convierte heartbeats en eventos y expira sin llamarlo apagado', async () => {
    const { store, reports } = setup();
    expect(reports.accept(online)).toBe(true);
    expect(reports.resource().state).toBe('running');
    const first = reports.status()?.observedAt;
    vi.advanceTimersByTime(15000);
    expect(reports.accept({ ...online, sequence: online.sequence + 15, event: 'heartbeat' })).toBe(true);
    expect(reports.status()?.observedAt).not.toBe(first);
    expect(store.eventsAfter(0)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(44999);
    expect(reports.status()?.state).toBe('reporting');
    expect(store.eventsAfter(0)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports.status()?.state).toBe('stale');
    expect(reports.resource().note).toContain('suspensión');
    expect(reports.resource().state).toBe('unreachable');
    expect(store.eventsAfter(0)).toHaveLength(2);
    expect(store.eventsAfter(0)[1]?.payload.transitionReason).toBe('telemetry_timeout');
  });

  it('publica el reposo como anuncio fresco y vuelve a running al recibir wake', () => {
    const { reports, store } = setup();
    reports.accept(online);
    expect(reports.accept({ ...online, sequence: online.sequence + 1, event: 'sleep' })).toBe(true);
    expect(reports.status()?.state).toBe('sleep-announced');
    expect(reports.resource()).toMatchObject({
      state: 'asleep',
      health: { presence: { state: 'fresh', reasonCode: 'sleep_announced' } },
      actions: []
    });
    expect(reports.resource().note).toContain('anunció');

    expect(reports.accept({ ...online, sequence: online.sequence + 2, event: 'wake' })).toBe(true);
    expect(reports.status()?.state).toBe('reporting');
    expect(reports.resource().state).toBe('running');
    expect(store.eventsAfter(0).map(event => event.payload.state)).toEqual(['running', 'asleep', 'running']);
  });

  it('no confunde ausencia de reporter con sin señal de un Mac previamente observado', () => {
    const { reports } = setup();
    expect(reports.resource().state).toBe('unconfigured');
    reports.accept(online);
    vi.advanceTimersByTime(45000);
    expect(reports.resource().state).toBe('unreachable');
  });

  it('retira boots anteriores y exige dos muestras para recuperar', () => {
    const { reports, store } = setup();
    reports.accept(online);
    vi.advanceTimersByTime(45000);
    expect(reports.accept({ bootId: 'mac-1761033337', sequence: 1, event: 'online' })).toBe(true);
    expect(reports.status()?.state).toBe('recovering');
    expect(store.eventsAfter(0).at(-1)?.payload.transitionReason).toBe('mac_boot_changed');
    expect(reports.accept({ bootId: 'mac-1761033337', sequence: 16, event: 'heartbeat' })).toBe(true);
    expect(reports.status()?.state).toBe('reporting');
    expect(store.eventsAfter(0).at(-1)?.payload.transitionReason).toBe('telemetry_recovered');
    expect(reports.accept({ ...online, sequence: online.sequence + 90, event: 'heartbeat' })).toBe(false);
  });

  it('guarda el estado y su evento de expiración dentro de una sola transacción', () => {
    const { store, reports } = setup();
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(() => reports.accept(online)).toThrow();
    expect(reports.status()).toBeUndefined();
    expect(store.eventsAfter(0)).toHaveLength(0);
    store.db.exec('DROP TRIGGER fail_event');
    expect(reports.accept(online)).toBe(true);
    expect(store.eventsAfter(0)).toHaveLength(1);
  });
});
