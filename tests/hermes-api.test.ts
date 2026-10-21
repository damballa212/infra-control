import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { Config } from '../server/types.js';

const config: Config = {
  origin: 'https://test.example', passwordHash: 'unused',
  agentTokens: [{ name: 'reader', hash: tokenHash('reader-token'), scopes: ['read'] }],
  aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' },
  hermes: { resourceId: 'aws:agents:i-hermes', reportTokenHash: tokenHash('hermes-reporter-token-fixture') }
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => apps.splice(0).forEach(app => app.locals.close()));
function setup() { const app = createApp(config, ':memory:'); apps.push(app); return app; }
const sample = { version: 1, bootId: 'ec2-boot-2026-10-21', streamId: 'reporter-run-1', sequence: 1, serviceState: 'active', restartCount: 0 };

describe('ingesta autenticada de salud Hermes', () => {
  it('solo acepta el token exclusivo y publica estado de proceso separado del estado EC2', async () => {
    const app = setup();
    expect((await request(app).post('/api/hermes/events').set('Authorization', 'Bearer reader-token').send(sample)).status).toBe(401);
    expect((await request(app).post('/api/hermes/events').set('Authorization', 'Bearer hermes-reporter-token-fixture').send(sample)).status).toBe(204);
    const health = await request(app).get('/api/hermes/health').set('Authorization', 'Bearer reader-token');
    expect(health.body.telemetry).toMatchObject({ state: 'healthy', serviceState: 'active', restartCount: 0, resourceId: 'aws:agents:i-hermes' });
    expect((await request(app).get('/api/system/health').set('Authorization', 'Bearer reader-token')).body.hermes).toMatchObject({ state: 'healthy' });
  });

  it('rechaza campos ajenos, y devuelve 503 si el reporter no está configurado', async () => {
    const app = setup();
    expect((await request(app).post('/api/hermes/events').set('Authorization', 'Bearer hermes-reporter-token-fixture').send({ ...sample, conversation: 'must-not-be-ingested' })).status).toBe(400);
    const unconfigured = createApp({ ...config, hermes: undefined }, ':memory:'); apps.push(unconfigured);
    expect((await request(unconfigured).post('/api/hermes/events').set('Origin', config.origin).send(sample)).status).toBe(503);
    expect((await request(unconfigured).get('/api/hermes/health').set('Authorization', 'Bearer reader-token')).body.telemetry).toBeNull();
  });
});
