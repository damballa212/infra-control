import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { hashPassword, tokenHash } from '../server/auth.js';
import { MemoryVault } from '../server/secrets-vault.js';
import type { Config } from '../server/types.js';

const origin = 'https://control.example.test';
const FAKE = `FAKE_ONLY_${'cd'.repeat(16)}`;
const mac = { Authorization: 'Bearer mac-token' };
const other = { Authorization: 'Bearer other-token' };
const bare = { Authorization: 'Bearer bare-token' };
const body = {
  name: 'OPENAI_API_KEY', project: 'prod-erp', environment: 'dev', machine: 'macbook-air',
  reason: 'pruebas locales', destination: { kind: 'dotenv', path: '.env.local' }
};
let app: ReturnType<typeof createApp>;
let vault: MemoryVault;

async function config(): Promise<Config> {
  return {
    origin,
    passwordHash: await hashPassword('una-clave-de-prueba-larga'),
    agentTokens: [
      { name: 'claude-mac', hash: tokenHash('mac-token'), scopes: ['read', 'operate'], secretsPolicy: { projects: ['prod-erp'], names: ['OPENAI_API_KEY'] } },
      { name: 'hermes', hash: tokenHash('other-token'), scopes: ['read', 'operate'], secretsPolicy: { projects: ['prod-erp'] } },
      { name: 'sin-permiso', hash: tokenHash('bare-token'), scopes: ['read', 'operate'] },
      { name: 'equipo', hash: tokenHash('equipo-token'), scopes: ['read'], readPolicy: { resourceIds: ['ninguno'], costs: false }, secretsPolicy: { projects: ['*'] } },
      { name: 'solo-lectura', hash: tokenHash('ro-token'), scopes: ['read'] }
    ],
    aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' }
  } as Config;
}
beforeEach(async () => {
  vault = new MemoryVault();
  app = createApp(await config(), ':memory:', undefined, undefined, undefined, vault);
});
afterEach(() => app.locals.close());

async function owner() {
  const login = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
  return login.headers['set-cookie'][0].split(';')[0] as string;
}
const create = (headers = mac, key = 'req-0001', payload: object = body) =>
  request(app).post('/api/secrets/requests').set(headers).set('Idempotency-Key', key).send(payload);

describe('tokens de equipo de solo lectura', () => {
  const equipo = { Authorization: 'Bearer equipo-token' };
  it('piden y reclaman claves sin scope operate', async () => {
    const cookie = await owner();
    const created = await create(equipo, 'req-ro-1', { ...body, project: 'cualquiera' });
    expect(created.status).toBe(201);
    await request(app).post(`/api/secrets/requests/${created.body.id}/approve`).set('Cookie', cookie).set('Origin', origin).send({ approval: { mode: 'paste', value: FAKE }, scope: 'once' });
    const claimed = await request(app).post(`/api/secrets/requests/${created.body.id}/claim`).set(equipo);
    expect(claimed.status).toBe(200);
    expect(claimed.body.value).toBe(FAKE);
  });
  it('no pueden operar equipos ni ver el inventario', async () => {
    expect((await request(app).post('/api/operations').set(equipo).set('Idempotency-Key', 'op-ro-1').send({ resourceId: 'x', action: 'stop', confirmed: true })).status).toBe(403);
    const inventory = await request(app).get('/api/resources').set(equipo);
    expect(inventory.status === 403 || (inventory.body.resources ?? []).length === 0).toBe(true);
  });
  it('sin secretsPolicy un token de solo lectura tampoco puede pedir', async () => {
    expect((await create({ Authorization: 'Bearer ro-token' }, 'req-ro-2')).status).toBe(403);
  });
});

describe('API de secretos', () => {
  it('flujo completo: pedir → aprobar pegando → reclamar una sola vez', async () => {
    const cookie = await owner();
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'pending', url: expect.stringContaining(`${origin}/secretos/`) });
    const id = created.body.id as string;

    const listed = await request(app).get('/api/secrets/requests').set('Cookie', cookie);
    expect(listed.body.requests[0]).toMatchObject({ id, state: 'pending', agent: 'claude-mac' });

    const approved = await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', origin)
      .send({ approval: { mode: 'paste', value: FAKE }, scope: 'once' });
    expect(approved.status).toBe(200);
    expect(JSON.stringify(approved.body)).not.toContain(FAKE);

    const status = await request(app).get(`/api/secrets/requests/${id}`).set(mac);
    expect(status.body.state).toBe('approved');
    expect(JSON.stringify(status.body)).not.toContain(FAKE);

    const claimed = await request(app).post(`/api/secrets/requests/${id}/claim`).set(mac);
    expect(claimed.status).toBe(200);
    expect(claimed.headers['cache-control']).toBe('no-store');
    expect(claimed.body).toEqual({ name: 'OPENAI_API_KEY', value: FAKE, destination: body.destination });
    expect((await request(app).post(`/api/secrets/requests/${id}/claim`).set(mac)).status).toBe(409);
  });

  it('falla cerrado sin bóveda configurada', async () => {
    const closed = createApp(await config(), ':memory:');
    try {
      expect((await request(closed).post('/api/secrets/requests').set(mac).set('Idempotency-Key', 'req-0001').send(body)).status).toBe(503);
    } finally { closed.locals.close(); }
  });

  it('exige autenticación', async () => {
    expect((await request(app).get('/api/secrets/requests')).status).toBe(401);
    expect((await request(app).post('/api/secrets/requests').set('Origin', origin).send(body)).status).toBe(401);
  });

  it('un agente sin secretsPolicy no puede pedir', async () => {
    expect((await create(bare)).status).toBe(403);
  });

  it('respeta la política: proyecto y variable', async () => {
    expect((await create(mac, 'req-0002', { ...body, project: 'otro' })).status).toBe(403);
    expect((await create(mac, 'req-0003', { ...body, name: 'STRIPE_KEY' })).status).toBe(403);
    expect((await create(other, 'req-0004', { ...body, name: 'STRIPE_KEY' })).status).toBe(201);
  });

  it('valida la entrada y exige Idempotency-Key', async () => {
    expect((await request(app).post('/api/secrets/requests').set(mac).send(body)).status).toBe(400);
    expect((await create(mac, 'req-0005', { ...body, destination: { kind: 'dotenv', path: '../.env' } })).status).toBe(400);
    expect((await create(mac, 'req-0006', { ...body, extra: 1 })).status).toBe(400);
  });

  it('idempotente: misma clave devuelve la misma solicitud; otra carga con la misma clave da 409', async () => {
    const a = await create(mac, 'req-0007');
    const b = await create(mac, 'req-0007');
    expect(b.body.id).toBe(a.body.id);
    expect((await create(mac, 'req-0007', { ...body, name: 'OPENAI_API_KEY', machine: 'otra' })).status).toBe(409);
  });

  it('los agentes no aprueban, no listan ni ven solicitudes ajenas', async () => {
    const created = await create();
    const id = created.body.id as string;
    const attempt = await request(app).post(`/api/secrets/requests/${id}/approve`).set(mac).set('Origin', origin)
      .send({ approval: { mode: 'paste', value: FAKE }, scope: 'once' });
    expect(attempt.status).toBe(403);
    expect((await request(app).get('/api/secrets/requests').set(mac)).status).toBe(403);
    expect((await request(app).get(`/api/secrets/requests/${id}`).set(other)).status).toBe(404);
    expect((await request(app).post(`/api/secrets/requests/${id}/claim`).set(other)).status).toBe(404);
  });

  it('una persona no crea ni reclama solicitudes', async () => {
    const cookie = await owner();
    expect((await request(app).post('/api/secrets/requests').set('Cookie', cookie).set('Idempotency-Key', 'req-0008').send(body)).status).toBe(403);
    const created = await create();
    expect((await request(app).post(`/api/secrets/requests/${created.body.id}/claim`).set('Cookie', cookie)).status).toBe(403);
  });

  it('aprobar exige el Origin exacto del panel', async () => {
    const cookie = await owner();
    const id = (await create()).body.id as string;
    const payload = { approval: { mode: 'paste', value: FAKE }, scope: 'once' };
    expect((await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).send(payload)).status).toBe(403);
    expect((await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', 'https://evil.example').send(payload)).status).toBe(403);
    expect((await request(app).get(`/api/secrets/requests/${id}`).set(mac)).body.state).toBe('pending');
  });

  it('denegar impide aprobar después', async () => {
    const cookie = await owner();
    const id = (await create()).body.id as string;
    expect((await request(app).post(`/api/secrets/requests/${id}/deny`).set('Cookie', cookie).set('Origin', origin)).body.state).toBe('denied');
    const late = await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', origin).send({ approval: { mode: 'paste', value: FAKE }, scope: 'once' });
    expect(late.status).toBe(409);
  });

  it('elegir un ítem existente de la colección del proyecto', async () => {
    const cookie = await owner();
    const itemRef = await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    const items = await request(app).get('/api/secrets/items?project=prod-erp&environment=dev').set('Cookie', cookie);
    expect(items.body.items).toEqual([expect.objectContaining({ itemRef, name: 'OPENAI_API_KEY' })]);
    expect(JSON.stringify(items.body)).not.toContain(FAKE);
    const id = (await create()).body.id as string;
    const ok = await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', origin).send({ approval: { mode: 'existing', itemRef }, scope: 'once' });
    expect(ok.status).toBe(200);
  });

  it('permiso permanente: la siguiente petición llega aprobada y se puede revocar', async () => {
    const cookie = await owner();
    const id = (await create()).body.id as string;
    await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', origin).send({ approval: { mode: 'paste', value: FAKE }, scope: 'machine_project' });
    expect((await create(mac, 'req-0009')).body).toMatchObject({ state: 'approved', auto: true });
    const grants = await request(app).get('/api/secrets/grants').set('Cookie', cookie);
    expect(grants.body.grants).toHaveLength(1);
    expect((await request(app).delete(`/api/secrets/grants/${grants.body.grants[0].id}`).set('Cookie', cookie).set('Origin', origin)).status).toBe(200);
    expect((await create(mac, 'req-0010')).body.state).toBe('pending');
  });

  it('la auditoría nunca contiene valores', async () => {
    const cookie = await owner();
    const id = (await create()).body.id as string;
    await request(app).post(`/api/secrets/requests/${id}/approve`).set('Cookie', cookie).set('Origin', origin).send({ approval: { mode: 'paste', value: FAKE }, scope: 'once' });
    await request(app).post(`/api/secrets/requests/${id}/claim`).set(mac);
    const audit = await request(app).get('/api/secrets/audit').set('Cookie', cookie);
    expect(audit.body.events.map((e: { event: string }) => e.event)).toEqual(['delivered', 'approved', 'created']);
    expect(JSON.stringify(audit.body)).not.toContain(FAKE);
  });
});

describe('búsqueda automática en la API', () => {
  const autoHeaders = { Authorization: 'Bearer auto-token' };
  beforeEach(async () => {
    app.locals.close();
    const base = await config();
    base.agentTokens.push({ name: 'auto', hash: tokenHash('auto-token'), scopes: ['read'], secretsPolicy: { projects: ['prod-erp'], autoDeliver: true } });
    vault = new MemoryVault();
    app = createApp(base, ':memory:', undefined, undefined, undefined, vault);
  });
  it('un ítem existente se entrega sin aprobación; el listado no expone valores', async () => {
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    const listed = await request(app).get('/api/secrets/available?project=prod-erp&environment=dev').set(autoHeaders);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i: { name: string }) => i.name)).toEqual(['OPENAI_API_KEY']);
    expect(JSON.stringify(listed.body)).not.toContain(FAKE);
    const created = await create(autoHeaders, 'req-auto-1');
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('approved');
    const claimed = await request(app).post(`/api/secrets/requests/${created.body.id}/claim`).set(autoHeaders);
    expect(claimed.body.value).toBe(FAKE);
  });
  it('sin ítem en la bóveda queda pendiente; fuera de la política, 403', async () => {
    expect((await create(autoHeaders, 'req-auto-2')).body.state).toBe('pending');
    expect((await request(app).get('/api/secrets/available?project=otro').set(autoHeaders)).status).toBe(403);
  });
  it('el listado es solo para agentes con política', async () => {
    const cookie = await owner();
    expect((await request(app).get('/api/secrets/available?project=prod-erp').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).get('/api/secrets/available?project=prod-erp').set(bare)).status).toBe(403);
  });
  it('un agente sin autoDeliver sigue esperando aunque el ítem exista', async () => {
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    expect((await create(mac, 'req-auto-3')).body.state).toBe('pending');
  });
});
