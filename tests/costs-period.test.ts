import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetCostAndUsageCommand, GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { Costs, type CostAccount, type CostReport } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { Config } from '../server/types.js';

const DAY = 86400000;
const A = '123456789012', B = '210987654321', C = '345678901234';
const stores: Store[] = [];
function config(...accounts: [string, string][]): Config {
  return { aws: accounts.map(([accountId, name]) => ({ accountId, name, accessKeyId: 'test', secretAccessKey: 'test', instances: [] })) } as unknown as Config;
}
function account(accountId = A, name = 'alpha'): CostAccount {
  return { account: name, accountId, status: 'available', net: 10, usage: 10, adjustments: 0, currency: 'USD', estimated: true, services: [{ name: 'EC2', amount: 10 }], daily: [{ date: '2026-10-22', amount: 10 }], budgetsStatus: 'available', budgets: [], fetchedAt: new Date().toISOString() };
}
function report(row = account()): CostReport {
  return { accounts: [row], fetchedAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + DAY).toISOString(), periodStart: '2026-10-01', periodEnd: '2026-10-23', policy: 'legacy' };
}
function setup(paginated = false) {
  const store = new Store(':memory:');
  stores.push(store);
  const ce = vi.fn(async (_accountId: string, _command: GetCostAndUsageCommand) => ({
    ResultsByTime: [{ Groups: [{ Keys: ['EC2', 'Usage'], Metrics: { UnblendedCost: { Amount: '10', Unit: 'USD' } } }] }],
    ...(paginated ? { NextPageToken: 'more' } : {})
  }));
  const budgets = vi.fn(async (_accountId: string) => ({ Budgets: [] }));
  const io = {
    ce: (value: { accountId: string }) => ({ send: (command: GetCostAndUsageCommand) => ce(value.accountId, command) }),
    budgets: (value: { accountId: string }) => ({ send: () => budgets(value.accountId) })
  };
  return { store, ce, budgets, io };
}

function page(...metrics: [string, string][]): Partial<GetCostAndUsageCommandOutput> {
  return { ResultsByTime: [{ Groups: metrics.map(([Amount, Unit]) => ({ Keys: ['EC2', 'Usage'], Metrics: { UnblendedCost: { Amount, Unit } } })) }] };
}
function setupPages(...pages: (Partial<GetCostAndUsageCommandOutput> | Error)[]) {
  const { store } = setup();
  const send = vi.fn(async (_command: GetCostAndUsageCommand): Promise<Partial<GetCostAndUsageCommandOutput>> => {
    const value = pages.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error('Unexpected CE request');
    return value;
  });
  const budgets = vi.fn(async () => ({ Budgets: [] }));
  return { store, send, budgets, io: { ce: () => ({ send }), budgets: () => ({ send: budgets }) } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
});
afterEach(() => {
  try { for (const store of stores.splice(0)) store.close(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe('períodos UTC y cuotas durables de costes', () => {
  it.each([
    ['día', '2026-10-23T12:00:00Z', '2026-10-24T13:00:00Z', '2026-10-01', '2026-10-24'],
    ['mes', '2026-10-31T23:00:00Z', '2026-11-02T00:00:00Z', '2026-11-01', '2026-11-02'],
    ['año', '2026-12-31T23:00:00Z', '2027-01-02T00:00:00Z', '2027-01-01', '2027-01-02']
  ])('renueva el intervalo al expirar y avanzar de %s', async (_name, initial, next, start, end) => {
    vi.setSystemTime(new Date(initial));
    const { store, ce, io } = setup();
    const costs = new Costs(config([A, 'alpha']), store, io);
    const previous = await costs.get();
    const previousPeriod = { periodStart: previous.periodStart, periodEnd: previous.periodEnd };
    vi.setSystemTime(new Date(next));
    const current = await costs.get();
    expect(ce).toHaveBeenCalledTimes(2);
    expect(ce.mock.calls[1][1].input.TimePeriod).toEqual({ Start: start, End: end });
    expect(current).toMatchObject({ periodStart: start, periodEnd: end });
    expect(previous).toMatchObject(previousPeriod);
  });

  it('reemplaza el intervalo de un informe legacy expirado aunque fetchedAt sea reciente', async () => {
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    const { store, ce, io } = setup();
    const legacy = report();
    store.putCache('costs-v1', legacy, DAY);
    vi.setSystemTime(new Date('2026-11-13T13:00:00Z'));
    const result = await new Costs(config([A, 'alpha']), store, io).get();
    expect(ce).toHaveBeenCalledTimes(1);
    expect(ce.mock.calls[0][1].input.TimePeriod).toEqual({ Start: '2026-11-01', End: '2026-11-13' });
    expect(result).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-13' });
    expect(legacy).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-23' });
  });

  it('conserva el período real de una caché válida del día anterior', async () => {
    const { store, ce, budgets, io } = setup();
    const first = await new Costs(config([A, 'alpha']), store, io).get();
    vi.setSystemTime(new Date('2026-10-24T01:00:00Z'));
    const costs = new Costs(config([A, 'alpha']), store, io);
    const result = await costs.get();
    expect(result).toMatchObject({ periodStart: first.periodStart, periodEnd: first.periodEnd });
    expect(result.accounts[0]).toEqual(first.accounts[0]);
    expect(costs.getCached()).toMatchObject({ stale: false, report: { periodEnd: '2026-10-23' } });
    expect(ce).toHaveBeenCalledTimes(1);
    expect(budgets).toHaveBeenCalledTimes(1);
  });

  it('no mezcla la cuenta agregada hoy con importes reservados ayer', async () => {
    const { store, ce, budgets, io } = setup();
    await new Costs(config([A, 'alpha']), store, io).get();
    vi.setSystemTime(new Date('2026-10-24T01:00:00Z'));
    const expanded = config([A, 'alpha'], [B, 'beta']);
    const result = await new Costs(expanded, store, io).get();
    expect(ce.mock.calls.map(([id]) => id)).toEqual([A, B]);
    expect(ce.mock.calls[1][1].input.TimePeriod).toEqual({ Start: '2026-10-01', End: '2026-10-24' });
    expect(result).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-24' });
    expect(result.accounts[0]).toMatchObject({ accountId: A, status: 'unavailable', net: null, usage: null, adjustments: null, services: [], daily: [], budgetsStatus: 'unavailable', budgets: [] });
    expect(result.accounts[1]).toMatchObject({ accountId: B, status: 'available', net: 10 });
    const restarted = await new Costs(expanded, store, io).get();
    expect(restarted.accounts).toEqual(result.accounts);
    expect(ce).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.accounts[1]).sort()).toEqual(Object.keys(account()).sort());
  });

  it('migra una caché legacy válida de otro mes sin abrir cuota extra', async () => {
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { store, ce, budgets, io } = setup();
    store.putCache('costs-v1', report(), DAY);
    const original = config([A, 'alpha']);
    const first = await new Costs(original, store, io).get();
    expect(first).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-13' });
    expect(first.accounts[0]).toMatchObject({ status: 'unavailable', net: null, usage: null, adjustments: null, services: [], daily: [] });
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
    const expanded = config([A, 'renamed'], [B, 'beta']);
    const second = await new Costs(expanded, store, io).get();
    expect(second.accounts[0]).toMatchObject({ account: 'renamed', status: 'unavailable', net: null });
    expect(second.accounts[1]).toMatchObject({ accountId: B, status: 'available' });
    expect(ce.mock.calls.map(([id]) => id)).toEqual([B]);
    expect(budgets.mock.calls.map(([id]) => id)).toEqual([B]);
    await new Costs(expanded, store, io).get();
    expect(ce).toHaveBeenCalledTimes(1);
    expect(budgets).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-14T13:00:00Z'));
    const refreshed = await new Costs(expanded, store, io).get();
    expect(ce.mock.calls.map(([id]) => id)).toEqual([B, A, B]);
    expect(budgets.mock.calls.map(([id]) => id)).toEqual([B, A, B]);
    expect(refreshed.accounts.every(row => row.status === 'available')).toBe(true);
    expect(ce.mock.calls.slice(1).map(([, command]) => command.input.TimePeriod)).toEqual([
      { Start: '2026-11-01', End: '2026-11-14' },
      { Start: '2026-11-01', End: '2026-11-14' }
    ]);
  });

  it('marca otro mes como stale desde getCached sin consultar proveedores', () => {
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { store, ce, budgets, io } = setup();
    store.putCache('costs-v1', report(), DAY);
    const cached = new Costs(config([A, 'renamed']), store, io).getCached();
    expect(cached).toMatchObject({ stale: true, report: { periodStart: '2026-10-01', periodEnd: '2026-10-23', accounts: [{ account: 'renamed', net: 10 }] } });
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
  });

  it('re-etiqueta y filtra las identidades actuales incluso con igual número de cuentas', async () => {
    const { store, ce, budgets, io } = setup();
    await new Costs(config([A, 'alpha'], [B, 'beta']), store, io).get();
    await new Costs(config([A, 'alpha']), store, io).get();
    const costs = new Costs(config([A, 'renamed'], [A, 'alias']), store, io);
    expect(costs.getCached().report?.accounts).toMatchObject([{ accountId: A, account: 'alias, renamed' }]);
    expect(costs.getCached().report?.accounts).toHaveLength(1);
    const result = await costs.get();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ accountId: A, account: 'alias, renamed' });
    expect(costs.getCached().report?.accounts).toEqual(result.accounts);
    expect(ce).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveBeenCalledTimes(2);
  });

  it('no resucita importes raw mediante placeholders, lecturas sucesivas o reinicios', async () => {
    const raw = account();
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { store, ce, budgets, io } = setup();
    store.putCache('cost-account-v1:' + A, raw, DAY);
    const costs = new Costs(config([A, 'alpha']), store, io);
    const first = await costs.get();
    const second = await costs.get();
    const third = await new Costs(config([A, 'alpha']), store, io).get();
    for (const result of [first, second, third]) {
      expect(result).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-13', fetchedAt: raw.fetchedAt });
      expect(result.accounts[0]).toMatchObject({ status: 'unavailable', net: null, usage: null, adjustments: null, services: [], daily: [] });
    }
    const persisted = store.cache<{ row: CostAccount; periodStart?: string; periodEnd?: string }>('cost-account-v1:' + A);
    expect(persisted?.value.row).toEqual(raw);
    expect(persisted?.value.periodStart).toBeUndefined();
    expect(persisted?.value.periodEnd).toBeUndefined();
    expect(persisted?.expires).toBe(Date.now() + DAY);
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
  });

  it('preserva la reserva global legacy de un ciclo interrumpido', async () => {
    const { store, ce, budgets, io } = setup();
    const reserved = { ...report(), accounts: [] };
    store.putCache('costs-v1', reserved, DAY);
    expect(await new Costs(config([A, 'alpha']), store, io).get()).toEqual(reserved);
    expect(await new Costs(config([A, 'alpha'], [B, 'beta']), store, io).get()).toEqual(reserved);
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
  });

  it('persiste la reserva antes de completar CE y la conserva al cruzar de mes', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:00:00Z'));
    const { store } = setup();
    let release!: (value: { ResultsByTime: [] }) => void;
    const delayed = new Promise<{ ResultsByTime: [] }>(resolve => { release = resolve; });
    const ce = vi.fn(() => delayed);
    const budgets = vi.fn(async () => ({ Budgets: [] }));
    const io = { ce: () => ({ send: ce }), budgets: () => ({ send: budgets }) };
    const costs = new Costs(config([A, 'alpha']), store, io);
    const pending = costs.get();
    costs.close();
    try {
      vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
      const restarted = new Costs(config([A, 'alpha']), store, io);
      const result = await restarted.get();
      expect(result).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-01' });
      expect(result.accounts[0]).toMatchObject({ status: 'unavailable', net: null });
      expect(restarted.cacheHealth()).toMatchObject({ reservedCycles: 1, uncachedAccounts: 0 });
      expect(ce).toHaveBeenCalledTimes(1);
      expect(budgets).not.toHaveBeenCalled();
    } finally {
      release({ ResultsByTime: [] });
      await pending;
    }
    const cached = new Costs(config([A, 'alpha']), store, io).getCached();
    expect(cached.report?.accounts[0]).toMatchObject({ status: 'unavailable', net: null });
  });

  it('mantiene dos páginas por cuenta, filtro LINKED_ACCOUNT y cuota tras reiniciar', async () => {
    const { store, ce, budgets, io } = setup(true);
    const configured = config([A, 'alpha']);
    const result = await new Costs(configured, store, io).get();
    expect(result.accounts[0].status).toBe('partial');
    expect(ce).toHaveBeenCalledTimes(2);
    expect(ce.mock.calls[0][1].input.NextPageToken).toBeUndefined();
    expect(ce.mock.calls[1][1].input.NextPageToken).toBe('more');
    for (const [, command] of ce.mock.calls) {
      expect(command.input.Filter).toEqual({ Dimensions: { Key: 'LINKED_ACCOUNT', Values: [A] } });
    }
    await new Costs(configured, store, io).get();
    expect(ce).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveBeenCalledTimes(1);
  });
});

describe('regresiones de procedencia, observación y páginas CE', () => {
  it('conserva reservas legacy de cuentas retiradas al reiniciar y reincorporarlas', async () => {
    const { store, ce, budgets, io } = setup();
    const legacy = { ...report(), accounts: [account(A, 'alpha'), account(B, 'beta')] };
    const expiry = Date.now() + DAY;
    store.putCache('costs-v1', legacy, DAY);
    const reduced = config([A, 'alpha']);
    const first = await new Costs(reduced, store, io).get();
    expect(first.accounts.map(row => row.accountId)).toEqual([A]);
    expect(new Costs(reduced, store, io).getCached().report?.accounts.map(row => row.accountId)).toEqual([A]);
    vi.setSystemTime(new Date(Date.now() + 3600000));
    const expanded = config([A, 'alpha'], [B, 'beta']);
    const restored = await new Costs(expanded, store, io).get();
    expect(restored.accounts.map(row => row.accountId)).toEqual([A, B]);
    expect(restored.accounts[1]).toMatchObject({ accountId: B, status: 'available', net: 10 });
    expect(store.cache<unknown>('cost-account-v1:' + B)?.expires).toBe(expiry);
    await new Costs(expanded, store, io).get();
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
  });
  it('no atribuye importes raw al período de un placeholder con igual fetchedAt', async () => {
    const { store, ce, budgets, io } = setup();
    const raw = account();
    const placeholder = { ...raw, status: 'unavailable' as const, net: null, usage: null, adjustments: null, services: [], daily: [] };
    store.putCache('cost-account-v1:' + A, raw, DAY);
    store.putCache('costs-v1', report(placeholder), DAY);
    for (let read = 0; read < 3; read++) {
      const result = await new Costs(config([A, 'alpha']), store, io).get();
      expect(result.accounts[0]).toMatchObject({ status: 'unavailable', net: null, services: [], daily: [] });
    }
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
  });

  it('no reasigna un alias legacy y conserva su reserva tras reemplazar el informe', async () => {
    const { store, ce, budgets, io } = setup();
    const anonymous = account();
    delete anonymous.accountId;
    store.putCache('costs-v1', report(anonymous), DAY);
    const replacement = config([B, 'alpha']);
    const reader = new Costs(replacement, store, io);
    expect(reader.getCached().report?.accounts).toEqual([]);
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
    const first = await reader.get();
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({ accountId: B, status: 'unavailable', net: null, services: [], daily: [] });
    const expanded = config([B, 'alpha'], [C, 'gamma']);
    const second = await new Costs(expanded, store, io).get();
    expect(second.accounts.map(row => row.accountId)).toEqual([B, C]);
    expect(second.accounts.every(row => row.status === 'unavailable' && row.net === null && row.services.length === 0)).toBe(true);
    const restarted = new Costs(expanded, store, io);
    expect((await restarted.get()).accounts).toEqual(second.accounts);
    expect(restarted.getCached().report?.accounts).toEqual(second.accounts);
    expect(ce).not.toHaveBeenCalled();
    expect(budgets).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-24T13:00:00Z'));
    const refreshed = await new Costs(expanded, store, io).get();
    expect(ce.mock.calls.map(([id]) => id)).toEqual([B, C]);
    expect(budgets.mock.calls.map(([id]) => id)).toEqual([B, C]);
    expect(refreshed.accounts.every(row => row.status === 'available')).toBe(true);
  });

  it('conserva fetchedAt al leer y usa observaciones retenidas al recomponer', async () => {
    const { store, ce, budgets, io } = setup();
    const configured = config([A, 'alpha']);
    const first = await new Costs(configured, store, io).get();
    expect(first.fetchedAt).toBe('2026-10-23T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-23T13:00:00Z'));
    const expanded = await new Costs(config([A, 'alpha'], [B, 'beta']), store, io).get();
    expect(expanded.fetchedAt).toBe(first.fetchedAt);
    expect(expanded.accounts[1].fetchedAt).toBe('2026-10-23T13:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-23T18:00:00Z'));
    const remaining = config([B, 'beta']);
    const recomposed = await new Costs(remaining, store, io).get();
    expect(recomposed.fetchedAt).toBe(expanded.accounts[1].fetchedAt);
    vi.setSystemTime(new Date('2026-10-23T19:00:00Z'));
    const reader = new Costs(remaining, store, io);
    expect((await reader.get()).fetchedAt).toBe(recomposed.fetchedAt);
    expect(reader.getCached().report?.fetchedAt).toBe(recomposed.fetchedAt);
    expect(ce).toHaveBeenCalledTimes(2);
    expect(budgets).toHaveBeenCalledTimes(2);
  });

  it('limita la escritura intermedia al snapshot que vence primero durante una interrupción', async () => {
    const { store } = setup();
    const expires = Date.now() + 3600000;
    store.putCache('cost-account-v1:' + A, { row: account(), periodStart: '2026-10-01', periodEnd: '2026-10-23' }, 3600000);
    let release!: (value: Partial<GetCostAndUsageCommandOutput>) => void;
    let started!: () => void;
    const delayed = new Promise<Partial<GetCostAndUsageCommandOutput>>(resolve => { release = resolve; });
    const thirdStarted = new Promise<void>(resolve => { started = resolve; });
    const calls: string[] = [];
    const budgets = vi.fn(async () => ({ Budgets: [] }));
    const io = {
      ce: (value: { accountId: string }) => ({ send: async () => {
        calls.push(value.accountId);
        if (value.accountId === C) { started(); return delayed; }
        return { ResultsByTime: [] };
      } }),
      budgets: () => ({ send: budgets })
    };
    const configured = config([A, 'alpha'], [B, 'beta'], [C, 'gamma']);
    const costs = new Costs(configured, store, io);
    const pending = costs.get();
    try {
      await thirdStarted;
      costs.close();
      const intermediate = store.cache<CostReport>('costs-v1');
      expect(intermediate?.expires).toBe(expires);
      expect(intermediate?.value.nextRefreshAt).toBe(new Date(expires).toISOString());
      expect(intermediate?.value.accounts[1]).toMatchObject({ accountId: B, status: 'available', net: 0 });
      vi.setSystemTime(new Date(expires + 60000));
      const cached = new Costs(configured, store, io).getCached();
      expect(cached).toMatchObject({ stale: true, expiresAt: new Date(expires).toISOString() });
      expect(calls).toEqual([B, C]);
      expect(budgets).toHaveBeenCalledTimes(1);
    } finally {
      costs.close();
      release({ ResultsByTime: [] });
      await pending;
    }
    expect(new Costs(configured, store, io).getCached().stale).toBe(true);
    expect(store.cache<CostReport>('costs-v1')?.expires).toBe(expires);
  });

  it.each([
    ['Amount', 'invalid', 'USD'],
    ['Unit', '2', 'EUR']
  ])('descarta toda la primera página si contiene %s inválido', async (_field, amount, unit) => {
    const { store, send, budgets, io } = setupPages(page(['7', 'USD'], [amount, unit]));
    const configured = config([A, 'alpha']);
    const result = await new Costs(configured, store, io).get();
    expect(result.accounts[0]).toMatchObject({ status: 'unavailable', net: null, usage: null, adjustments: null, services: [], daily: [], budgetsStatus: 'available' });
    const restarted = await new Costs(configured, store, io).get();
    expect(restarted.accounts[0]).toEqual(result.accounts[0]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(budgets).toHaveBeenCalledTimes(1);
  });

  it('no incorpora sumas de una segunda página inválida y conserva partial', async () => {
    const { store, send, io } = setupPages(
      { ...page(['10', 'USD']), NextPageToken: 'more' },
      page(['5', 'USD'], ['invalid', 'USD'])
    );
    const result = await new Costs(config([A, 'alpha']), store, io).get();
    expect(result.accounts[0]).toMatchObject({ status: 'partial', net: 10, usage: 10, adjustments: 0, services: [{ name: 'EC2', amount: 10 }], daily: [{ date: '2026-10-01', amount: 10 }] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('mantiene partial tras un fallo de transporte posterior a una página válida', async () => {
    const { store, send, io } = setupPages(
      { ...page(['10', 'USD']), NextPageToken: 'more' },
      new Error('denied')
    );
    const result = await new Costs(config([A, 'alpha']), store, io).get();
    expect(result.accounts[0]).toMatchObject({ status: 'partial', net: 10 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('conserva cero para páginas válidas vacías; fallo posterior=%s', async failure => {
    const responses: (Partial<GetCostAndUsageCommandOutput> | Error)[] = failure
      ? [{ ResultsByTime: [], NextPageToken: 'more' }, new Error('denied')]
      : [{ ResultsByTime: [] }];
    const { store, send, io } = setupPages(...responses);
    const result = await new Costs(config([A, 'alpha']), store, io).get();
    expect(result.accounts[0]).toMatchObject({ status: failure ? 'partial' : 'available', net: 0, usage: 0, adjustments: 0, services: [], daily: [] });
    expect(send).toHaveBeenCalledTimes(failure ? 2 : 1);
  });
});
