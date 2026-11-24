import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushService, type PushTransport, type WebPushSubscription } from '../server/push.js';
import { SecretsService, type SecretRequest } from '../server/secrets.js';
import { MemoryVault } from '../server/secrets-vault.js';
import { Store } from '../server/store.js';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ lookup: dnsLookup }));

const vapid = createECDH('prime256v1');
vapid.setPrivateKey(Buffer.alloc(32, 1));
const config = {
  vapidPublicKey: vapid.getPublicKey('base64url'), vapidPrivateKey: vapid.getPrivateKey('base64url'),
  vapidSubject: 'mailto:owner@example.test', encryptionKeyHex: '2'.repeat(64)
};
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const subscription: WebPushSubscription = {
  endpoint: 'https://web.push.apple.com/opaque-device',
  keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') }
};
const input = {
  name: 'OPENAI_API_KEY', project: 'prod-erp', environment: 'dev', machine: 'EC2 - Claude Code',
  reason: 'pruebas locales', destination: { kind: 'dotenv' as const, path: '.env.local' }
};

function setup() {
  const store = new Store(':memory:');
  const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
  const push = new PushService(store, config, { send });
  const pending: SecretRequest[] = [];
  const secrets = new SecretsService(store, new MemoryVault(), Date.now, request => { pending.push(request); push.notifySecretRequest(request); });
  return { store, send, push, secrets, pending, close: () => { push.close(); store.close(); } };
}

describe('aviso push de solicitudes de secretos', () => {
  it('una solicitud nueva avisa con quién pide, qué y el enlace para aprobar, sin valores', async () => {
    const t = setup();
    t.push.register(subscription);
    const request = t.secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1');
    await t.push.flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(t.send.mock.calls[0]![1]);
    expect(payload).toMatchObject({
      category: 'secrets', title: 'Clave pedida: OPENAI_API_KEY', url: `/secretos/${request.id}`,
      body: 'EC2 - Claude Code · prod-erp/dev · pruebas locales', icon: '/icon-192.png'
    });
    expect(Date.parse(payload.expiresAt)).toBe(Date.parse(request.expiresAt));
    t.close();
  });

  it('reintentar la misma solicitud o un permiso automático no vuelven a avisar', async () => {
    const t = setup();
    t.push.register(subscription);
    const first = t.secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1');
    t.secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1');
    await t.secrets.approve(first.id, { mode: 'paste', value: 'FAKE_ONLY_x' }, 'machine_project');
    expect(t.secrets.create('claude-ec2', { projects: ['*'] }, input, 'k2').state).toBe('approved');
    await t.push.flush();
    expect(t.pending.map(r => r.id)).toEqual([first.id]);
    expect(t.send).toHaveBeenCalledTimes(1);
    t.close();
  });

  it('respeta el interruptor «secrets» y trata como activo un dispositivo registrado antes de existir', async () => {
    const t = setup();
    const device = t.push.register(subscription);
    t.store.db.prepare('UPDATE push_subscriptions SET preferences=? WHERE id=?')
      .run(JSON.stringify({ operations: true, devices: true, router: true, infrastructure: true, budgets: true }), device.id);
    expect(t.push.list()[0]!.preferences.secrets).toBe(true);
    t.push.updatePreferences(device.id, { ...t.push.list()[0]!.preferences, secrets: false });
    t.secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1');
    await t.push.flush();
    expect(t.send).not.toHaveBeenCalled();
    t.close();
  });

  it('si el aviso falla la solicitud se crea igual', () => {
    const store = new Store(':memory:');
    const secrets = new SecretsService(store, new MemoryVault(), Date.now, () => { throw new Error('push caído'); });
    expect(secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1').state).toBe('pending');
    store.close();
  });
});

describe('entregas automáticas y vencimientos', () => {
  it('avisa (informativo, sin valor) al reclamar una entrega automática y respeta su preferencia', async () => {
    const store = new Store(':memory:');
    const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    const push = new PushService(store, config, { send });
    const vault = new MemoryVault();
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, 'FAKE_ONLY_valor');
    const secrets = new SecretsService(store, vault, Date.now, undefined, { onAutoDelivered: r => push.notifySecretDelivered(r) });
    push.register(subscription);
    const policy = { projects: ['*'], autoDeliver: true };
    const request = await secrets.request('claude-ec2', policy, input, 'k1');
    expect(request.state).toBe('approved');
    await push.flush();
    expect(send).not.toHaveBeenCalled();
    await secrets.claim(request.id, 'claude-ec2');
    await push.flush();
    const payload = JSON.parse(send.mock.calls[0]![1]);
    expect(payload).toMatchObject({ category: 'secretDeliveries', title: 'EC2 - Claude Code recibió OPENAI_API_KEY' });
    expect(JSON.stringify(payload)).not.toContain('FAKE_ONLY_valor');
    const [device] = push.list();
    push.updatePreferences(device!.id, { ...device!.preferences, secretDeliveries: false });
    const second = await secrets.request('claude-ec2', policy, { ...input, name: 'OPENAI_API_KEY', environment: 'dev' }, 'k2');
    await secrets.claim(second.id, 'claude-ec2');
    await push.flush();
    expect(send).toHaveBeenCalledTimes(1);
    push.close(); store.close();
  });

  it('una solicitud sin decidir dura 24 h por defecto y avisa al vencer', async () => {
    const store = new Store(':memory:');
    const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    const push = new PushService(store, config, { send });
    let now = Date.now();
    const secrets = new SecretsService(store, new MemoryVault(), () => now, undefined, { onExpiredPending: r => push.notifySecretExpired(r) });
    push.register(subscription);
    const request = secrets.create('claude-ec2', { projects: ['*'] }, input, 'k1');
    expect(Date.parse(request.expiresAt) - now).toBe(24 * 3_600_000);
    now += 25 * 3_600_000;
    expect(secrets.sweepExpired()).toBe(1);
    expect(secrets.get(request.id)?.state).toBe('expired');
    await push.flush();
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ category: 'secrets', title: 'Solicitud vencida: OPENAI_API_KEY' });
    secrets.sweepExpired();
    await push.flush();
    expect(send).toHaveBeenCalledTimes(1);
    push.close(); store.close();
  });
});
