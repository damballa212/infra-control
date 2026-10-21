import { expect, it } from 'vitest';
import { Costs } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { Config } from '../server/types.js';
const config = { aws: [{ name: 'test', accountId: '123456789012', accessKeyId: 'test', secretAccessKey: 'test', instances: [] }] } as unknown as Config;
it('consulta costes una vez por día compartiendo resultados concurrentes y persistentes', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const io = { ce: () => ({ send: async () => { calls++; return { ResultsByTime: [{ TimePeriod: { Start: '2026-10-01', End: '2026-10-02' }, Estimated: true, Groups: [{ Keys: ['EC2', 'Usage'], Metrics: { UnblendedCost: { Amount: '20', Unit: 'USD' } } }, { Keys: ['EC2', 'Credit'], Metrics: { UnblendedCost: { Amount: '-18', Unit: 'USD' } } }] }] }; } }), budgets: () => ({ send: async () => ({ Budgets: [] }) }) };
  const costs = new Costs(config, store, io);
  const values = await Promise.all(Array.from({ length: 15 }, () => costs.get()));
  expect(calls).toBe(1); expect(values[0].accounts[0]).toMatchObject({ account: 'test', net: 2, usage: 20, adjustments: -18, currency: 'USD', estimated: true, status: 'available' });
  expect((await new Costs(config, store, io).get()).accounts[0].net).toBe(2); expect(calls).toBe(1);
  store.close();
});
it('no reinicia el cupo si existe una reserva persistida de un ciclo interrumpido', async () => {
  const store = new Store(':memory:');
  const snapshot = { accounts: [], fetchedAt: '2026-10-21T00:00:00Z', nextRefreshAt: '2026-10-22T00:00:00Z', periodStart: '2026-10-01', periodEnd: '2026-10-21', policy: 'test reservation' };
  store.putCache('costs-v1', snapshot, 86400000);
  const costs = new Costs(config, store, { ce: () => ({ send: async () => { throw new Error('Paid API must not be called'); } }), budgets: () => ({ send: async () => { throw new Error('Must not call'); } }) });
  expect(await costs.get()).toEqual(snapshot); store.close();
});
it('corta paginación costosa, indica parciales y no martilla APIs no habilitadas', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const io = { ce: () => ({ send: async () => { calls++; return { ResultsByTime: [], NextPageToken: 'more' }; } }), budgets: () => ({ send: async () => { throw new Error('AccessDenied-secret'); } }) };
  const result = await new Costs(config, store, io).get();
  expect(calls).toBe(2); expect(result.accounts[0].status).toBe('partial');
  expect(result.accounts[0].budgetsStatus).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('secret');
  store.close();
});
it('representa acceso denegado sin convertirlo en gasto cero', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const costs = new Costs(config, store, { ce: () => ({ send: async () => { calls++; throw new Error('denied'); } }), budgets: () => ({ send: async () => ({ Budgets: [] }) }) });
  const result = await costs.get(); await costs.get();
  expect(calls).toBe(1); expect(result.accounts[0]).toMatchObject({ status: 'unavailable', net: null });
  store.close();
});

it('descarta la escritura final de caché si una consulta de AWS termina después del cierre', async () => {
  const store = new Store(':memory:');
  let release!: (value: { ResultsByTime: [] }) => void;
  const delayed = new Promise<{ ResultsByTime: [] }>(resolve => { release = resolve; });
  const costs = new Costs(config, store, {
    ce: () => ({ send: () => delayed }),
    budgets: () => ({ send: async () => ({ Budgets: [] }) })
  });
  const pending = costs.get();
  costs.close();
  store.close();
  release({ ResultsByTime: [] });
  await expect(pending).resolves.toMatchObject({ accounts: [{ status: 'available', budgetsStatus: 'available' }] });
  await expect(costs.get()).rejects.toThrow('Cost reader is closed');
});
