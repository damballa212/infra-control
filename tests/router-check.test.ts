import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { Adapter, Config, Resource } from '../server/types.js';
import { RouterReports } from '../server/router-reports.js';
import { Store } from '../server/store.js';

const origin = 'https://control.example.test';
const reader = 'router-reader-secret';
const config: Config = {
  origin,
  passwordHash: 'unused',
  agentTokens: [{ name: 'reader', hash: tokenHash(reader), scopes: ['read', 'operate'] }],
  aws: [],
  coolify: { url: '', token: '', resources: [] },
  acs: { url: '', deviceId: '' }
};
const router: Resource = {
  id: 'router:fiberhome', name: 'FiberHome', kind: 'router', state: 'stale',
  account: 'Casa', location: 'Red de casa', detail: 'SR1021D', actions: ['refresh'], observedAt: null
};
const apps: ReturnType<typeof createApp>[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.locals.close();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe('sondeo rápido del canal privado del FiberHome', () => {
  it('separa un túnel disponible de la telemetría y CWMP, y comparte peticiones concurrentes', async () => {
    let resolveProbe!: (value: { ready: boolean }) => void;
    const probe = new Promise<{ ready: boolean }>(resolve => { resolveProbe = resolve; });
    const checkRouter = vi.fn(() => probe);
    const adapter: Adapter = {
      inventory: async () => [router],
      perform: async () => ({ message: 'No debe usar CWMP.' }),
      checkRouter
    };
    const app = createApp(config, ':memory:', adapter); apps.push(app);

    const first = request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`).then(response => response);
    const second = request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`).then(response => response);
    await vi.waitFor(() => expect(checkRouter).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    resolveProbe({ ready: true });
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(a.body.probe).toMatchObject({ state: 'available', source: 'ssh-router-check' });
    expect(a.body.resource.health).toMatchObject({
      presence: { state: 'unknown' },
      telemetry: { state: 'unknown' },
      tunnel: { state: 'available', source: 'ssh-router-check' },
      cwmp: { state: 'unknown' },
      wanLink: { state: 'unknown' },
      internetProbe: { state: 'unknown' }
    });
    expect(a.body.resource.actions).toContain('refresh');
    expect(b.body.probe.state).toBe('available');
    expect(checkRouter).toHaveBeenCalledTimes(1);
    const cached = await request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`);
    expect(cached.body.cached).toBe(true);
    expect(checkRouter).toHaveBeenCalledTimes(1);
    const health = await request(app).get('/api/router/health').set('Authorization', `Bearer ${reader}`);
    expect(health.body.resource.health.tunnel).toMatchObject({ state: 'available', source: 'ssh-router-check' });
  });

  it('expone el último sondeo por un TTL corto y luego vuelve al estado de telemetría', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const store = new Store(':memory:'); stores.push(store);
    const reports = new RouterReports(store, () => Date.now());
    reports.recordTunnelProbe(true);
    expect(reports.resource().health?.tunnel).toMatchObject({ state: 'available', source: 'ssh-router-check' });
    expect(store.eventsAfter(0)).toHaveLength(1);
    reports.recordTunnelProbe(true);
    expect(store.eventsAfter(0)).toHaveLength(1);
    const recovered = new RouterReports(store, () => Date.now());
    expect(recovered.tunnelProbe()).toMatchObject({ state: 'available' });

    vi.advanceTimersByTime(30_001);
    expect(reports.resource().health?.tunnel).toMatchObject({ state: 'unknown', reasonCode: 'no_current_probe' });
    reports.close();
  });

  it('un refresh del recurso comprueba el túnel rápido y no encola una tarea ACS', async () => {
    const checkRouter = vi.fn(async () => ({ ready: true }));
    const perform = vi.fn(async () => ({ message: 'ACS lento' }));
    const inventory = vi.fn(async () => [router]);
    const adapter: Adapter = { inventory, perform, checkRouter };
    const app = createApp(config, ':memory:', adapter); apps.push(app);

    const response = await request(app).post('/api/operations')
      .set('Authorization', `Bearer ${reader}`)
      .set('Idempotency-Key', 'router-fast-refresh')
      .send({ resourceId: router.id, action: 'refresh' });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      const result = await request(app).get(`/api/operations/${response.body.id}`).set('Authorization', `Bearer ${reader}`);
      expect(result.body.state).toBe('succeeded');
      expect(result.body.message).toContain('túnel privado');
    });
    expect(checkRouter).toHaveBeenCalledTimes(1);
    expect(inventory).not.toHaveBeenCalled();
    expect(perform).not.toHaveBeenCalled();
  });

  it('marca fallo del broker como fallo de orden y conserva el túnel indeterminado', async () => {
    const adapter: Adapter = {
      inventory: async () => [router],
      perform: async () => ({ message: 'unused' }),
      checkRouter: async () => { throw new Error('private socket path'); }
    };
    const app = createApp(config, ':memory:', adapter); apps.push(app);
    const accepted = await request(app).post('/api/operations')
      .set('Authorization', `Bearer ${reader}`)
      .set('Idempotency-Key', 'router-broker-failure')
      .send({ resourceId: router.id, action: 'refresh' });
    expect(accepted.status).toBe(202);
    await vi.waitFor(async () => {
      const result = await request(app).get(`/api/operations/${accepted.body.id}`).set('Authorization', `Bearer ${reader}`);
      expect(result.body.state).toBe('failed');
    });
    const health = await request(app).get('/api/router/health').set('Authorization', `Bearer ${reader}`);
    expect(health.body.probe).toBeNull();
  });

  it('no revela secretos ni declara caída de Internet cuando el túnel no responde', async () => {
    const adapter: Adapter = {
      inventory: async () => [router],
      perform: async () => ({ message: 'unused' }),
      checkRouter: async () => ({ ready: false })
    };
    const app = createApp(config, ':memory:', adapter); apps.push(app);
    const response = await request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`);

    expect(response.status).toBe(200);
    expect(response.body.probe).toMatchObject({ state: 'unavailable', reasonCode: 'router_check_failed' });
    expect(response.body.message).toContain('ni una caída de Internet');
    expect(response.body.resource.note).toContain('no confirma');
    expect(JSON.stringify(response.body)).not.toContain(reader);
  });

  it('no convierte un broker local inaccesible en un túnel caído', async () => {
    const adapter: Adapter = {
      inventory: async () => [router],
      perform: async () => ({ message: 'unused' }),
      checkRouter: async () => { throw new Error('private socket path'); }
    };
    const app = createApp(config, ':memory:', adapter); apps.push(app);
    const response = await request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`);

    expect(response.status).toBe(503);
    expect(response.body.error).toContain('broker privado');
    expect(response.text).not.toContain('private socket path');
    const health = await request(app).get('/api/router/health').set('Authorization', `Bearer ${reader}`);
    expect(health.body.probe).toBeNull();
  });

  it('requiere autenticación y responde claramente si no hay broker configurado', async () => {
    const app = createApp(config, ':memory:', { inventory: async () => [], perform: async () => ({ message: 'unused' }) }); apps.push(app);
    expect((await request(app).post('/api/router/check').set('Origin', origin)).status).toBe(401);
    const response = await request(app).post('/api/router/check').set('Authorization', `Bearer ${reader}`);
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('no está configurado');
  });
});
