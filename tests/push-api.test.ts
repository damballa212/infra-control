import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { hashPassword, tokenHash } from '../server/auth.js';
import type { Config } from '../server/types.js';

const origin = 'https://control.example.test';
const vapid = createECDH('prime256v1');
vapid.setPrivateKey(Buffer.alloc(32, 2));
const push = {
  vapidPublicKey: vapid.getPublicKey('base64url'),
  vapidPrivateKey: vapid.getPrivateKey('base64url'),
  vapidSubject: 'mailto:owner@example.test',
  encryptionKeyHex: '1'.repeat(64)
};
let base: Config;
let app: ReturnType<typeof createApp>;
const send = vi.fn(async () => ({ statusCode: 201 }));

beforeEach(async () => {
  base = {
    origin,
    passwordHash: await hashPassword('una-clave-de-prueba-larga'),
    agentTokens: [{ name: 'reader', hash: tokenHash('reader-token'), scopes: ['read', 'operate'] }],
    aws: [],
    coolify: { url: '', token: '', resources: [] },
    acs: { url: '', deviceId: '' },
    push
  } as Config;
  send.mockClear();
  app = createApp(base, ':memory:', undefined, undefined, { send });
});

afterEach(() => app.locals.close());

async function ownerCookie() {
  const login = await request(app).post('/api/auth/login').set('Origin', origin)
    .send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
  return login.headers['set-cookie'][0].split(';')[0] as string;
}

const p256 = createECDH('prime256v1');
p256.generateKeys();
const subscription = {
  endpoint: 'https://web.push.apple.com/push-token-secret',
  expirationTime: null,
  keys: { p256dh: p256.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') }
};

describe('Web Push API', () => {
  it('expone solo la clave pública y permite crear/ver/revocar una suscripción desde la sesión humana', async () => {
    const cookie = await ownerCookie();
    const config = await request(app).get('/api/push/config').set('Cookie', cookie);
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ enabled: true, vapidPublicKey: push.vapidPublicKey });
    expect(JSON.stringify(config.body)).not.toContain(push.vapidPrivateKey);
    expect(JSON.stringify(config.body)).not.toContain(push.encryptionKeyHex);

    const created = await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
      .set('Origin', origin).send(subscription);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: expect.any(String), createdAt: expect.any(String) });
    expect(JSON.stringify(created.body)).not.toContain('push-token-secret');
    expect(JSON.stringify(created.body)).not.toContain(subscription.keys.auth);

    const listed = await request(app).get('/api/push/subscriptions').set('Cookie', cookie);
    expect(listed.body.subscriptions).toEqual([created.body]);
    expect(JSON.stringify(listed.body)).not.toContain('push-token-secret');
    const test = await request(app).post(`/api/push/subscriptions/${created.body.id}/test`).set('Cookie', cookie).set('Origin', origin);
    expect(test.status).toBe(202);
    expect(test.body).toMatchObject({ queued: true, expiresInSeconds: 60 });
    expect(test.body.message).toContain('no confirma');
    expect((await request(app).get('/api/push/status').set('Cookie', cookie)).body.pending).toBe(1);
    expect((await request(app).post(`/api/push/subscriptions/${created.body.id}/test`).set('Cookie', cookie).set('Origin', origin)).status).toBe(429);
    expect((await request(app).delete('/api/push/subscriptions/' + created.body.id)
      .set('Cookie', cookie).set('Origin', origin)).status).toBe(204);
    const remaining = await request(app).get('/api/push/subscriptions').set('Cookie', cookie);
    expect(remaining.body.subscriptions).toHaveLength(0);
  });

  it('rechaza tokens de agentes, origen ajeno y endpoints que podrían abusar del VPS', async () => {
    const forbidden = await request(app).post('/api/push/subscriptions').set('Authorization', 'Bearer reader-token')
      .set('Origin', origin).send(subscription);
    expect(forbidden.status).toBe(403);
    expect((await request(app).post('/api/push/subscriptions/00000000-0000-4000-8000-000000000000/test')
      .set('Authorization', 'Bearer reader-token').set('Origin', origin)).status).toBe(403);

    const cookie = await ownerCookie();
    expect((await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
      .set('Origin', 'https://evil.example').send(subscription)).status).toBe(403);
    for (const endpoint of ['http://127.0.0.1:17600/admin', 'https://127.0.0.1/metadata', 'https://evil.example/push']) {
      const result = await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
        .set('Origin', origin).send({ ...subscription, endpoint });
      expect(result.status).toBe(400);
    }
  });

  it('no acepta cuerpos adicionales ni crea suscripciones si Web Push no está configurado', async () => {
    const cookie = await ownerCookie();
    const invalid = await request(app).post('/api/push/subscriptions').set('Cookie', cookie)
      .set('Origin', origin).send({ ...subscription, extra: 'secret' });
    expect(invalid.status).toBe(400);

    app.locals.close();
    app = createApp({ ...base, push: undefined }, ':memory:');
    const login = await request(app).post('/api/auth/login').set('Origin', origin)
      .send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
    const disabledCookie = login.headers['set-cookie'][0].split(';')[0] as string;
    expect((await request(app).get('/api/push/config').set('Cookie', disabledCookie)).body).toEqual({ enabled: false, vapidPublicKey: null });
    expect((await request(app).post('/api/push/subscriptions').set('Cookie', disabledCookie)
      .set('Origin', origin).send(subscription)).status).toBe(503);
  });
});
