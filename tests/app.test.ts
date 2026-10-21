import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { hashPassword, tokenHash } from '../server/auth.js';
import { Store } from '../server/store.js';
import type { Resource, Adapter, Config } from '../server/types.js';
import { DesktopOfflineError } from '../server/operation-error.js';

const origin = 'https://control.example.test';
const resource: Resource = { id: 'aws:test:server', name: 'Servidor', kind: 'ec2', state: 'running', location: 'us-east-1', detail: 't3.small', account: 'test', actions: ['stop', 'refresh'], observedAt: new Date().toISOString() };
let config: Config;
const apps: ReturnType<typeof createApp>[] = [];
beforeAll(async () => { config = { origin, passwordHash: await hashPassword('una-clave-de-prueba-larga'), agentTokens: [{ name: 'test-agent', hash: tokenHash('test-agent-secret'), scopes: ['read', 'operate'] }], aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' } }; });
afterEach(() => { for (const app of apps.splice(0)) app.locals.close(); });
function setup(adapter?: Adapter) {
  const app = createApp(config, ':memory:', adapter ?? { inventory: async () => [resource], perform: async () => ({ message: 'Estado confirmado.' }) });
  apps.push(app); return app;
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
const bearer = { Authorization: 'Bearer test-agent-secret' };
describe('acceso y sesiones', () => {
  it('protege datos, operaciones y documentación', async () => {
    const app = setup();
    for (const path of ['/api/resources', '/api/operations', '/api/openapi.json']) expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });
  it('rechaza credenciales incorrectas y origen ajeno', async () => {
    const app = setup();
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' })).status).toBe(403);
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'wrong' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'admin', password: 'una-clave-de-prueba-larga' })).status).toBe(403);
  });
  it('usa cookies seguras, no cachea API y revoca sesión al salir', async () => {
    const app = setup(); const cookie = await login(app);
    const response = await request(app).get('/api/resources').set('Cookie', cookie);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toContain('no-store');
    const auth = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
    expect(auth.headers['set-cookie'][0]).toMatch(/HttpOnly/); expect(auth.headers['set-cookie'][0]).toMatch(/Secure/); expect(auth.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie).set('Origin', origin)).status).toBe(200);
    expect((await request(app).get('/api/resources').set('Cookie', cookie)).status).toBe(401);
  });
  it('no acepta tokens inválidos y limita intentos de login', async () => {
    const app = setup();
    expect((await request(app).get('/api/resources').set('Authorization', 'Bearer invalid')).status).toBe(401);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'wrong', password: 'wrong' });
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({})).status).toBe(429);
  });
});
describe('operaciones de infraestructura', () => {
  it('solo permite capacidades y recursos del inventario del servidor', async () => {
    const app = setup();
    for (const [resourceId, action] of [['unknown', 'stop'], [resource.id, 'shell'], [resource.id, 'start']]) {
      expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', crypto.randomUUID()).send({ resourceId, action, confirmed: true })).status).toBe(400);
    }
    expect((await request(app).post('/api/operations').set(bearer).send({ resourceId: resource.id, action: 'stop' })).status).toBe(400);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'a').send({ resourceId: resource.id, action: 'stop' })).status).toBe(400);
  });
  it('deduplica la misma orden y registra actor y verificación real', async () => {
    let calls = 0;
    const app = setup({ inventory: async () => [resource], perform: async () => { calls++; return { message: 'Estado detenido confirmado por AWS.' }; } });
    const body = { resourceId: resource.id, action: 'stop', confirmed: true };
    const first = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send(body);
    expect(first.status).toBe(202);
    const second = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send(body);
    expect(second.body.id).toBe(first.body.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    const op = await request(app).get(`/api/operations/${first.body.id}`).set(bearer);
    expect(calls).toBe(1); expect(op.body.state).toBe('succeeded'); expect(op.body.actor).toBe('test-agent');
    expect((await request(app).get('/api/operations').set(bearer)).body.operations).toHaveLength(1);
    const history=await request(app).get(`/api/operations/${first.body.id}/history`).set(bearer);
    expect(history.body.events.map((event:{payload:{state:string}})=>event.payload.state)).toEqual(['accepted','running','succeeded']);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send({ ...body, action: 'refresh' })).status).toBe(409);
  });
  it('persiste el progreso real de una operación de PC en el historial sin enviar otra orden', async () => {
    let calls = 0;
    const pc: Resource = { id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unreachable', location: 'Casa', detail: 'Dual boot', account: 'Casa', actions: ['start'], observedAt: new Date().toISOString() };
    const app = setup({ inventory: async () => [pc], perform: async (_resource, _action, onProgress) => {
      calls++;
      onProgress?.('WOL enviado por el túnel FiberHome; esperando el aviso de la PC.');
      return { message: 'CachyOS comunicó su arranque al panel.' };
    } });
    const created = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'pc-progress').send({ resourceId: pc.id, action: 'start', confirmed: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const history = await request(app).get(`/api/operations/${created.body.id}/history`).set(bearer);
    expect(calls).toBe(1);
    expect(history.body.events.map((event: { payload: { state: string; message: string } }) => [event.payload.state, event.payload.message])).toContainEqual(['running', 'WOL enviado por el túnel FiberHome; esperando el aviso de la PC.']);
    expect(history.body.events.at(-1).payload.message).toBe('CachyOS comunicó su arranque al panel.');
  });
  it('registra fallo sin filtrar el error del proveedor y conserva el resto del panel', async () => {
    const app = setup({ inventory: async () => [resource], perform: async () => { throw new Error('secret-provider-credential'); } });
    const first = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'fail').send({ resourceId: resource.id, action: 'refresh' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const op = await request(app).get(`/api/operations/${first.body.id}`).set(bearer);
    expect(op.body.state).toBe('failed'); expect(JSON.stringify(op.body)).not.toContain('secret-provider');
    expect((await request(app).get('/api/resources').set(bearer)).status).toBe(200);
  });
  it('bloquea operaciones simultáneas sobre el mismo equipo', async () => {
    let release!: () => void;
    const app = setup({ inventory: async () => [resource], perform: () => new Promise(resolve => { release = () => resolve({ message: 'Confirmado' }); }) });
    const body = { resourceId: resource.id, action: 'refresh' };
    await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'one').send(body);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'two').send(body)).status).toBe(409);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
  });
  it('rechaza una orden con 503 durante el relevo de despliegue y comunica Retry-After', async () => {
    const directory=mkdtempSync(join(tmpdir(),'infra-deploy-gate-')),path=join(directory,'infra.sqlite');
    const gateStore=new Store(path);
    gateStore.db.prepare("INSERT INTO settings(key,value) VALUES ('deployment-gate',?)").run(JSON.stringify({owner:'test-deploy',expiresAt:new Date(Date.now()+60000).toISOString()}));
    gateStore.close();
    const app=createApp(config,path,{inventory:async()=>[resource],perform:async()=>({message:'never called'})});apps.push(app);
    try{
      const response=await request(app).post('/api/operations').set(bearer).set('Idempotency-Key','deployment-denied').send({resourceId:resource.id,action:'stop',confirmed:true});
      expect(response.status).toBe(503);expect(response.headers['retry-after']).toBe('15');expect(response.body.error).toContain('despliegue');
      expect((await request(app).get('/api/operations').set(bearer)).body.operations).toHaveLength(0);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('rechaza CSRF incluso con sesión válida y restringe agentes de solo lectura', async () => {
    const app = setup(); const cookie = await login(app);
    expect((await request(app).post('/api/operations').set('Cookie', cookie).set('Origin', 'https://evil.example').set('Idempotency-Key', 'csrf').send({ resourceId: resource.id, action: 'stop', confirmed: true })).status).toBe(403);
    expect((await request(app).get('/api/operations/missing').set(bearer)).status).toBe(404);
    const readonly = createApp({ ...config, agentTokens: [{ name: 'read-only', hash: tokenHash('reader'), scopes: ['read'] }] }, ':memory:', { inventory: async () => [resource], perform: async () => { throw new Error('Must not execute'); } });
    apps.push(readonly);
    expect((await request(readonly).get('/api/resources').set('Authorization', 'Bearer reader')).status).toBe(200);
    expect((await request(readonly).post('/api/operations').set('Authorization', 'Bearer reader').set('Idempotency-Key', 'read-only').send({ resourceId: resource.id, action: 'stop', confirmed: true })).status).toBe(403);
  });
  it('conserva idempotencia en solicitudes concurrentes', async () => {
    let calls = 0;
    const app = setup({ inventory: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return [resource]; }, perform: async () => { calls++; return { message: 'Confirmed' }; } });
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'concurrent').send({ resourceId: resource.id, action: 'refresh' })));
    expect(responses.every(r => r.status === 202)).toBe(true); expect(new Set(responses.map(r => r.body.id)).size).toBe(1); expect(calls).toBe(1);
  });
  it('cambia contraseña desde sesión personal e invalida sesiones previas', async () => {
    const app = setup(); const cookie = await login(app);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set('Cookie', cookie).send({ current: 'wrong', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(401);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set('Cookie', cookie).send({ current: 'una-clave-de-prueba-larga', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(200);
    expect((await request(app).get('/api/resources').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(200);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set(bearer).send({ current: 'x', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(403);
  });
  it('valida cuerpos malformados y sirve documentación sin filtrar configuración', async () => {
    const app = setup();
    expect(typeof (await request(app).get('/api/resources').set(bearer)).body.cursor).toBe('number');
    const docs = await request(app).get('/api/openapi.json').set(bearer);
    expect(docs.status).toBe(200); expect(docs.body.openapi).toBe('3.1.0'); expect(JSON.stringify(docs.body)).not.toContain('test-agent-secret');
    expect((await request(app).get('/api/not-found').set(bearer)).status).toBe(404);
    expect((await request(app).get('/')).body.frontend).toBe('pending-design-approval');
    expect((await request(app).post('/api/operations').set(bearer).set('Content-Type', 'application/json').send('{not-json')).status).toBe(400);
  });

  it('guarda el sistema predeterminado como pendiente al estar fuera de línea y permite cancelarlo', async () => {
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => { throw new DesktopOfflineError(); },
      readBootDefault: async () => { throw new DesktopOfflineError(); }
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-offline')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ desired: 'windows', effective: null, state: 'pending', version: 1 });
    const snapshot = await request(app).get('/api/desktop/boot-preference').set(bearer);
    expect(snapshot.body.operationKey).toBeUndefined();
    expect(snapshot.body.state).toBe('pending');
    const cancelled = await request(app).delete('/api/desktop/boot-preference/pending')
      .set(bearer).send({ expectedVersion: 1 });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ desired: null, effective: null, state: 'unknown', version: 2 });
  });

  it('conserva el último firmware leído si el cambio queda pendiente', async () => {
    const observedAt = '2026-10-21T10:44:00.000Z';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => { throw new DesktopOfflineError(); },
      readBootDefault: async () => ({ defaultSystem: 'windows', observedAt })
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-observed-pending')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ desired: 'cachyos', effective: 'windows', state: 'pending', observedAt });
  });

  it('rechaza cambiar el arranque si la PC no confirma que el helper UEFI está instalado', async () => {
    let writes = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => { writes++; return { defaultSystem: system, verifiedAt: new Date().toISOString() }; },
      readBootDefault: async () => { throw new Error('UEFI helper unavailable'); }
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-unsupported')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/helper UEFI/i);
    expect(writes).toBe(0);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: null, effective: null, state: 'unknown', version: 0 });
  });

  it('reconcilia el default pendiente solo tras recibir un aviso nuevo de la PC', async () => {
    let reachable = false;
    let calls = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => {
        calls++;
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: system, verifiedAt: new Date().toISOString() };
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: 'windows', observedAt: new Date().toISOString() };
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    expect(pending.body.state).toBe('pending');
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-current', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    const snapshot = await request(app).get('/api/desktop/boot-preference').set(bearer);
    expect(snapshot.body).toMatchObject({ desired: 'cachyos', effective: 'cachyos', state: 'applied', version: 1 });
    expect(calls).toBe(2);
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-current', sequence: 2, event: 'heartbeat' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(2);
  });

  it('no aplica un default pendiente si la PC volvió pero no confirma capacidad UEFI', async () => {
    let reachable = false;
    let writes = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        writes++;
        throw new Error('Must not write without a verified UEFI helper');
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        throw new Error('UEFI helper unavailable');
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-unsupported')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    expect(pending.body.state).toBe('pending');
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-unsupported', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toBe(0);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: null, state: 'failed', version: 1 });
    const replay = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-unsupported')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(replay.status).toBe(409);
    expect(replay.body.state).toBe('failed');
  });

  it('conserva la lectura UEFI al reconciliar si la escritura vuelve a quedar fuera de línea', async () => {
    let reachable = false;
    let writes = 0;
    const observedAt = '2026-10-21T10:44:30.000Z';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        writes++;
        throw new DesktopOfflineError();
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: 'windows', observedAt };
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-observation')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-observation', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toBe(1);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: 'windows', state: 'pending', observedAt });
  });

  it('no repite la escritura UEFI ante dos solicitudes concurrentes con la misma clave', async () => {
    let writes = 0;
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { writeStarted = resolve; });
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => {
        writes++;
        if (writes === 1) {
          writeStarted?.();
          await writeGate;
        }
        return { defaultSystem: system, verifiedAt: new Date().toISOString() };
      },
      readBootDefault: async () => ({ defaultSystem: 'windows', observedAt: new Date().toISOString() })
    };
    const app = setup(adapter);
    const send = () => request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-concurrent')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    const firstPromise = new Promise<{ status: number }>((resolve, reject) => {
      send().end((error, response) => error ? reject(error) : resolve(response));
    });
    const firstOutcome = await Promise.race([
      started.then(() => 'started'),
      firstPromise.then(response => `response-${response.status}`),
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000))
    ]);
    expect(firstOutcome).toBe('started');
    const second = await send();
    expect(second.status).toBe(202);
    expect(second.body.state).toBe('applying');
    expect(writes).toBe(1);
    releaseWrite?.();
    expect((await firstPromise).status).toBe(200);
    expect(writes).toBe(1);
  });

  it('expone una comprobación UEFI explícita y convierte una divergencia en drift', async () => {
    let effective: 'windows' | 'cachyos' = 'windows';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => ({ defaultSystem: system, verifiedAt: new Date().toISOString() }),
      readBootDefault: async () => ({ defaultSystem: effective, observedAt: new Date().toISOString() })
    };
    const app = setup(adapter);
    const requestPreference = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-verified')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(requestPreference.status).toBe(200);
    expect(requestPreference.body).toMatchObject({ desired: 'windows', effective: 'windows', state: 'applied' });
    effective = 'cachyos';
    const observed = await request(app).get('/api/desktop/boot-preference/verify').set(bearer);
    expect(observed.status).toBe(200);
    expect(observed.body).toMatchObject({ desired: 'windows', effective: 'cachyos', state: 'drift' });
  });

  it('descarta una lectura UEFI que termina después de iniciar un cambio de arranque', async () => {
    let reads = 0;
    let releaseVerification: (() => void) | undefined;
    let verificationStarted: (() => void) | undefined;
    const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
    const started = new Promise<void>(resolve => { verificationStarted = resolve; });
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => ({ defaultSystem: system, verifiedAt: '2026-10-21T10:45:00.000Z' }),
      readBootDefault: async () => {
        reads++;
        if (reads === 1) {
          verificationStarted?.();
          await verificationGate;
        }
        return { defaultSystem: 'windows', observedAt: '2026-10-21T10:44:00.000Z' };
      }
    };
    const app = setup(adapter);
    const verification = new Promise<{ status: number }>((resolve, reject) => {
      request(app).get('/api/desktop/boot-preference/verify').set(bearer)
        .end((error, response) => error ? reject(error) : resolve(response));
    });
    await started;
    const applied = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-race')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(applied.status).toBe(200);
    releaseVerification?.();
    expect((await verification).status).toBe(409);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: 'cachyos', state: 'applied' });
  });
});
