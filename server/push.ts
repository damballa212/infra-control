import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, ECDH, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, type AgentOptions } from 'node:https';
import * as webPush from 'web-push';
import type { DurableEvent, PushCategory, PushPreferences, PushSubscriptionSummary, Store } from './store.js';
import type { Config } from './types.js';

export type WebPushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export type PushNotification = { title: string; body: string; category: PushCategory; tag: string; url: string; icon: string; badge: string; ttlSeconds: number };
export type PushSendOptions = { TTL: number; urgency: 'high'; timeout: number; vapidDetails: { subject: string; publicKey: string; privateKey: string }; agent: Agent };
export type PushSendResult = { statusCode: number; headers?: Record<string, string | number | undefined> };
export type PushTransport = { send(subscription: WebPushSubscription, payload: string, options: PushSendOptions): Promise<PushSendResult> };
export type PushConfiguration = NonNullable<Config['push']>;
export type PushReadiness = { enabled: boolean; subscriptions: number; pending: number; dead: number };
const MAX_SUBSCRIPTIONS = 10;
const MAX_ATTEMPTS = 6;
const DEFAULT_PREFERENCES: PushPreferences = { operations: true, devices: true, router: true, infrastructure: true, budgets: true };
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

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value: unknown, currency: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
}

function titleForOperation(state: string): string {
  if (state === 'succeeded') return 'Infra Control · orden completada';
  if (state === 'failed') return 'Infra Control · orden fallida';
  return 'Infra Control · confirma el estado';
}

export function notificationForEvent(event: DurableEvent): PushNotification | undefined {
  const data = event.payload;
  let category: PushCategory, title: string, body: string, target = '/';
  if (event.type === 'operation') {
    const state = text(data.state, 24);
    if (!['succeeded', 'failed', 'uncertain'].includes(state)) return undefined;
    category = 'operations';
    title = titleForOperation(state);
    const name = text(data.resourceName, 55) || 'Infraestructura';
    const message = text(data.message, 110);
    body = message ? `${name}: ${message}` : `${name}: revisa el resultado de la orden.`;
    const operationId = text(data.id, 80);
    if (operationId) target = `/actividad?operation=${encodeURIComponent(operationId)}`;
  } else if (event.type === 'desktop' && event.aggregateId === 'computer:desktop') {
    const state = text(data.state, 24), system = data.system === 'windows' ? 'Windows' : data.system === 'cachyos' ? 'CachyOS' : undefined;
    category = 'devices';
    if (state === 'running') {
      if (!system) return undefined;
      title = `PC de casa · ${system} en línea`;
      body = `La PC informó que ${system} ya inició.`;
    } else if (state === 'pending') {
      title = 'PC de casa · reinicio en curso';
      body = 'La PC anunció un reinicio. El sistema de destino aún no está confirmado.';
    } else if (state === 'stopped') {
      title = 'PC de casa · apagado anunciado';
      body = 'El sistema comunicó el apagado; el panel no mide el estado eléctrico.';
    } else if (state === 'unreachable') {
      title = 'PC de casa · sin señal';
      body = 'No llegó un aviso reciente. La PC puede seguir encendida o haber perdido conexión.';
    } else return undefined;
    target = '/equipo/computer%3Adesktop';
  } else if (event.type === 'resource' && event.aggregateId === 'computer:desktop:boot-preference') {
    const state = text(data.state, 24);
    if (!['applied', 'pending', 'uncertain', 'failed', 'drift'].includes(state)) return undefined;
    category = 'devices';
    const system = data.desired === 'windows' ? 'Windows' : data.desired === 'cachyos' ? 'CachyOS' : 'el sistema solicitado';
    title = state === 'applied' ? 'Arranque predeterminado actualizado' : state === 'drift' ? 'El arranque predeterminado cambió' : state === 'pending' ? 'Cambio de arranque pendiente' : 'No se pudo confirmar el arranque';
    body = state === 'applied' ? `La PC iniciará normalmente en ${system}.` : text(data.message, 130) || `Revisa la preferencia de arranque de ${system}.`;
    target = '/equipo/computer%3Adesktop';
  } else if (event.type === 'resource' && event.aggregateId === 'computer:mac') {
    const reason = text(data.transitionReason, 40);
    category = 'devices';
    if (reason === 'mac_sleep_announced') {
      title = 'MacBook · reposo anunciado';
      body = 'macOS avisó que entraría en reposo. El aviso no confirma que se completara.';
    } else if (reason === 'telemetry_timeout') {
      title = 'MacBook · sin señal reciente';
      body = 'El reporte venció. Puede deberse a reposo, tapa cerrada, apagado o pérdida de red.';
    } else if (reason === 'telemetry_recovered') {
      title = 'MacBook · señal recuperada';
      body = 'El reporter volvió a enviar su estado por HTTPS.';
    } else if (reason === 'mac_wake_reported') {
      title = 'MacBook · actividad recuperada';
      body = 'El reporter notificó el despertar y volvió a informar.';
    } else return undefined;
    target = '/equipo/computer%3Amac';
  } else if (event.type === 'resource' && event.aggregateId === 'router:fiberhome') {
    const reason = text(data.transitionReason, 40);
    if (!['telemetry_timeout', 'telemetry_recovered', 'router_reboot_observed'].includes(reason)) return undefined;
    category = 'router';
    title = reason === 'telemetry_timeout' ? 'FiberHome · sin telemetría' : reason === 'router_reboot_observed' ? 'FiberHome · nuevo arranque observado' : 'FiberHome · telemetría recuperada';
    body = reason === 'telemetry_timeout' ? 'El panel dejó de recibir métricas del túnel. Esto no confirma una caída de Internet.' : reason === 'router_reboot_observed' ? 'El colector observó un nuevo inicio del router; el acceso a Internet no se ha comprobado.' : 'El FiberHome volvió a enviar métricas por el túnel privado.';
    target = '/equipo/router%3Afiberhome';
  } else if (event.type === 'incident' && data.category === 'infrastructure') {
    category = 'infrastructure';
    if (event.aggregateId === 'router:fiberhome') {
      if (data.transitionReason !== 'telemetry_timeout') return undefined;
      category = 'router';
      title = 'FiberHome · sin telemetría';
      body = 'El panel lleva más de 90 segundos sin recibir métricas del túnel. Esto no confirma una caída de Internet.';
      target = '/equipo/router%3Afiberhome';
    } else if (event.aggregateId === 'hermes:orchestrator') {
      const state = text(data.to, 24), serviceState = text(data.serviceState, 24);
      title = state === 'healthy' ? 'Hermes · servicio recuperado'
        : state === 'stale' ? 'Hermes · sin señal reciente'
          : 'Hermes · servicio no activo';
      body = state === 'healthy' ? 'El reporter confirmó de nuevo la unidad systemd activa.'
        : state === 'stale' ? 'No llegó un heartbeat reciente. La instancia EC2 puede seguir encendida.'
          : `${serviceState === 'failed' ? 'systemd reportó failed.' : 'La unidad systemd no está activa.'} EC2 encendida no confirma Hermes.`;
      const id = text(data.resourceId, 120);
      target = id ? `/equipo/${encodeURIComponent(id)}` : '/';
      const tagSource = createHash('sha256').update(`${event.aggregateId}:${category}`).digest('base64url').slice(0, 24);
      return { category, title: text(title, 64), body: text(body, 180), tag: `infra-${tagSource}`, url: target, icon: '/icon-192.png', badge: '/icon-192.png', ttlSeconds: 900 };
    } else {
      const name = text(data.resourceName, 55) || 'Recurso';
      const from = text(data.from, 40), to = text(data.to, 40);
      title = 'Infraestructura · estado cambió';
      body = from && to ? `${name}: ${from} → ${to}.` : `${name}: revisa el estado actualizado.`;
      const id = text(data.resourceId, 120);
      if (id) target = `/equipo/${encodeURIComponent(id)}`;
    }
  } else if (event.type === 'incident' && data.category === 'budget') {
    category = 'budgets';
    const name = text(data.budgetName, 50) || 'Presupuesto AWS';
    const account = text(data.account, 35) || 'AWS';
    const percent = typeof data.percent === 'number' && Number.isFinite(data.percent) ? Math.max(0, Math.min(999, Math.round(data.percent))) : null;
    const source = data.source === 'forecast' ? 'previsión' : 'gasto estimado';
    title = `AWS · presupuesto${percent === null ? '' : ` al ${percent}%`}`;
    const amount = money(data.amount, data.currency), limit = money(data.limit, data.currency);
    const comparison = amount && limit ? ` ${amount} de ${limit}` : amount ? ` ${amount}` : '';
    body = `${account} · ${name}: ${source}${comparison}${percent === null ? '' : ` (${percent}%)`}. Datos al ${text(data.asOf, 16) || 'último cálculo'}.`;
    target = '/costes';
  } else return undefined;

  const tagSource = createHash('sha256').update(`${event.aggregateId}:${category}`).digest('base64url').slice(0, 24);
  const ttlSeconds = category === 'budgets' ? 86400 : category === 'infrastructure' || category === 'router' ? 900 : 600;
  return { category, title: text(title, 64), body: text(body, 180), tag: `infra-${tagSource}`, url: target, icon: '/icon-192.png', badge: '/icon-192.png', ttlSeconds };
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
      const result = await webPush.sendNotification(subscription as webPush.PushSubscription, payload, options);
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
      this.store.pushCursor(this.store.latestEventId());
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
      tag:'infra-push-test',url:'/',icon:'/icon-192.png',badge:'/icon-192.png',ttlSeconds:60,expiresAt
    },now);
    return true;
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.closed || !this.config || !this.encryptionKey) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async run(): Promise<void> {
    const config=this.config,encryptionKey=this.encryptionKey;
    if(this.closed||!config||!encryptionKey)return;
    if(this.now()-this.lastPruneAt>=6*60*60_000){this.store.prunePushHistory(this.now());this.lastPruneAt=this.now();}
    await this.enqueueRecentEvents();
    if (this.closed) return;
    for (let count = 0; count < 10; count++) {
      if (this.closed) return;
      const delivery = this.store.claimPush(this.now());
      if (!delivery) return;
      const subscription = this.store.pushSubscription(delivery.subscriptionId);
      if (!subscription) { this.store.finishPush(delivery.id, 'dead', this.now(), 'subscription_missing'); continue; }
      let payload: PushNotification & { expiresAt?: string };
      try { payload = JSON.parse(delivery.payload) as PushNotification & { expiresAt?: string }; }
      catch { this.store.finishPush(delivery.id, 'dead', this.now(), 'invalid_payload'); continue; }
      const expiry = typeof payload.expiresAt === 'string' ? Date.parse(payload.expiresAt) : NaN;
      if (!Number.isFinite(expiry) || expiry <= this.now()) { this.store.finishPush(delivery.id, 'dead', this.now(), 'expired'); continue; }
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
        if (result.statusCode >= 200 && result.statusCode < 300) this.store.finishPush(delivery.id, 'sent', this.now(), null, new Date(this.now()).toISOString());
        else this.retryOrDead(delivery, { statusCode: result.statusCode, headers: result.headers });
      } catch (error) {
        if (this.closed) return;
        const code = statusCode(error);
        if (code === 404 || code === 410) this.store.removePushSubscription(subscription.id);
        else this.retryOrDead(delivery, error);
      } finally { agent.destroy(); }
    }
  }

  private retryOrDead(delivery: { id: string; attempts: number }, error: unknown): void {
    const code = statusCode(error), retryable = code === 0 || code === 408 || code === 429 || code >= 500;
    if (delivery.attempts >= MAX_ATTEMPTS || !retryable) {
      this.store.finishPush(delivery.id, 'dead', this.now(), errorCode(error));
      return;
    }
    const backoff = Math.min(3600000, 5000 * (2 ** (delivery.attempts - 1)));
    const delay = retryAfterMs(error, this.now()) ?? backoff;
    this.store.finishPush(delivery.id, 'pending', this.now() + delay, errorCode(error));
  }

  private async enqueueRecentEvents(): Promise<void> {
    if (!this.enabled) return;
    const bounds = this.store.eventBounds();
    let cursor = this.store.pushCursor(bounds.latest);
    if (bounds.first !== null && cursor < bounds.first - 1) {
      // A long outage must not replay thousands of stale push messages.
      this.store.setPushCursor(bounds.latest);
      return;
    }
    const subscriptions = this.store.pushSubscriptions();
    while (cursor < bounds.latest) {
      const events = this.store.eventsAfter(cursor, 100);
      if (!events.length) break;
      for (const event of events) {
        const notification = notificationForEvent(event);
        if (notification) {
          const eventTime = Date.parse(event.createdAt), expiresAt = eventTime + notification.ttlSeconds * 1000;
          if (!Number.isFinite(eventTime) || expiresAt <= this.now()) { cursor = event.id; continue; }
          for (const subscription of subscriptions) {
            if (!subscription.preferences[notification.category]) continue;
            this.store.enqueuePush(String(event.id), subscription.id, { ...notification, expiresAt: new Date(expiresAt).toISOString() }, this.now());
          }
        }
        cursor = event.id;
      }
      this.store.setPushCursor(cursor);
    }
  }
}
