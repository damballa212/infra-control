import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Action, Operation, Resource } from './types.js';

export type EventType = 'desktop' | 'resource' | 'operation' | 'incident';
export type DurableEvent = { id: number; type: EventType; aggregateId: string; payload: Record<string, unknown>; createdAt: string };
export type DesktopBootPreference = {
  desired: 'windows' | 'cachyos' | null;
  effective: 'windows' | 'cachyos' | null;
  state: 'unknown' | 'pending' | 'applying' | 'applied' | 'uncertain' | 'failed' | 'drift';
  version: number;
  operationKey?: string;
  requestedAt?: string;
  verifiedAt?: string;
  observedAt?: string;
  message?: string;
};
export type PushCategory = 'operations' | 'devices' | 'router' | 'infrastructure' | 'budgets';
export type PushPreferences = Record<PushCategory, boolean>;
export type PushSubscriptionSummary = { id: string; createdAt: string; lastSuccessAt: string | null; preferences: PushPreferences };
export type PushSubscriptionRecord = PushSubscriptionSummary & { endpointHash: string; ciphertext: string };
export type PushOutboxRecord = { id: string; eventKey: string; subscriptionId: string; payload: string; attempts: number };
type EventRow = Omit<DurableEvent, 'payload'> & { payload: string };
const EVENT_RETENTION = 10000;
const EVENT_REPLAY_LIMIT = 250;
export class DeploymentBlockedError extends Error { constructor() { super('Deployment gate is active'); } }
export class ActiveOperationError extends Error { constructor() { super('Resource already has an active operation'); } }

export class Store {
  readonly db: DatabaseSync;
  private eventListeners = new Set<(eventId: number) => void>();
  private transactionDepth = 0;
  private deferredEventIds: number[] = [];
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
        resource TEXT NOT NULL, name TEXT NOT NULL, action TEXT NOT NULL,
        state TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
        UNIQUE(actor, idem));
      CREATE INDEX IF NOT EXISTS operations_resource ON operations(resource, state);
      CREATE UNIQUE INDEX IF NOT EXISTS operations_one_active ON operations(resource) WHERE state IN ('accepted','running');
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('desktop','resource','operation','incident')),
        aggregate_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_log_aggregate ON event_log(aggregate_id,id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_dedup (dedup_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_dedup_created ON event_dedup(created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL UNIQUE, ciphertext TEXT NOT NULL,
        preferences TEXT NOT NULL, created_at TEXT NOT NULL, last_success_at TEXT);
      CREATE TABLE IF NOT EXISTS push_outbox (
        id TEXT PRIMARY KEY, event_key TEXT NOT NULL, subscription_id TEXT NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT, last_error_code TEXT,
        UNIQUE(event_key,subscription_id),
        FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox(state,next_attempt_at,created_at);`);
    this.db.exec('CREATE INDEX IF NOT EXISTS push_outbox_terminal_age ON push_outbox(state,created_at)');
    this.db.prepare("UPDATE push_outbox SET state='pending',next_attempt_at=? WHERE state='sending'").run(Date.now());
    this.transaction(() => {
      const interrupted = this.db.prepare("SELECT id FROM operations WHERE state IN ('accepted','running')").all() as { id: string }[];
      this.db.prepare("UPDATE operations SET state='uncertain', message='El panel se reinició durante la operación. Comprueba el estado antes de repetir.', updated=? WHERE state IN ('accepted','running')").run(new Date().toISOString());
      for (const { id } of interrupted) {
        const operation = this.get(id);
        if (operation) this.appendEvent('operation', `operation:${id}`, operation);
      }
      const preference=this.desktopBootPreference();
      if(preference.state==='applying'){
        const recovered={...preference,state:'uncertain' as const,message:'El panel se reinició durante el cambio del arranque predeterminado. Comprueba el valor efectivo antes de repetir.'};
        this.saveDesktopBootPreference(recovered);
        this.appendEvent('resource','computer:desktop:boot-preference',recovered as unknown as Record<string,unknown>);
      }
    });
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  private transaction<T>(action: () => T): T {
    const outermost = this.transactionDepth === 0;
    if (outermost) this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = action();
      if (outermost) {
        this.db.exec('COMMIT');
        this.transactionDepth = 0;
        const eventIds = this.deferredEventIds.splice(0);
        for (const eventId of eventIds) this.notifyEventListeners(eventId);
      } else this.transactionDepth--;
      return result;
    } catch (error) {
      if (outermost) {
        this.transactionDepth = 0;
        try { this.db.exec('ROLLBACK'); } catch { /* Commit may already have ended the transaction. */ }
        this.deferredEventIds = [];
      } else this.transactionDepth--;
      throw error;
    }
  }
  atomic<T>(action: () => T): T { return this.transaction(action); }
  session(hash: string): boolean {
    return Boolean(this.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(hash, Date.now()));
  }
  addSession(hash: string): void { this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash, Date.now() + 7 * 86400000); }
  deleteSession(hash: string): void { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash); }
  existing(actor: string, key: string) { return this.db.prepare('SELECT id, fingerprint FROM operations WHERE actor=? AND idem=?').get(actor, key) as { id: string; fingerprint: string } | undefined; }
  busy(resource: string): boolean {
    const active=Boolean(this.db.prepare("SELECT id FROM operations WHERE resource=? AND state IN ('accepted','running')").get(resource));
    return active || resource==='computer:desktop' && this.desktopBootPreference().state==='applying';
  }
  private saveDesktopBootPreference(value: DesktopBootPreference): void {
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('desktop-boot-preference',JSON.stringify(value));
  }
  desktopBootPreference(): DesktopBootPreference {
    const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get('desktop-boot-preference') as {value:string}|undefined;
    if(!row)return {desired:null,effective:null,state:'unknown',version:0,message:'Todavía no se ha verificado una preferencia de firmware.'};
    const value=JSON.parse(row.value) as DesktopBootPreference;
    return {...value,version:Number.isSafeInteger(value.version)?value.version:0};
  }
  beginDesktopBootPreference(key:string,system:'windows'|'cachyos',expectedVersion:number):DesktopBootPreference {
    return this.beginDesktopBootPreferenceOnce(key,system,expectedVersion).record;
  }
  beginDesktopBootPreferenceOnce(key:string,system:'windows'|'cachyos',expectedVersion:number):{record:DesktopBootPreference;started:boolean} {
    return this.transaction(()=>{
      if(this.deploymentBlocked())throw new DeploymentBlockedError();
      const current=this.desktopBootPreference();
      if(current.operationKey===key){
        if(current.desired!==system)throw new Error('Boot preference idempotency conflict');
        return {record:current,started:false};
      }
      if(current.version!==expectedVersion)throw new Error('Boot preference version conflict');
      if(current.state==='applied'&&current.desired===system&&current.effective===system)return {record:current,started:false};
      if(this.busy('computer:desktop'))throw new ActiveOperationError();
      const next:DesktopBootPreference={desired:system,effective:current.effective,state:'applying',version:current.version+1,operationKey:key,requestedAt:new Date().toISOString(),...(current.verifiedAt?{verifiedAt:current.verifiedAt}:{}),...(current.observedAt?{observedAt:current.observedAt}:{}),message:'Cambio solicitado. Comprobando identidad y orden UEFI; la PC no se reiniciará.'};
      this.saveDesktopBootPreference(next);
      this.appendEvent('resource','computer:desktop:boot-preference',next as unknown as Record<string,unknown>);
      return {record:next,started:true};
    });
  }
  claimPendingDesktopBootPreference():DesktopBootPreference|undefined {
    return this.transaction(()=>{
      if(this.deploymentBlocked())return undefined;
      const current=this.desktopBootPreference();
      if(current.state!=='pending'||!current.operationKey||this.busy('computer:desktop'))return undefined;
      const next={...current,state:'applying' as const,message:'La PC volvió a informar. Comprobando identidad antes de aplicar el arranque predeterminado.'};
      this.saveDesktopBootPreference(next);
      this.appendEvent('resource','computer:desktop:boot-preference',next as unknown as Record<string,unknown>);
      return next;
    });
  }
  finishDesktopBootPreference(key:string,state:'pending'|'applied'|'uncertain'|'failed',message:string,verifiedAt?:string):DesktopBootPreference {
    return this.transaction(()=>{
      const current=this.desktopBootPreference();
      if(current.operationKey!==key||current.state!=='applying')return current;
      const next:DesktopBootPreference={
        ...current,state,effective:state==='applied'?current.desired:current.effective,
        ...(verifiedAt?{verifiedAt,observedAt:verifiedAt}:{}),message
      };
      this.saveDesktopBootPreference(next);
      this.appendEvent('resource','computer:desktop:boot-preference',next as unknown as Record<string,unknown>);
      return next;
    });
  }
  cancelPendingDesktopBootPreference(expectedVersion:number):DesktopBootPreference {
    return this.transaction(()=>{
      const current=this.desktopBootPreference();
      if(current.version!==expectedVersion)throw new Error('Boot preference version conflict');
      if(current.state!=='pending')throw new Error('Boot preference is not pending');
      const next:DesktopBootPreference={...current,desired:current.effective,state:current.effective?'applied':'unknown',version:current.version+1,message:'Preferencia pendiente cancelada. No se envió ninguna orden al equipo.'};
      this.saveDesktopBootPreference(next);
      this.appendEvent('resource','computer:desktop:boot-preference',next as unknown as Record<string,unknown>);
      return next;
    });
  }
  observeDesktopBootDefault(system:'windows'|'cachyos',observedAt:string):DesktopBootPreference {
    return this.transaction(()=>{
      const current=this.desktopBootPreference();
      const state=current.state==='applying'?'applying':current.state==='pending'
        ? current.desired===system?'applied':'pending'
        : current.desired===null?'unknown':current.desired===system?'applied':'drift';
      const message=state==='applying'?current.message:state==='pending'
        ? `El firmware aún informa ${system==='windows'?'Windows':'CachyOS'}; el destino queda pendiente de aplicar.`
        : state==='drift'
          ? `El firmware informa ${system==='windows'?'Windows':'CachyOS'}, distinto de la preferencia guardada. No se corrigió automáticamente.`
          : state==='applied'
            ? `El firmware volvió a confirmar ${system==='windows'?'Windows':'CachyOS'} como predeterminado.`
            : `El firmware informó ${system==='windows'?'Windows':'CachyOS'}; todavía no hay una preferencia solicitada desde el panel.`;
      const next:DesktopBootPreference={...current,effective:system,state,observedAt,message};
      this.saveDesktopBootPreference(next);
      if(current.effective!==next.effective||current.state!==next.state)this.appendEvent('resource','computer:desktop:boot-preference',next as unknown as Record<string,unknown>);
      return next;
    });
  }
  create(actor: string, idem: string, fingerprint: string, resource: Resource, action: Action): Operation {
    return this.transaction(() => {
      if (this.deploymentBlocked()) throw new DeploymentBlockedError();
      if (this.busy(resource.id)) throw new ActiveOperationError();
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, actor, idem, fingerprint, resource.id, resource.name, action, 'accepted', 'Orden registrada. Pendiente de ejecutar.', now, now);
      const operation = this.get(id)!;
      this.appendEvent('operation', `operation:${id}`, operation);
      return operation;
    });
  }
  update(id: string, state: Operation['state'], message: string): void {
    this.transaction(() => {
      const before = this.get(id);
      if (!before || (before.state === state && before.message === message)) return;
      this.db.prepare('UPDATE operations SET state=?,message=?,updated=? WHERE id=?').run(state, message, new Date().toISOString(), id);
      const operation = this.get(id);
      if (operation) this.appendEvent('operation', `operation:${id}`, operation);
    });
  }
  recentExpectedOperation(resource:string,action:Action,since:string):boolean {
    return Boolean(this.db.prepare("SELECT id FROM operations WHERE resource=? AND action=? AND state IN ('accepted','running','succeeded','uncertain') AND created>=? LIMIT 1").get(resource,action,since));
  }
  get(id: string): Operation | undefined {
    return this.db.prepare('SELECT id, actor, resource AS resourceId, name AS resourceName, action, state, message, created AS createdAt, updated AS updatedAt FROM operations WHERE id=?').get(id) as Operation | undefined;
  }
  list(): Operation[] {
    return this.db.prepare('SELECT id, actor, resource AS resourceId, name AS resourceName, action, state, message, created AS createdAt, updated AS updatedAt FROM operations ORDER BY created DESC LIMIT 100').all() as Operation[];
  }
  appendEvent(type: EventType, aggregateId: string, payload: Record<string, unknown>): number {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO event_log(type,aggregate_id,payload,created_at) VALUES (?,?,?,?)').run(type, aggregateId, JSON.stringify(payload), createdAt);
    const id = Number(result.lastInsertRowid);
    if (id % 100 === 0) this.db.prepare('DELETE FROM event_log WHERE id <= ?').run(id - EVENT_RETENTION);
    if (this.transactionDepth > 0) this.deferredEventIds.push(id);
    else this.notifyEventListeners(id);
    return id;
  }
  appendEventOnce(dedupKey:string,type:EventType,aggregateId:string,payload:Record<string,unknown>,alsoDeduplicate:string[]=[]):boolean {
    return this.transaction(()=>{
      const exists=this.db.prepare('SELECT dedup_key FROM event_dedup WHERE dedup_key=?').get(dedupKey);
      if(exists)return false;
      const now=new Date().toISOString();
      const insert=this.db.prepare('INSERT OR IGNORE INTO event_dedup(dedup_key,created_at) VALUES (?,?)');
      insert.run(dedupKey,now);
      for(const key of alsoDeduplicate)insert.run(key,now);
      this.appendEvent(type,aggregateId,payload);
      return true;
    });
  }
  private notifyEventListeners(id: number): void {
    for (const listener of this.eventListeners) {
      try { listener(id); } catch { /* Event consumers cannot invalidate a durable write. */ }
    }
  }
  deploymentBlocked(now = Date.now()): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='deployment-gate'").get() as { value: string } | undefined;
    if (!row) return false;
    try {
      const gate = JSON.parse(row.value) as { expiresAt?: string };
      return typeof gate.expiresAt !== 'string' || !Number.isFinite(Date.parse(gate.expiresAt)) || Date.parse(gate.expiresAt) > now;
    } catch { return true; }
  }
  latestEventId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id),0) AS latest FROM event_log').get() as { latest: number };
    return row.latest;
  }
  eventBounds(): { first: number | null; latest: number } {
    const row = this.db.prepare('SELECT MIN(id) AS first, COALESCE(MAX(id),0) AS latest FROM event_log').get() as { first: number | null; latest: number };
    return row;
  }
  eventsAfter(cursor: number, limit = EVENT_REPLAY_LIMIT): DurableEvent[] {
    const rows = this.db.prepare('SELECT id,type,aggregate_id AS aggregateId,payload,created_at AS createdAt FROM event_log WHERE id>? ORDER BY id LIMIT ?').all(cursor, Math.max(1, Math.min(EVENT_REPLAY_LIMIT, limit))) as EventRow[];
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }
  countEventsAfter(cursor: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM event_log WHERE id>?').get(cursor) as { count: number }).count;
  }
  operationHistory(id: string): DurableEvent[] {
    const rows = this.db.prepare("SELECT id,type,aggregate_id AS aggregateId,payload,created_at AS createdAt FROM event_log WHERE aggregate_id=? AND type='operation' ORDER BY id").all(`operation:${id}`) as EventRow[];
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }
  subscribeEvents(listener: (eventId: number) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  cache<T>(key: string): { value: T; expires: number } | undefined {
    const row = this.db.prepare('SELECT value, expires FROM cache WHERE key=?').get(key) as { value: string; expires: number } | undefined;
    return row ? { value: JSON.parse(row.value) as T, expires: row.expires } : undefined;
  }
  putCache(key: string, value: unknown, ttl: number): void {
    this.db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(key, JSON.stringify(value), Date.now() + ttl);
  }
  pushCursor(initial: number): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='push-event-cursor'").get() as {value:string}|undefined;
    if (row) return Number(row.value);
    this.db.prepare("INSERT INTO settings(key,value) VALUES ('push-event-cursor',?)").run(String(initial));
    return initial;
  }
  setPushCursor(cursor: number): void {
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('push-event-cursor',?)").run(String(cursor));
  }
  pushSubscriptionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as {count:number}).count;
  }
  hasPushEndpoint(endpointHash:string):boolean {
    return Boolean(this.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint_hash=?').get(endpointHash));
  }
  pushPreferencesForEndpoint(endpointHash:string):PushPreferences|undefined {
    const row=this.db.prepare('SELECT preferences FROM push_subscriptions WHERE endpoint_hash=?').get(endpointHash) as {preferences:string}|undefined;
    return row?JSON.parse(row.preferences) as PushPreferences:undefined;
  }
  pushSubscriptions(): PushSubscriptionSummary[] {
    const rows=this.db.prepare('SELECT id,preferences,created_at AS createdAt,last_success_at AS lastSuccessAt FROM push_subscriptions ORDER BY created_at').all() as {id:string;preferences:string;createdAt:string;lastSuccessAt:string|null}[];
    return rows.map(row=>({...row,preferences:JSON.parse(row.preferences) as PushPreferences}));
  }
  pushSubscription(id: string): PushSubscriptionRecord | undefined {
    const row=this.db.prepare('SELECT id,endpoint_hash AS endpointHash,ciphertext,preferences,created_at AS createdAt,last_success_at AS lastSuccessAt FROM push_subscriptions WHERE id=?').get(id) as (Omit<PushSubscriptionRecord,'preferences'>&{preferences:string})|undefined;
    return row?{...row,preferences:JSON.parse(row.preferences) as PushPreferences}:undefined;
  }
  upsertPushSubscription(endpointHash:string,ciphertext:string,preferences:PushPreferences,now=new Date().toISOString()):PushSubscriptionSummary {
    return this.transaction(()=>{
      const current=this.db.prepare('SELECT id,created_at AS createdAt,last_success_at AS lastSuccessAt FROM push_subscriptions WHERE endpoint_hash=?').get(endpointHash) as {id:string;createdAt:string;lastSuccessAt:string|null}|undefined;
      const id=current?.id??randomUUID(),createdAt=current?.createdAt??now;
      this.db.prepare('INSERT INTO push_subscriptions(id,endpoint_hash,ciphertext,preferences,created_at,last_success_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET ciphertext=excluded.ciphertext,preferences=excluded.preferences').run(id,endpointHash,ciphertext,JSON.stringify(preferences),createdAt,current?.lastSuccessAt??null);
      return {id,createdAt,lastSuccessAt:current?.lastSuccessAt??null,preferences};
    });
  }
  updatePushPreferences(id:string,preferences:PushPreferences):boolean {
    return this.db.prepare('UPDATE push_subscriptions SET preferences=? WHERE id=?').run(JSON.stringify(preferences),id).changes===1;
  }
  removePushSubscription(id:string):boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(id).changes===1;
  }
  enqueuePush(eventKey:string,subscriptionId:string,payload:Record<string,unknown>,now=Date.now()):void {
    this.db.prepare("INSERT OR IGNORE INTO push_outbox(id,event_key,subscription_id,payload,state,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,'pending',0,?,?)").run(randomUUID(),eventKey,subscriptionId,JSON.stringify(payload),now,new Date(now).toISOString());
  }
  claimPush(now=Date.now()):PushOutboxRecord|undefined {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT id,event_key AS eventKey,subscription_id AS subscriptionId,payload,attempts FROM push_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at,id LIMIT 1").get(now) as (PushOutboxRecord & {attempts:number})|undefined;
      if(!row)return undefined;
      this.db.prepare("UPDATE push_outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(row.id);
      return {...row,attempts:row.attempts+1};
    });
  }
  finishPush(id:string,state:'sent'|'pending'|'dead',nextAttemptAt=Date.now(),errorCode:string|null=null,now=new Date().toISOString()):void {
    this.transaction(()=>{
      const row=this.db.prepare('SELECT subscription_id AS subscriptionId FROM push_outbox WHERE id=?').get(id) as {subscriptionId:string}|undefined;
      if(!row)return;
      this.db.prepare('UPDATE push_outbox SET state=?,next_attempt_at=?,sent_at=?,last_error_code=? WHERE id=?').run(state,nextAttemptAt,state==='sent'?now:null,errorCode,id);
      if(state==='sent')this.db.prepare('UPDATE push_subscriptions SET last_success_at=? WHERE id=?').run(now,row.subscriptionId);
    });
  }
  pushOutboxCount():number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM push_outbox WHERE state IN ('pending','sending')").get() as {count:number}).count;
  }
  prunePushHistory(now=Date.now()):{outbox:number;dedup:number} {
    return this.transaction(()=>{
      const outboxCutoff=new Date(now-30*86400000).toISOString(),dedupCutoff=new Date(now-400*86400000).toISOString();
      const outbox=Number(this.db.prepare("DELETE FROM push_outbox WHERE state IN ('sent','dead') AND created_at<?").run(outboxCutoff).changes);
      const dedup=Number(this.db.prepare('DELETE FROM event_dedup WHERE created_at<?').run(dedupCutoff).changes);
      return {outbox,dedup};
    });
  }
  close(): void { this.eventListeners.clear(); this.db.close(); }
}
