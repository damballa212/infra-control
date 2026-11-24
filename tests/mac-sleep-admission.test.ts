import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { MacReports } from '../server/mac-reports.js';

afterEach(() => vi.useRealTimers());
describe('protocolo de admisión antes de reposo', () => {
  it('acepta una admisión repetida tras ACK perdido y conserva el sleep posterior', async () => {
    vi.useFakeTimers();
    const store = new Store(':memory:');
    const reports = new MacReports(store);
    try {
      // El transporte del cliente perdió la primera respuesta, no el servidor.
      expect(reports.accept({ bootId: 'mac-fixture-boot', sequence: 1, event: 'online' })).toBe(true);
      expect(reports.accept({ bootId: 'mac-fixture-boot', sequence: 2, event: 'online' })).toBe(true);
      expect(reports.accept({ bootId: 'mac-fixture-boot', sequence: 3, event: 'sleep' })).toBe(true);
      await vi.advanceTimersByTimeAsync(60000);
      expect(reports.resource()).toMatchObject({ state: 'asleep', monitoring: { availability: 'on-demand', expectedState: 'asleep' } });
      expect(store.eventsAfter(0).some(event => event.payload.transitionReason === 'telemetry_timeout')).toBe(false);
    } finally { reports.close(); store.close(); }
  });
});
