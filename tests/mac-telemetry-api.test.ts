import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { Config } from '../server/types.js';

const config: Config = {
  origin: 'https://test.example', passwordHash: 'unused',
  agentTokens: [{ name: 'reader', hash: tokenHash('reader-token'), scopes: ['read'] }],
  aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' },
  macTelemetryTokenHash: tokenHash('mac-reporter-token-fixture')
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => apps.splice(0).forEach(app => app.locals.close()));
function setup() { const app = createApp(config, ':memory:'); apps.push(app); return app; }
const event = { bootId: 'mac-1761032337', sequence: 1761032337, event: 'online' };

describe('ingesta exclusiva de presencia MacBook', () => {
  it('acepta token exclusivo y expone snapshot local sin acciones remotas', async () => {
    const app = setup();
    expect((await request(app).post('/api/mac/events').set('Authorization', 'Bearer reader-token').send(event)).status).toBe(401);
    expect((await request(app).post('/api/mac/events').set('Authorization', 'Bearer mac-reporter-token-fixture').send(event)).status).toBe(204);
    const health = await request(app).get('/api/mac/health').set('Authorization', 'Bearer reader-token');
    expect(health.body.resource).toMatchObject({ id: 'computer:mac', state: 'running', actions: [], health: { presence: { state: 'fresh' }, control: { state: 'unknown' }, service: { state: 'unknown' } } });
    const inventory = await request(app).get('/api/resources').set('Authorization', 'Bearer reader-token');
    expect(inventory.body.resources.find((row: { id: string }) => row.id === 'computer:mac').state).toBe('running');
  });

  it('acepta suspensión/despertar anunciados solo con el token Mac y expone las etapas públicas', async () => {
    const app = setup(), post = (body: object) => request(app).post('/api/mac/events').set('Authorization', 'Bearer mac-reporter-token-fixture').send(body);
    expect((await post(event)).status).toBe(204);
    expect((await post({ ...event, sequence: event.sequence + 1, event: 'sleep' })).status).toBe(204);
    const sleeping = await request(app).get('/api/mac/health').set('Authorization', 'Bearer reader-token');
    expect(sleeping.body.resource).toMatchObject({ state: 'asleep', health: { presence: { state: 'fresh', reasonCode: 'sleep_announced' } } });
    expect((await post({ ...event, sequence: event.sequence + 2, event: 'wake' })).status).toBe(204);
    const awake = await request(app).get('/api/mac/health').set('Authorization', 'Bearer reader-token');
    expect(awake.body.resource.state).toBe('running');
    expect((await post({ ...event, sequence: event.sequence + 3, event: 'screenSleep' })).status).toBe(400);
  });

  it('rechaza replay alterado y secuencia anterior, pero acepta duplicado exacto sin rejuvenecer', async () => {
    const app = setup(), post = (body: object) => request(app).post('/api/mac/events').set('Authorization', 'Bearer mac-reporter-token-fixture').send(body);
    expect((await post(event)).status).toBe(204);
    expect((await post(event)).status).toBe(204);
    expect((await post({ ...event, sequence: 1761032336 })).status).toBe(409);
    expect((await post({ ...event, sequence: 1761032338, event: 'heartbeat' })).status).toBe(204);
  });
});
