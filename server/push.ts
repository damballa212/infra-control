import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, ECDH, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, type AgentOptions } from 'node:https';
import * as webPushModule from 'web-push';
import type { DurableEvent, PushCategory, PushPreferences, PushSignalSeed, PushSubscriptionSummary, PushOutboxRecord, Store } from './store.js';
import { PushLifecycle } from './push-lifecycle.js';
import { notificationForEvent, type PushNotification } from './push-notices.js';
import type { Config } from './types.js';
import type { SecretRequest } from './secrets.js';
import { text } from './push-notices.js';

/** En Node ESM puro `web-push` (CommonJS) solo expone sus funciones bajo `default`; con tsx/vitest llegan en el espacio de nombres. */
export const webPush: typeof webPushModule = (webPushModule as unknown as { default?: typeof webPushModule }).default ?? webPushModule;

export type WebPushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export { notificationForEvent, type PushNotification } from './push-notices.js';
export type PushSendOptions = { TTL: number; urgency: 'high'; timeout: number; vapidDetails: { subject: string; publicKey: string; privateKey: string }; agent: Agent };
export type PushSendResult = { statusCode: number; headers?: Record<string, string | number | undefined> };
export type PushTransport = { send(subscription: WebPushSubscription, payload: string, options: PushSendOptions): Promise<PushSendResult> };
export type PushConfiguration = NonNullable<Config['push']>;
export type PushReadiness = { enabled: boolean; subscriptions: number; pending: number; dead: number };
const MAX_SUBSCRIPTIONS = 10;
const MAX_ATTEMPTS = 6;
const DEFAULT_PREFERENCES: PushPreferences = { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true };
const PROVIDER_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com']);

function allowedEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid push endpoint'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !PROVIDER_HOSTS.has(host) || !url.pathname.startsWith('/') || raw.length > 2048) {
    throw new Error('Unsupported push endpoint');
  }
  return url;
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function ipv6Words(address: string): number[] | undefined {
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) return undefined;
    const ipv4 = address.slice(lastColon + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    address = `${address.slice(0, lastColon)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  if ([...left, ...right].some(word => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return undefined;
  return [...left.map(word => parseInt(word, 16)), ...Array(missing).fill(0), ...right.map(word => parseInt(word, 16))];
}

function addressIsPublic(address: string, family: number): boolean {
  if (family === 4) return ipv4IsPublic(address);
  const words = ipv6Words(address);
  if (!words || words[0]! < 0x2000 || words[0]! > 0x3fff) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  return true;
}

const safeLookup: NonNullable<AgentOptions['lookup']> = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, records: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    if (!records.length || records.some(record => !addressIsPublic(record.address, record.family))) {
      const denied = Object.assign(new Error('Push provider address is not public'), { code: 'EACCES' });
      return callback(denied, '', 0);
    }
    const family = options.family;
    const matching = family ? records.filter(record => record.family === family) : records;
    if (!matching.length) return callback(Object.assign(new Error('No public address for requested family'), { code: 'EHOSTUNREACH' }), '', 0);
    if (options.all) return callback(null, matching);
    return callback(null, matching[0]!.address, matching[0]!.family);
  });
};

function safeAgent(): Agent { return new Agent({ keepAlive: false, lookup: safeLookup }); }

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') });
}

function decrypt(value: string, key: Buffer): WebPushSubscription {
  const envelope = JSON.parse(value) as { version?: number; iv?: string; tag?: string; data?: string };
  if (envelope.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) throw new Error('Unsupported push subscription envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8')) as WebPushSubscription;
}

function statusCode(error: unknown): number {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return 0;
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : 0;
}

function retryAfterMs(error: unknown, now: number): number | undefined {
  if (!error || typeof error !== 'object' || !('headers' in error)) return undefined;
  const headers = (error as { headers?: Record<string, unknown> }).headers;
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1000, Math.min(3600000, value * 1000));
  if (typeof value === 'string') {
    const seconds = Number(value);
    if (/^\d+$/.test(value) && Number.isFinite(seconds)) return Math.max(1000, Math.min(3600000, seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1000, Math.min(3600000, date - now));
  }
  return undefined;
}

function errorCode(error: unknown): string {
  const code = statusCode(error);
  return code ? `http_${code}` : 'network';
}

function realTransport(config: PushConfiguration): PushTransport {
  return {
    async send(subscription, payload, options) {
      const result = await webPush.sendNotification(subscription as webPushModule.PushSubscription, payload, options);
      return { statusCode: result.statusCode, headers: result.headers };
    }
  };
}

export class PushService {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  private readonly encryptionKey: Buffer | null;
  private readonly indexKey: Buffer | null;
  private readonly transport: PushTransport;
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private closed = false;
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  private lifecycle?: PushLifecycle;

  constructor(private readonly store: Store, private readonly config: PushConfiguration | undefined, transport?: PushTransport, private readonly now = Date.now) {
    this.enabled = Boolean(config);
    this.publicKey = config?.vapidPublicKey ?? null;
    if (config) {
      if (!/^[A-Fa-f0-9]{64}$/.test(config.encryptionKeyHex) || !/^[A-Za-z0-9_-]{80,100}$/.test(config.vapidPublicKey) || !/^[A-Za-z0-9_-]{40,60}$/.test(config.vapidPrivateKey) || !/^(mailto:.+|https:\/\/[^\s]+)$/.test(config.vapidSubject)) throw new Error('Invalid Web Push configuration');
      try {
        const publicKey = Buffer.from(config.vapidPublicKey, 'base64url'), privateKey = Buffer.from(config.vapidPrivateKey, 'base64url');
        if (publicKey.length !== 65 || privateKey.length !== 32 || publicKey[0] !== 4) throw new Error('Invalid VAPID key length');
        ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
        const curve = createECDH('prime256v1');
        curve.setPrivateKey(privateKey);
        if (!timingSafeEqual(curve.getPublicKey(), publicKey)) throw new Error('VAPID public and private keys do not match');
      } catch { throw new Error('Invalid Web Push configuration'); }
      const master = Buffer.from(config.encryptionKeyHex, 'hex');
      this.encryptionKey = Buffer.from(createHash('sha256').update(master).update('infra-control/push/encryption/v1').digest());
      this.indexKey = Buffer.from(createHash('sha256').update(master).update('infra-control/push/index/v1').digest());
      this.transport = transport ?? realTransport(config);
      const cursor=this.store.pushCursor(this.store.latestEventId());
      this.bootstrapPushSignalState(cursor);
      this.lifecycle=new PushLifecycle(store,config.signalLoss,this.now);
      this.lifecycle.bootstrap(cursor);
    } else {
      this.encryptionKey = null;
      this.indexKey = null;
      this.transport = transport ?? { send: async () => { throw new Error('Web Push is not configured'); } };
    }
  }

  start(): void {
    if (!this.enabled || this.closed || this.unsubscribe) return;
    this.unsubscribe = this.store.subscribeEvents(() => { void this.flush(); });
    this.timer = setInterval(() => { void this.flush(); }, 2000);
    this.timer.unref();
    void this.flush();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  readiness(): PushReadiness {
    const counts = this.store.db.prepare("SELECT SUM(CASE WHEN state IN ('pending','sending') THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS dead FROM push_outbox").get() as {pending:number|null;dead:number|null};
    return { enabled: this.enabled, subscriptions: this.store.pushSubscriptionCount(), pending: counts.pending ?? 0, dead: counts.dead ?? 0 };
  }

  list(): PushSubscriptionSummary[] { return this.store.pushSubscriptions(); }

  register(subscription: WebPushSubscription, preferences?: PushPreferences): PushSubscriptionSummary {
    if (!this.enabled || !this.encryptionKey || !this.indexKey) throw new Error('Web Push is not configured');
    allowedEndpoint(subscription.endpoint);
    if (!subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys.auth)) throw new Error('Invalid push subscription keys');
    const p256dh = Buffer.from(subscription.keys.p256dh, 'base64url'), auth = Buffer.from(subscription.keys.auth, 'base64url');
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new Error('Invalid push subscription keys');
    try { ECDH.convertKey(p256dh, 'prime256v1', undefined, undefined, 'uncompressed'); }
    catch { throw new Error('Invalid push subscription keys'); }
    const endpointHash = createHmac('sha256', this.indexKey).update(subscription.endpoint).digest('hex');
    if (this.store.pushSubscriptionCount() >= MAX_SUBSCRIPTIONS && !this.store.hasPushEndpoint(endpointHash)) throw new Error('Push subscription limit reached');
    const ciphertext = encrypt(JSON.stringify(subscription), this.encryptionKey);
    const effectivePreferences = preferences ?? this.store.pushPreferencesForEndpoint(endpointHash) ?? DEFAULT_PREFERENCES;
    const summary = this.store.upsertPushSubscription(endpointHash, ciphertext, effectivePreferences, new Date(this.now()).toISOString());
    return summary;
  }

  updatePreferences(id: string, preferences: PushPreferences): boolean { return this.store.updatePushPreferences(id, preferences); }
  remove(id: string): boolean { return this.store.removePushSubscription(id); }
  testDevice(id: string): boolean {
    if (!this.enabled) throw new Error('Web Push is not configured');
    if (!this.store.pushSubscription(id)) return false;
    const now=this.now(),expiresAt=new Date(now+60_000).toISOString();
    this.store.enqueuePush(`test-${randomBytes(16).toString('hex')}`,id,{
      category:'devices',title:'Infra Control · prueba de avisos',body:'Este dispositivo recibió la prueba de notificación.',
      tag:'infra-push-test',url:'/',icon:'/icon-192.png',badge:'/icon-192.png',ttlSeconds:60,expiresAt,manualTest:true
    },now);
    return true;
  }

  /** Avisa que un agente pide una clave. Solo nombres y contexto: el valor nunca pasa por aquí. */
  notifySecretRequest(request: SecretRequest): void {
    if (!this.enabled || this.closed || request.state !== 'pending') return;
    const now = this.now(), expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
    const where = request.environment ? `${request.project}/${request.environment}` : request.project;
    const payload = {
      category: 'secrets' as const, title: text(`Clave pedida: ${request.name}`, 64),
      body: text(`${request.machine} · ${where} · ${request.reason}`, 180),
      tag: `infra-secret-${request.id}`, url: `/secretos/${encodeURIComponent(request.id)}`,
      icon: '/icon-192.png', badge: '/icon-192.png', ttlSeconds: Math.ceil((expiresAt - now) / 1000), expiresAt: request.expiresAt
    };
    for (const subscription of this.store.pushSubscriptions())
      if (subscription.preferences.secrets) this.store.enqueuePush(`secret:${request.id}`, subscription.id, payload, now);
    void this.flush();
  }

  /** Aviso informativo: un agente recibió una clave sin intervención de Admin. Nunca incluye el valor. */
  notifySecretDelivered(request: SecretRequest): void {
    if (!this.enabled || this.closed) return;
    const now = this.now(), where = request.environment ? `${request.project}/${request.environment}` : request.project;
    const payload = {
      category: 'secretDeliveries' as const, title: text(`${request.machine} recibió ${request.name}`, 64),
      body: text(`${where} · entrega automática`, 180), tag: `infra-secret-delivered-${request.id}`,
      url: `/secretos/${encodeURIComponent(request.id)}`, icon: '/icon-192.png', badge: '/icon-192.png',
      ttlSeconds: 86_400, expiresAt: new Date(now + 86_400_000).toISOString()
    };
    for (const subscription of this.store.pushSubscriptions())
      if (subscription.preferences.secretDeliveries) this.store.enqueuePush(`secret-delivered:${request.id}`, subscription.id, payload, now);
    void this.flush();
  }

  /** Aviso informativo: una solicitud venció sin que nadie la decidiera. */
  notifySecretExpired(request: SecretRequest): void {
    if (!this.enabled || this.closed) return;
    const now = this.now(), where = request.environment ? `${request.project}/${request.environment}` : request.project;
    const payload = {
      category: 'secrets' as const, title: text(`Solicitud vencida: ${request.name}`, 64),
      body: text(`${request.machine} · ${where} · venció sin decidirse; el agente puede pedirla de nuevo`, 180),
      tag: `infra-secret-expired-${request.id}`, url: `/secretos/${encodeURIComponent(request.id)}`,
      icon: '/icon-192.png', badge: '/icon-192.png', ttlSeconds: 86_400, expiresAt: new Date(now + 86_400_000).toISOString()
    };
    for (const subscription of this.store.pushSubscriptions())
      if (subscription.preferences.secrets) this.store.enqueuePush(`secret-expired:${request.id}`, subscription.id, payload, now);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.closed || !this.config || !this.encryptionKey) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  /** Reconstruye una vez el ciclo vigente de cada señal antes de consumir el cursor heredado. */
  private bootstrapPushSignalState(cursor:number):void {
    if(this.store.pushSignalBootstrapDone())return;
    const subscriptions=this.store.pushSubscriptions();
    const history=this.store.eventBounds();
    const candidates=new Map<string,Map<number,'loss'|'recovery'>>();
    const add=(subscriptionId:string,key:string,eventId:number,signal:'loss'|'recovery')=>{
      if(eventId>cursor)return;
      const compound=JSON.stringify([subscriptionId,key]);
      let events=candidates.get(compound);if(!events){events=new Map();candidates.set(compound,events);}
      events.set(eventId,signal);
    };
    let eventCursor=0;
    while(eventCursor<cursor){
      const batch=this.store.eventsAfter(eventCursor,250).filter(event=>event.id<=cursor);
      if(!batch.length)break;
      for(const event of batch){
        const policy=notificationForEvent(event)?.policy;
        if(policy)for(const subscription of subscriptions){
          if(policy.lossKey)add(subscription.id,policy.lossKey,event.id,'loss');
          if(policy.recoversKey)add(subscription.id,policy.recoversKey,event.id,'recovery');
        }
      }
      eventCursor=batch[batch.length-1]!.id;
    }
    for(const item of this.store.pushOutboxSignalEvents())add(item.subscriptionId,item.signalKey,item.eventId,item.signal);
    for(const item of this.store.legacyPushSignalEvents())add(item.subscriptionId,item.signalKey,item.eventId,item.signal);
    const seeds:PushSignalSeed[]=[];
    for(const [compound,events] of candidates){
      const [subscriptionId,signalKey]=JSON.parse(compound) as [string,string];
      const ordered=[...events].sort(([left],[right])=>left-right);
      const latest=ordered.at(-1);if(!latest)continue;
      const previous=ordered.at(-2);
      const gap=history.first===null?latest[0]<cursor:latest[0]<history.first-1;
      seeds.push(gap
        ?{subscriptionId,signalKey,eventId:cursor,signal:'unknown' as const,previousEventId:latest[0],previousSignal:'unknown' as const}
        :{subscriptionId,signalKey,eventId:latest[0],signal:latest[1],previousEventId:previous?.[0]??null,previousSignal:previous?.[1]??null});
    }
    this.store.bootstrapPushSignalStates(seeds);
  }

  private async run(): Promise<void> {
    const config=this.config,encryptionKey=this.encryptionKey;
    if(this.closed||!config||!encryptionKey)return;
    if(this.now()-this.lastPruneAt>=6*60*60_000){this.store.prunePushHistory(this.now());this.lastPruneAt=this.now();}
    await this.enqueueRecentEvents();
    if (this.closed) return;
    for (let count = 0; count < 10; count++) {
      if (this.closed) return;
      await this.enqueueRecentEvents();
      if (this.closed) return;
      const delivery = this.store.claimPush(this.now());
      if (!delivery) return;
      const subscription = this.store.pushSubscription(delivery.subscriptionId);
      if (!subscription) { this.store.finishPush(delivery.id, 'dead', this.now(), 'subscription_missing'); continue; }
      let payload: PushNotification & { expiresAt?: string; manualTest?: boolean };
      try { payload = JSON.parse(delivery.payload) as PushNotification & { expiresAt?: string; manualTest?: boolean }; }
      catch { this.store.finishPush(delivery.id, 'dead', this.now(), 'invalid_payload'); continue; }
      if (payload.manualTest !== true && subscription.preferences[payload.category] === false) {
        this.store.finishPush(delivery.id, 'dead', this.now(), 'category_disabled'); continue;
      }
      const expiry = typeof payload.expiresAt === 'string' ? Date.parse(payload.expiresAt) : NaN;
      if (!Number.isFinite(expiry) || expiry <= this.now()) { this.store.finishPush(delivery.id, 'dead', this.now(), 'expired'); continue; }
      if(this.lifecycle&&!this.lifecycle.current(delivery)){this.store.finishPush(delivery.id,'dead',this.now(),'superseded');continue;}
      const deferUntil=this.lifecycle?.deferUntil(delivery);
      if(deferUntil!==undefined&&deferUntil>this.now()){this.store.deferClaimedPush(delivery.id,deferUntil);continue;}
      let decoded: WebPushSubscription;
      try { decoded = decrypt(subscription.ciphertext, encryptionKey); }
      catch { this.store.finishPush(delivery.id, 'dead', this.now(), 'subscription_decryption_failed'); continue; }
      const agent = safeAgent();
      try {
        const requestedTtl = Number.isInteger(payload.ttlSeconds) ? Math.max(1, Math.min(86400, payload.ttlSeconds)) : 300;
        const ttlSeconds = Math.max(1, Math.min(requestedTtl, Math.ceil((expiry - this.now()) / 1000)));
        const result = await this.transport.send(decoded, delivery.payload, {
          TTL: ttlSeconds, urgency: 'high', timeout: 8000, agent,
          vapidDetails: { subject: this.config.vapidSubject, publicKey: this.config.vapidPublicKey, privateKey: this.config.vapidPrivateKey }
        });
        if (this.closed) return;
        if (result.statusCode >= 200 && result.statusCode < 300) {
          this.store.finishPush(delivery.id,'sent',this.now(),null,new Date(this.now()).toISOString());
          this.lifecycle?.sent(delivery);
        } else {
          await this.enqueueRecentEvents();
          if(this.closed)return;
          this.retryOrDead(delivery,{statusCode:result.statusCode,headers:result.headers});
        }
      } catch (error) {
        if (this.closed) return;
        await this.enqueueRecentEvents();
        if(this.closed)return;
        const code = statusCode(error);
        if (code === 404 || code === 410) this.store.removePushSubscription(subscription.id);
        else this.retryOrDead(delivery, error);
      } finally { agent.destroy(); }
    }
  }

  private retryOrDead(delivery: PushOutboxRecord, error: unknown): void {
    if(this.lifecycle&&!this.lifecycle.current(delivery)){this.store.finishPush(delivery.id,'dead',this.now(),'superseded');return;}
    const code = statusCode(error), retryable = code === 0 || code === 408 || code === 429 || code >= 500;
    if (delivery.attempts >= MAX_ATTEMPTS || !retryable) {
      this.store.finishPush(delivery.id, 'dead', this.now(), errorCode(error));
      return;
    }
    const backoff = Math.min(3600000, 5000 * (2 ** (delivery.attempts - 1)));
    const delay = retryAfterMs(error, this.now()) ?? backoff;
    this.store.finishPush(delivery.id, 'pending', this.now() + delay, errorCode(error));
  }

  /**
   * Reglas que evitan avisos inútiles. Una recuperación a tiempo cancela la pérdida que seguía retenida (el
   * parpadeo nunca se mostró, tampoco se muestra su recuperación); una recuperación sin pérdida entregada no
   * se avisa; y varias señales de un mismo hecho (orden + estado de la PC) se funden en un solo aviso.
   */
  // La vigencia y deduplicación pertenecen al ciclo durable, nunca a una etiqueta y proximidad temporal.

  private async enqueueRecentEvents(): Promise<void> {
    if(this.enabled&&!this.closed)this.lifecycle?.enqueue();
  }
}
