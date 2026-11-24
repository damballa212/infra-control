import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushService, notificationForEvent, type PushTransport, type WebPushSubscription } from '../server/push.js';
import { Store } from '../server/store.js';
import type { ServiceProbeSignal } from '../server/types.js';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ lookup: dnsLookup }));
afterEach(() => vi.useRealTimers());

const vapid = createECDH('prime256v1');
// Fixed test scalar: random ECDH private keys can serialize to only 31 bytes.
vapid.setPrivateKey(Buffer.alloc(32, 1));
const config = {
  vapidPublicKey: vapid.getPublicKey('base64url'), vapidPrivateKey: vapid.getPrivateKey('base64url'),
  vapidSubject: 'mailto:owner@example.test', encryptionKeyHex: '2'.repeat(64),
  signalLoss: { desktop: true, mac: true }
};
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const subscription: WebPushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-device-capability',
  keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') }
};
const operation = (state: string, id = 'op-1', now = Date.now()) => ({
  id, resourceId: 'computer:desktop', resourceName: 'PC de casa', action: 'start', actor: 'Admin',
  state, message: state === 'succeeded' ? 'CachyOS comunicó su inicio.' : 'Ejecutando',
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
});

describe('Web Push durable delivery', () => {
  it('avisa cobertura incompleta y solo anuncia recuperación tras una pérdida entregada', () => {
    const base={id:1,type:'coverage' as const,aggregateId:'coverage:one:aws:regions',createdAt:new Date().toISOString()};
    const outage=notificationForEvent({...base,payload:{connectionId:'one',connectionName:'Cuenta AWS',scopeKey:'aws:regions',previousState:'healthy',state:'partial'}});
    expect(outage).toMatchObject({category:'infrastructure',title:'Inventario incompleto',url:'/',icon:'/icon-192.png',body:expect.stringContaining('datos pueden estar atrasados'),policy:{holdSeconds:90,coalesce:true}});
    const recovery=notificationForEvent({...base,id:2,payload:{connectionId:'one',connectionName:'Cuenta AWS',scopeKey:'aws:regions',previousState:'partial',state:'healthy'}});
    expect(recovery).toMatchObject({title:'Inventario actualizado',policy:{recoveryNeedsLoss:true}});
    expect(recovery?.policy?.recoversKey).toBe(outage?.policy?.lossKey);
    expect(recovery?.tag).not.toBe(outage?.tag);
    expect(notificationForEvent({...base,payload:{connectionId:'one',connectionName:'Cuenta AWS',scopeKey:'aws:regions',previousState:'unknown',state:'healthy'}})).toBeUndefined();
  });

  it('cifra capacidades de suscripción y emite una sola notificación profesional al concluir una orden', async () => {
    const store = new Store(':memory:');
    const send = vi.fn<PushTransport['send']>(async (_subscription, _payload, _options) => ({ statusCode: 201 }));
    const service = new PushService(store, config, { send } satisfies PushTransport);
    const registered = service.register(subscription);
    const raw = store.db.prepare('SELECT ciphertext FROM push_subscriptions WHERE id=?').get(registered.id) as {ciphertext:string};
    expect(raw.ciphertext).not.toContain(subscription.endpoint);
    expect(raw.ciphertext).not.toContain(subscription.keys.auth);
    expect(service.list()).toMatchObject([{ id: registered.id, preferences: { operations: true } }]);

    store.appendEvent('operation', 'operation:op-1', operation('running'));
    await service.flush();
    expect(send).not.toHaveBeenCalled();
    store.appendEvent('operation', 'operation:op-1', operation('succeeded'));
    await service.flush();
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const [decoded, payload, options] = send.mock.calls[0]!;
    expect(decoded).toEqual(subscription);
    expect(JSON.parse(payload)).toMatchObject({ title: 'PC de casa encendida', body: 'Orden completada.', icon: '/icon-192.png', badge: '/icon-192.png' });
    expect(options).toMatchObject({ TTL: 600, urgency: 'high', timeout: 8000 });
    expect(store.pushOutboxCount()).toBe(0);
    service.close(); store.close();
  });

  it('reconstruye los ciclos Push existentes antes de reanudar el cursor de eventos', async () => {
    const store = new Store(':memory:');
    const seed = new PushService(store, config, {send:async()=>({statusCode:201})});
    const subscriptionId=seed.register(subscription).id;seed.close();
    store.db.prepare("DELETE FROM settings WHERE key='push-signal-state-bootstrap-v1'").run();
    const lossId=store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
    const recoveryId=store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_recovered'});
    const [lossEvent,recoveryEvent]=store.eventsAfter(0,10);
    const lossKey=notificationForEvent(lossEvent!)!.policy!.lossKey!;
    const recoveredKey=notificationForEvent(recoveryEvent!)!.policy!.recoversKey!;
    const created=Date.now()-2000;
    store.enqueuePush(String(lossId),subscriptionId,{lossKey},created);
    const sent=store.claimPush(Date.now())!;store.finishPush(sent.id,'sent',Date.now(),null,new Date(created).toISOString());
    store.enqueuePush(String(recoveryId),subscriptionId,{recoversKey:recoveredKey},created+1);
    const dead=store.claimPush(Date.now())!;store.finishPush(dead.id,'dead',Date.now(),'http_400');
    store.db.exec(`CREATE TABLE push_signal_events (
      subscription_id TEXT NOT NULL,signal_key TEXT NOT NULL,event_id INTEGER NOT NULL,
      signal TEXT NOT NULL CHECK(signal IN ('loss','recovery')),
      PRIMARY KEY(subscription_id,signal_key,event_id),
      FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE)`);
    store.db.prepare('INSERT INTO push_signal_events(subscription_id,signal_key,event_id,signal) VALUES (?,?,?,?)').run(subscriptionId,lossKey,lossId,'loss');
    store.db.prepare('INSERT INTO push_signal_events(subscription_id,signal_key,event_id,signal) VALUES (?,?,?,?)').run(subscriptionId,lossKey,recoveryId,'recovery');
    store.setPushCursor(recoveryId);

    let now=Date.now();
    const send=vi.fn<PushTransport['send']>(async()=>({statusCode:201}));
    const service=new PushService(store,config,{send},()=>now);
    expect(store.db.prepare('SELECT event_id AS eventId,signal,previous_signal AS previousSignal FROM push_signal_state WHERE subscription_id=? AND signal_key=?').get(subscriptionId,lossKey)).toEqual({eventId:recoveryId,signal:'recovery',previousSignal:'loss'});
    expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_signal_events'").get()).toBeUndefined();
    const nextLoss=store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
    await service.flush();now+=181_000;await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({title:'FiberHome sin telemetría'});
    expect(nextLoss).toBeGreaterThan(recoveryId);
    service.close();store.close();
  });

  it('marca desconocido un ciclo cuyo historial quedó fuera de la retención y permite alertar de nuevo', async () => {
    const store=new Store(':memory:');
    const seed=new PushService(store,config,{send:async()=>({statusCode:201})});
    const subscriptionId=seed.register(subscription).id;seed.close();
    store.db.prepare("DELETE FROM settings WHERE key='push-signal-state-bootstrap-v1'").run();
    const lossId=store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
    const lossKey=notificationForEvent(store.eventsAfter(lossId-1,1)[0]!)!.policy!.lossKey!;
    store.enqueuePush(String(lossId),subscriptionId,{lossKey},Date.now()-2000);
    const sent=store.claimPush()!;store.finishPush(sent.id,'sent',Date.now(),null,new Date().toISOString());
    store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_recovered'});
    const cursor=store.appendEvent('resource','unrelated',{state:'running'});
    store.db.prepare('DELETE FROM event_log WHERE id<?').run(cursor);
    store.setPushCursor(cursor);
    let now=Date.now();
    const send=vi.fn<PushTransport['send']>(async()=>({statusCode:201}));
    const service=new PushService(store,config,{send},()=>now);
    expect(store.db.prepare('SELECT event_id AS eventId,signal FROM push_signal_state WHERE subscription_id=? AND signal_key=?').get(subscriptionId,lossKey)).toEqual({eventId:cursor,signal:'unknown'});
    store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
    await service.flush();now+=181_000;await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({title:'FiberHome sin telemetría'});
    service.close();store.close();
  });

  it('entrega el estado de la PC al instante y retiene la señal perdida de la Mac', async () => {
    const store = new Store(':memory:');
    const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    const service = new PushService(store, config, { send });
    service.register(subscription);
    store.appendEvent('desktop', 'computer:desktop', { id: 'computer:desktop', state: 'running', system: 'windows' });
    await service.flush();
    store.appendEvent('resource', 'computer:mac', { id: 'computer:mac', state: 'unreachable', transitionReason: 'telemetry_timeout' });
    await service.flush();

    const messages = send.mock.calls.map(([, payload]) => JSON.parse(payload));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      category: 'devices', title: 'PC de casa en línea', body: 'Windows ya inició.',
      icon: '/icon-192.png', badge: '/icon-192.png', url: '/equipo/computer%3Adesktop'
    });
    expect(messages[0]).not.toHaveProperty('policy');
    service.close(); store.close();
  });

  it('preserva las preferencias desactivadas al renovar el mismo endpoint', () => {
    const store = new Store(':memory:');
    const service = new PushService(store, config, { send: async () => ({ statusCode: 201 }) });
    const registered = service.register(subscription);
    const preferences = { operations: false, devices: true, router: false, infrastructure: true, budgets: false, secrets: false, secretDeliveries: false };
    expect(service.updatePreferences(registered.id, preferences)).toBe(true);
    const renewed = service.register({ ...subscription, expirationTime: Date.now() + 30 * 86400_000 });
    expect(renewed.id).toBe(registered.id);
    expect(renewed.preferences).toEqual(preferences);
    service.close(); store.close();
  });

  it('respeta preferencias, reintenta con Retry-After y revoca suscripciones 404/410', async () => {
    // Store y el consumidor deben compartir reloj: createdAt también gobierna la retención.
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new Store(':memory:');
    let now = Date.now();
    const throttled = Object.assign(new Error('private endpoint value'), { statusCode: 429, headers: { 'retry-after': '60' } });
    const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    send.mockRejectedValueOnce(throttled);
    const service = new PushService(store, config, { send } satisfies PushTransport, () => now);
    const registered = service.register(subscription);
    expect(service.updatePreferences(registered.id, { operations: false, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true })).toBe(true);
    store.appendEvent('operation', 'operation:op-1', operation('succeeded', 'op-1', now));
    await service.flush();
    expect(send).not.toHaveBeenCalled();

    expect(service.updatePreferences(registered.id, { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true })).toBe(true);
    store.appendEvent('operation', 'operation:op-2', operation('succeeded', 'op-2', now));
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const due = store.db.prepare('SELECT state,next_attempt_at,last_error_code FROM push_outbox').get() as {state:string;next_attempt_at:number;last_error_code:string};
    expect(due).toMatchObject({ state: 'pending', next_attempt_at: now + 60000, last_error_code: 'http_429' });
    now += 59999; await service.flush(); expect(send).toHaveBeenCalledTimes(1);
    now += 1; await service.flush(); expect(send).toHaveBeenCalledTimes(2);

    const expiredSend = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    expiredSend.mockRejectedValue(Object.assign(new Error('private endpoint value'), { statusCode: 410 }));
    const second = new PushService(store, config, { send: expiredSend }, () => now);
    const another = second.register({ ...subscription, endpoint: 'https://web.push.apple.com/another-capability' });
    store.appendEvent('operation', 'operation:op-3', operation('failed', 'op-3', now));
    await second.flush();
    expect(second.list().map(item => item.id)).not.toContain(another.id);
    expect(JSON.stringify(store.db.prepare('SELECT last_error_code FROM push_outbox').all())).not.toContain('private endpoint value');
    service.close(); second.close(); store.close();
  });

  it('no interpreta la pérdida de telemetría del router como caída de Internet', () => {
    const notification = notificationForEvent({
      id: 1, type: 'resource', aggregateId: 'router:fiberhome', createdAt: '2026-10-21T00:00:00Z',
      payload: { transitionReason: 'telemetry_timeout', state: 'stale' }
    });
    expect(notification).toMatchObject({ title: 'FiberHome sin telemetría' });
    expect(notification?.body).toContain('No confirma que se haya caído Internet');
    expect(notificationForEvent({
      id: 2, type: 'incident', aggregateId: 'router:fiberhome', createdAt: '2026-10-21T00:00:00Z',
      payload: { category: 'infrastructure', transitionReason: 'telemetry_timeout', silenceSeconds: 90 }
    })).toMatchObject({ title: 'FiberHome sin telemetría', body: expect.stringContaining('No confirma'), category: 'router' });
    expect(notificationForEvent({
      id: 3, type: 'resource', aggregateId: 'router:fiberhome', createdAt: '2026-10-21T00:00:00Z',
      payload: { transitionReason: 'router_tunnel_probe_failed' }
    })).toBeUndefined();
  });

  it('redacta las órdenes en lenguaje de persona y fusiona los avisos de energía de la PC en uno', () => {
    const event = (type: 'desktop' | 'operation', aggregateId: string, payload: Record<string, unknown>) => ({
      id: 8, type, aggregateId, createdAt: new Date().toISOString(), payload
    });
    const stopped = notificationForEvent(event('operation', 'operation:o1', { id: 'o1', state: 'succeeded', action: 'stop', resourceId: 'computer:desktop', resourceName: 'PC de casa', message: 'texto técnico' }));
    expect(stopped).toMatchObject({ title: 'PC de casa apagada', body: 'Orden completada.' });
    const announced = notificationForEvent(event('desktop', 'computer:desktop', { state: 'stopped' }));
    expect(announced?.tag).toBe(stopped?.tag);
    const ec2 = notificationForEvent(event('operation', 'operation:o2', { id: 'o2', state: 'succeeded', action: 'stop', resourceId: 'aws:x:i-1', resourceName: 'orchestrator' }));
    expect(ec2).toMatchObject({ title: 'orchestrator apagada' });
    expect(ec2?.tag).not.toBe(stopped?.tag);
    expect(notificationForEvent(event('operation', 'operation:o3', { id: 'o3', state: 'failed', action: 'boot-windows', resourceId: 'computer:desktop', resourceName: 'PC de casa', message: 'La PC no respondió.' })))
      .toMatchObject({ title: 'No se pudo iniciar Windows en PC de casa', body: 'La PC no respondió.' });
    expect(notificationForEvent(event('operation', 'operation:o4', { id: 'o4', state: 'succeeded', action: 'refresh', resourceId: 'aws:x:i-1', resourceName: 'orchestrator' }))).toBeUndefined();
  });

  describe('reglas de entrega', () => {
    const HOLD_MS = 180_000;
    const setup = () => {
      let now = Date.now();
      const store = new Store(':memory:');
      const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
      const service = new PushService(store, config, { send }, () => now);
      service.register(subscription);
      const titles = () => send.mock.calls.map(([, payload]) => (JSON.parse(payload) as { title: string }).title);
      const advance = async (ms: number) => { now += ms; await service.flush(); };
      return { store, send, service, titles, advance, close: () => { service.close(); store.close(); } };
    };
    const desktop = (state: string, system = 'windows') => ({ id: 'computer:desktop', state, system });

    it('retiene «sin señal» y no avisa un parpadeo que se recupera a tiempo', async () => {
      const { store, service, send, titles, advance, close } = setup();
      store.appendEvent('desktop', 'computer:desktop', desktop('unreachable'));
      await service.flush();
      expect(send).not.toHaveBeenCalled();
      await advance(30_000);
      store.appendEvent('desktop', 'computer:desktop', desktop('running'));
      await advance(1000);
      await advance(HOLD_MS);
      expect(titles()).toEqual([]);
      close();
    });

    it('entrega «sin señal» tras la espera y luego avisa la recuperación', async () => {
      const { store, service, titles, advance, close } = setup();
      store.appendEvent('desktop', 'computer:desktop', desktop('unreachable'));
      await service.flush();
      await advance(HOLD_MS + 1000);
      expect(titles()).toEqual(['PC de casa sin señal']);
      store.appendEvent('desktop', 'computer:desktop', desktop('running'));
      await advance(1000);
      expect(titles()).toEqual(['PC de casa sin señal', 'PC de casa en línea']);
      close();
    });

    it('no avisa la recuperación de la Mac ni del router si su pérdida nunca se entregó', async () => {
      const { store, service, send, close } = setup();
      store.appendEvent('resource', 'computer:mac', { id: 'computer:mac', state: 'running', transitionReason: 'telemetry_recovered' });
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_recovered' });
      await service.flush();
      expect(send).not.toHaveBeenCalled();
      close();
    });

    it('avisa la recuperación del router una sola vez tras una pérdida entregada', async () => {
      const { store, service, titles, advance, close } = setup();
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_timeout' });
      await service.flush();
      await advance(HOLD_MS + 1000);
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_recovered' });
      await advance(1000);
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_recovered' });
      await advance(1000);
      expect(titles()).toEqual(['FiberHome sin telemetría', 'FiberHome de vuelta']);
      close();
    });

    it('avisa una nueva pérdida de cobertura después de una recuperación reciente', async () => {
      const {store,service,titles,advance,close}=setup();
      const append=(state:'partial'|'healthy',previousState:'healthy'|'partial')=>store.appendEvent('coverage','coverage:one:aws:regions',{
        connectionId:'one',connectionName:'Cuenta AWS',scopeKey:'aws:regions',previousState,state
      });
      append('partial','healthy');await service.flush();await advance(91_000);
      append('healthy','partial');await advance(1_000);
      append('partial','healthy');await service.flush();await advance(91_000);
      expect(titles()).toEqual(['Inventario incompleto','Inventario actualizado','Inventario incompleto']);
      close();
    });

    it('invalida ciclos Push cuando el cursor pierde eventos durante la ejecución', async () => {
      const {store,service,send,advance,close}=setup();
      const lossId=store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
      await service.flush();await advance(HOLD_MS+1000);
      expect(send).toHaveBeenCalledTimes(1);
      store.appendEvent('resource','unrelated-one',{state:'running'});
      const newest=store.appendEvent('resource','unrelated-two',{state:'running'});
      store.db.prepare('DELETE FROM event_log WHERE id<?').run(newest);
      store.setPushCursor(lossId);
      await service.flush();
      expect(store.db.prepare('SELECT event_id AS eventId,signal FROM push_signal_state').get()).toEqual({eventId:newest,signal:'unknown'});
      store.appendEvent('resource','router:fiberhome',{id:'router:fiberhome',transitionReason:'telemetry_timeout'});
      await service.flush();await advance(HOLD_MS+1000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(send.mock.calls[1]![1])).toMatchObject({title:'FiberHome sin telemetría'});
      close();
    });

    it('vuelve a avisar una nueva pérdida aunque el Push de recuperación anterior haya terminado en dead', async () => {
      const { store, service, send, advance, close } = setup();
      send.mockResolvedValueOnce({ statusCode: 201 }).mockResolvedValueOnce({ statusCode: 400 }).mockResolvedValueOnce({ statusCode: 201 });
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_timeout' });
      await service.flush();
      await advance(HOLD_MS + 1000);
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_recovered' });
      await advance(1000);
      store.appendEvent('resource', 'router:fiberhome', { id: 'router:fiberhome', transitionReason: 'telemetry_timeout' });
      await service.flush();
      await advance(HOLD_MS + 1000);
      expect(send).toHaveBeenCalledTimes(3);
      expect(store.db.prepare("SELECT state FROM push_outbox ORDER BY event_key").all()).toEqual([{state:'sent'},{state:'dead'},{state:'sent'}]);
      close();
    });

    it('cancela una alerta de servicio si vuelve sano durante la ventana de confirmación',async()=>{
      const {store,service,titles,advance,close}=setup(),resourceId='catalog:service-1',base=Date.now();
      const sample=(state:ServiceProbeSignal['state'],offset:number):ServiceProbeSignal=>({state,source:'https-probe',observedAt:new Date(base+offset).toISOString(),freshUntil:new Date(base+offset+120_000).toISOString(),reasonCode:state==='unhealthy'?'probe_unexpected_http_status':state==='healthy'?'probe_http_ok':'probe_dns_failed'});
      store.recordServiceProbe(resourceId,sample('unhealthy',0),base);
      await service.flush();await advance(30_000);
      store.recordServiceProbe(resourceId,sample('unknown',30_000),base+30_000);await service.flush();
      store.recordServiceProbe(resourceId,sample('healthy',31_000),base+31_000);
      await advance(1000);await advance(120_000);
      expect(titles()).toEqual([]);close();
    });

    it('avisa un fallo sostenido y su recuperación, con título y motivo claros',async()=>{
      const {store,service,titles,advance,close}=setup(),resourceId='catalog:service-1';
      const base=Date.now();
      store.recordServiceProbe(resourceId,{state:'unhealthy',source:'https-probe',observedAt:new Date(base).toISOString(),freshUntil:new Date(base+300_000).toISOString(),reasonCode:'probe_unexpected_http_status'},base);
      await service.flush();await advance(121_000);
      expect(titles()).toEqual(['Servicio sin respuesta']);
      store.recordServiceProbe(resourceId,{state:'healthy',source:'https-probe',observedAt:new Date(base+121_000).toISOString(),freshUntil:new Date(base+421_000).toISOString(),reasonCode:'probe_http_ok'},base+121_000);
      await advance(1000);
      expect(titles()).toEqual(['Servicio sin respuesta','Servicio recuperado']);close();
    });

    it('conserva dos hechos de PC si el fixture no acredita una relación causal', async () => {
      const { store, service, titles, advance, close } = setup();
      store.appendEvent('desktop', 'computer:desktop', desktop('stopped'));
      store.appendEvent('operation', 'operation:o1', { id: 'o1', state: 'succeeded', action: 'stop', resourceId: 'computer:desktop', resourceName: 'PC de casa' });
      await advance(1000);
      expect(titles()).toHaveLength(2);
      close();
    });

    it('nunca funde un fallo con otro aviso', async () => {
      const { store, service, titles, advance, close } = setup();
      store.appendEvent('desktop', 'computer:desktop', desktop('running'));
      store.appendEvent('operation', 'operation:o2', { id: 'o2', state: 'failed', action: 'boot-windows', resourceId: 'computer:desktop', resourceName: 'PC de casa', message: 'La PC no respondió.' });
      await advance(1000);
      expect([...titles()].sort()).toEqual(['No se pudo iniciar Windows en PC de casa', 'PC de casa en línea']);
      close();
    });

    it('traduce un cambio de proveedor sin una orden del panel', () => {
      expect(notificationForEvent({
        id: 20, type: 'incident', aggregateId: 'aws:x:i-1', createdAt: '2026-10-21T00:00:00Z',
        payload: { category: 'infrastructure', resourceId: 'aws:x:i-1', resourceName: 'prod-erp', from: 'running', to: 'stopped' }
      })).toMatchObject({ title: 'prod-erp se detuvo', body: 'Pasó de encendida a detenida sin una orden del panel.', category: 'infrastructure' });
    });
  });

  it('explica la salud real de Hermes y muestra valor contra límite en avisos AWS', () => {
    const failure = notificationForEvent({
      id: 11, type: 'incident', aggregateId: 'hermes:orchestrator', createdAt: '2026-10-21T00:00:00Z',
      payload: { category: 'infrastructure', resourceId: 'aws:agents:i-hermes', from: 'healthy', to: 'unhealthy', serviceState: 'failed' }
    });
    expect(failure).toMatchObject({ title: 'Hermes caído', url: '/equipo/aws%3Aagents%3Ai-hermes' });
    expect(failure?.body).toContain('La instancia puede seguir encendida');
    expect(failure?.ttlSeconds).toBe(900);
    const budget = notificationForEvent({
      id: 12, type: 'incident', aggregateId: 'budget:agents', createdAt: '2026-10-21T00:00:00Z',
      payload: { category: 'budget', account: 'agents', budgetName: 'Mensual', threshold: 80, percent: 85, amount: 85, limit: 100, currency: 'USD', source: 'actual', asOf: '2026-10-21' }
    });
    expect(budget?.body).toContain('85%');
    expect(budget?.body).toContain('US$');
    expect(budget?.body).toContain('100');
    expect(budget?.ttlSeconds).toBe(86400);
  });

  it('no intenta entregar eventos vencidos durante una caída del panel', async () => {
    const store = new Store(':memory:');
    const send = vi.fn<PushTransport['send']>(async () => ({ statusCode: 201 }));
    const now = Date.now(), service = new PushService(store, config, { send }, () => now);
    service.register(subscription);
    const eventId = store.appendEvent('operation', 'operation:old', operation('succeeded', 'old', now - 11 * 60_000));
    store.db.prepare('UPDATE event_log SET created_at=? WHERE id=?').run(new Date(now - 11 * 60_000).toISOString(), eventId);
    await service.flush();
    expect(send).not.toHaveBeenCalled();
    service.close(); store.close();
  });

  it('limpia historial terminado sin borrar entregas pendientes ni deduplicadores recientes', () => {
    const store = new Store(':memory:');
    const service = new PushService(store, config, { send: async () => ({ statusCode: 201 }) });
    const subscriptionId = service.register(subscription).id;
    const now = Date.now(), old = now - 31 * 86400000;
    store.enqueuePush('old-delivery', subscriptionId, { title: 'old' }, old);
    const claimed = store.claimPush(now)!;
    store.finishPush(claimed.id, 'sent', now, null, new Date(old).toISOString());
    store.db.prepare("UPDATE push_outbox SET created_at=? WHERE id=?").run(new Date(old).toISOString(), claimed.id);
    store.enqueuePush('pending-delivery', subscriptionId, { title: 'new' }, now);
    store.db.prepare('INSERT INTO event_dedup(dedup_key,created_at) VALUES (?,?),(?,?)').run('old-key', new Date(now - 401 * 86400000).toISOString(), 'recent-key', new Date(now).toISOString());

    expect(store.prunePushHistory(now)).toEqual({ outbox: 1, dedup: 1 });
    expect(store.pushOutboxCount()).toBe(1);
    expect(store.db.prepare('SELECT dedup_key FROM event_dedup').all()).toEqual([{ dedup_key: 'recent-key' }]);
    service.close(); store.close();
  });

  it('no toca SQLite si una entrega termina después de cerrar el panel', async () => {
    const store = new Store(':memory:');
    let release!: (result: { statusCode: number }) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const sending = new Promise<{ statusCode: number }>(resolve => { release = resolve; });
    const service = new PushService(store, config, { send: async () => { entered(); return sending; } });
    service.register(subscription);
    store.appendEvent('operation', 'operation:op-close', operation('succeeded', 'op-close'));
    const flush = service.flush();
    await started;
    service.close();
    store.close();
    release({ statusCode: 201 });
    await expect(flush).resolves.toBeUndefined();
  });

  it('valida configuración, endpoint, claves y un máximo de diez dispositivos sin duplicar una misma suscripción', () => {
    const store = new Store(':memory:');
    expect(() => new PushService(store, { ...config, encryptionKeyHex: 'invalid' })).toThrow('Invalid Web Push configuration');
    const unrelated = createECDH('prime256v1');unrelated.generateKeys();
    expect(() => new PushService(store, { ...config, vapidPrivateKey: unrelated.getPrivateKey('base64url') })).toThrow('Invalid Web Push configuration');
    const disabled = new PushService(store, undefined);
    expect(disabled.readiness()).toMatchObject({ enabled: false, subscriptions: 0, pending: 0, dead: 0 });
    expect(() => disabled.register(subscription)).toThrow('not configured');

    const service = new PushService(store, config);
    expect(() => service.register({ ...subscription, endpoint: 'https://evil.example/push' })).toThrow('Unsupported push endpoint');
    expect(() => service.register({ ...subscription, endpoint: 'http://fcm.googleapis.com/push' })).toThrow('Unsupported push endpoint');
    expect(() => service.register({ ...subscription, endpoint: 'https://user@fcm.googleapis.com/push' })).toThrow('Unsupported push endpoint');
    expect(() => service.register({ ...subscription, keys: { p256dh: 'short', auth: 'short' } })).toThrow('Invalid push subscription keys');
    expect(() => service.register({ ...subscription, keys: { p256dh: 'C'.repeat(87), auth: 'A'.repeat(21) } })).toThrow('Invalid push subscription keys');
    const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
    expect(() => service.register({ ...subscription, keys: { p256dh: invalidPoint, auth: subscription.keys.auth } })).toThrow('Invalid push subscription keys');

    for (let index = 0; index < 10; index++) service.register({ ...subscription, endpoint: `${subscription.endpoint}/${index}` });
    const same = service.register({ ...subscription, endpoint: `${subscription.endpoint}/0` });
    expect(same.id).toBe(service.list()[0]!.id);
    expect(service.list()).toHaveLength(10);
    expect(() => service.register({ ...subscription, endpoint: `${subscription.endpoint}/eleven` })).toThrow('limit reached');
    service.close(); disabled.close(); store.close();
  });

  it('traduce estados terminales a mensajes limpios y omite eventos sin una notificación útil', () => {
    const event = (type: 'desktop' | 'operation' | 'resource' | 'incident', aggregateId: string, payload: Record<string, unknown>) => ({
      id: 7, type, aggregateId, createdAt: new Date().toISOString(), payload
    });
    expect(notificationForEvent(event('desktop', 'computer:desktop', { state: 'running', system: 'cachyos' }))).toMatchObject({
      category: 'devices', title: 'PC de casa en línea', body: 'CachyOS ya inició.', icon: '/icon-192.png', badge: '/icon-192.png', url: '/equipo/computer%3Adesktop'
    });
    expect(notificationForEvent(event('desktop', 'computer:desktop', { state: 'stopped' }))).toMatchObject({
      title: 'PC de casa apagada', body: 'El sistema avisó que se apagó.'
    });
    expect(notificationForEvent(event('desktop', 'computer:desktop', { state: 'unreachable' }))).toMatchObject({
      title: 'PC de casa sin señal', body: expect.stringContaining('Puede seguir encendida')
    });
    expect(notificationForEvent(event('desktop', 'computer:desktop', { state: 'stopping' }))).toBeUndefined();
    expect(notificationForEvent(event('desktop', 'computer:desktop', { state: 'pending' }))).toBeUndefined();
    expect(notificationForEvent(event('resource', 'computer:mac', { transitionReason: 'mac_sleep_announced' }))).toBeUndefined();
    expect(notificationForEvent(event('resource', 'computer:mac', { transitionReason: 'telemetry_timeout' }))).toMatchObject({
      category: 'devices', title: 'MacBook sin señal', body: expect.stringContaining('dormida')
    });
    expect(notificationForEvent(event('resource', 'computer:mac', { transitionReason: 'telemetry_recovering' }))).toBeUndefined();
    expect(notificationForEvent(event('resource', 'computer:mac', { transitionReason: 'unknown' }))).toBeUndefined();
    expect(notificationForEvent(event('operation', 'op', { state: 'running' }))).toBeUndefined();
    const uncertain = notificationForEvent(event('operation', 'op', { state: 'uncertain', resourceName: 'PC\nCasa', message: 'resultado\u0000 incierto', id: 'a/b' }));
    expect(uncertain).toMatchObject({ category: 'operations', title: 'PC Casa · confirma el estado', body: 'resultado incierto', url: '/actividad?operation=a%2Fb' });
    expect(notificationForEvent(event('resource', 'computer:desktop:boot-preference', { state: 'unknown' }))).toBeUndefined();
    expect(notificationForEvent(event('resource', 'computer:desktop:boot-preference', { state: 'applied', desired: 'windows' }))).toMatchObject({ body: 'La PC iniciará normalmente en Windows.' });
    expect(notificationForEvent(event('resource', 'computer:desktop:boot-preference', { state: 'failed', desired: 'cachyos', message: 'Revisa el valor.' }))).toMatchObject({ title: 'No se pudo confirmar el arranque', body: 'Revisa el valor.' });
    expect(notificationForEvent(event('resource', 'router:fiberhome', { transitionReason: 'telemetry_recovered' }))).toMatchObject({ title: 'FiberHome de vuelta' });
    expect(notificationForEvent(event('resource', 'router:fiberhome', { transitionReason: 'router_reboot_observed' }))).toMatchObject({ title: 'FiberHome se reinició' });
    expect(notificationForEvent(event('resource', 'router:fiberhome', { transitionReason: 'unknown' }))).toBeUndefined();
    expect(notificationForEvent(event('incident', 'ec2:one', { category: 'infrastructure', resourceName: 'EC2', from: 'running', to: 'stopped', resourceId: 'aws:one' }))).toMatchObject({ body: 'Pasó de encendida a detenida sin una orden del panel.', url: '/equipo/aws%3Aone' });
    const serviceLoss=notificationForEvent(event('incident','catalog:service-1',{category:'infrastructure',source:'https-probe',resourceId:'aws:one:i-1',from:'healthy',to:'unhealthy',transitionReason:'service_probe_unhealthy',reasonCode:'probe_unexpected_http_status'}));
    expect(serviceLoss).toMatchObject({category:'infrastructure',title:'Servicio sin respuesta',body:expect.stringContaining('respuesta inesperada'),icon:'/icon-192.png',badge:'/icon-192.png',url:'/equipo/aws%3Aone%3Ai-1',policy:{holdSeconds:120,lossKey:expect.any(String)}});
    expect(JSON.stringify(serviceLoss)).not.toContain('health.example.com');
    expect(notificationForEvent(event('incident','catalog:service-1',{category:'infrastructure',source:'https-probe',resourceId:'aws:one:i-1',from:'unhealthy',to:'healthy',transitionReason:'service_probe_recovered'}))).toMatchObject({title:'Servicio recuperado',policy:{recoveryNeedsLoss:true}});
    expect(notificationForEvent(event('incident','catalog:service-1',{category:'infrastructure',source:'https-probe',resourceId:'aws:one:i-1',from:'unhealthy',to:'unknown',transitionReason:'service_probe_unhealthy'}))).toBeUndefined();
    expect(notificationForEvent(event('incident', 'hermes:orchestrator', { category: 'infrastructure', to: 'stale' }))).toMatchObject({ title: 'Hermes sin señal', url: '/' });
    expect(notificationForEvent(event('incident', 'budget:one', { category: 'budget', source: 'forecast', percent: 120.6, amount: 10, limit: 20, currency: 'ZZZ' }))).toMatchObject({ title: 'AWS · presupuesto al 121%' });
    expect(notificationForEvent(event('incident', 'budget:one', { category: 'budget', amount: 20, limit: 10, currency: 'USD', asOf: 123 }))).toMatchObject({ body: expect.stringContaining('Datos al último cálculo.') });
    expect(notificationForEvent(event('operation', 'unknown', {}))).toBeUndefined();
  });

  it('aplica límites de red al resolver el proveedor de avisos', async () => {
    const store = new Store(':memory:');
    let lookup: NonNullable<import('node:https').AgentOptions['lookup']> | undefined;
    const send: PushTransport['send'] = async (_subscription, _payload, options) => {
      lookup = options.agent.options.lookup;
      return { statusCode: 201 };
    };
    const service = new PushService(store, config, { send });
    service.register(subscription);
    store.appendEvent('operation', 'operation:lookup', operation('succeeded', 'lookup'));
    await service.flush();
    expect(lookup).toBeTypeOf('function');
    const invoke = (options: { all?: boolean; family?: number }, records: Array<{ address: string; family: number }> | Error) => new Promise<{ error: unknown; value: unknown }>(resolve => {
      dnsLookup.mockImplementationOnce((_hostname: string, _options: unknown, callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void) => {
        if (records instanceof Error) callback(records, []);
        else callback(null, records);
      });
      Reflect.apply(lookup!, undefined, ['fcm.googleapis.com', options, (error: unknown, value: unknown) => resolve({ error, value })]);
    });
    expect(await invoke({ all: true }, [{ address: '142.250.72.14', family: 4 }])).toMatchObject({ error: null, value: [{ address: '142.250.72.14', family: 4 }] });
    const privateAddress = await invoke({}, [{ address: '10.0.0.2', family: 4 }]);
    expect(privateAddress.error).toMatchObject({ code: 'EACCES' });
    const wrongFamily = await invoke({ family: 6 }, [{ address: '142.250.72.14', family: 4 }]);
    expect(wrongFamily.error).toMatchObject({ code: 'EHOSTUNREACH' });
    const dnsError = await invoke({}, Object.assign(new Error('dns failure'), { code: 'ENOTFOUND' }));
    expect(dnsError.error).toMatchObject({ code: 'ENOTFOUND' });
    service.close(); store.close();
  });

  it('marca como terminales una entrega malformada o una suscripción que no se puede descifrar', async () => {
    const store = new Store(':memory:');
    const service = new PushService(store, config, { send: vi.fn(async () => ({ statusCode: 201 })) });
    const id = service.register(subscription).id;
    service.testDevice(id);
    const queued = store.db.prepare('SELECT id FROM push_outbox').get() as { id: number };
    store.db.prepare("UPDATE push_outbox SET payload='{' WHERE id=?").run(queued.id);
    await service.flush();
    expect(service.readiness().dead).toBe(1);

    service.testDevice(id);
    store.db.prepare('UPDATE push_subscriptions SET ciphertext=? WHERE id=?').run('{"broken":true}', id);
    await service.flush();
    expect(service.readiness().dead).toBe(2);
    expect(store.db.prepare('SELECT state,last_error_code FROM push_outbox ORDER BY last_error_code').all()).toEqual([
      { state: 'dead', last_error_code: 'invalid_payload' },
      { state: 'dead', last_error_code: 'subscription_decryption_failed' }
    ]);
    service.close(); store.close();
  });
});
