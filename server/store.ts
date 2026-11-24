import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ExpectationLedger } from './expectations.js';
import { ProbeLifecycle } from './probe-lifecycle.js';
import { OperationalReadModel } from './operational.js';
import { migrateHostProvider } from './host-schema.js';
import { HostObservationStore } from './host-observation-store.js';
import type { Action, HostMetricsSnapshot, Operation, Resource, ServiceProbeSignal, PowerVerificationUpdate } from './types.js';
import type { ServiceDefinition } from './types.js';

export type EventType = 'desktop' | 'resource' | 'operation' | 'incident' | 'coverage';
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
export type PushCategory = 'operations' | 'devices' | 'router' | 'infrastructure' | 'budgets' | 'secrets' | 'secretDeliveries';
/** Los dispositivos registrados antes de existir una categoría la reciben activada. */
const parsePushPreferences = (raw: string): PushPreferences => ({ secrets: true, secretDeliveries: true, ...(JSON.parse(raw) as Partial<PushPreferences>) }) as PushPreferences;
export type PushPreferences = Record<PushCategory, boolean>;
export type PushSubscriptionSummary = { id: string; createdAt: string; lastSuccessAt: string | null; preferences: PushPreferences };
export type PushSubscriptionRecord = PushSubscriptionSummary & { endpointHash: string; ciphertext: string };
export type PushOutboxRecord = { id: string; eventKey: string; subscriptionId: string; payload: string; attempts: number };
export type PushSignalState = 'loss'|'recovery'|'unknown';
export type OperationVerification = PowerVerificationUpdate & { operationId: string; startedAt: string; updatedAt: string };
export type PushSignalSeed = {subscriptionId:string;signalKey:string;eventId:number;signal:PushSignalState;previousEventId:number|null;previousSignal:PushSignalState|null};
export type PendingCloudEvent = { eventKey: string; accountId: string; region: string; instanceId: string; state: string; eventTime: string; receivedAt: string; attempts: number };
export type OperationPlanRecord = { id: string; actor: string; idempotencyKey: string; fingerprint: string; resourceId: string; action: Action; resourceState: string; observedAt: string | null; policyVersion: string; state: 'planned' | 'consumed' | 'expired'; createdAt: string; expiresAt: string; operationId: string | null };
export type IncidentDeliveryRecord = { id: string; consumer: string; eventId: number; version: string; payload: Record<string, unknown>; attempts: number; leaseUntil: string };
export type IncidentLeaseResult = { cursor: number; deliveries: IncidentDeliveryRecord[]; deadLetterCount: number };
type EventRow = Omit<DurableEvent, 'payload'> & { payload: string };
const EVENT_RETENTION = 10000;
const EVENT_REPLAY_LIMIT = 250;
const MAX_FUTURE_TELEMETRY_SKEW_MS = 5 * 60_000;
const MAX_SERVICE_PROBE_FRESH_MS = 20 * 60_000;
export class DeploymentBlockedError extends Error { constructor() { super('Deployment gate is active'); } }
export class ActiveOperationError extends Error { constructor() { super('Resource already has an active operation'); } }

export class Store {
  readonly db: DatabaseSync;
  readonly expectations: ExpectationLedger;
  readonly probeLifecycle: ProbeLifecycle;
  readonly operational: OperationalReadModel;
  readonly hostObservations: HostObservationStore;
  private eventListeners = new Set<(eventId: number, event: DurableEvent) => void>();
  private transactionDepth = 0;
  private deferredEvents: DurableEvent[] = [];
  private eventNotifications: DurableEvent[] = [];
  private notifyingEvents = false;
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
      CREATE TABLE IF NOT EXISTS expected_transitions (
        operation_id TEXT PRIMARY KEY, resource TEXT NOT NULL, target_state TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, cancelled_at TEXT,
        FOREIGN KEY(operation_id) REFERENCES operations(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS expected_transitions_pending ON expected_transitions(resource,target_state,expires_at)
        WHERE consumed_at IS NULL AND cancelled_at IS NULL;
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('desktop','resource','operation','incident','coverage')),
        aggregate_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_log_aggregate ON event_log(aggregate_id,id);
      CREATE TABLE IF NOT EXISTS host_telemetry_latest (
        resource_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_telemetry_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id TEXT NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(resource_id,observed_at));
      CREATE INDEX IF NOT EXISTS host_telemetry_samples_resource_time ON host_telemetry_samples(resource_id,received_at);
      CREATE TABLE IF NOT EXISTS service_probe_latest (
        resource_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, payload TEXT NOT NULL, outage_open INTEGER NOT NULL DEFAULT 0);`);
    const probeColumns=this.db.prepare('PRAGMA table_info(service_probe_latest)').all() as Array<{name:string}>;
    const eventSchema=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_log'").get() as {sql:string}|undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(eventSchema?.sql.includes('CHECK(type IN')&&!eventSchema.sql.includes("'coverage'")){
        this.db.exec(`DROP INDEX IF EXISTS event_log_aggregate;
          ALTER TABLE event_log RENAME TO event_log_legacy;
          CREATE TABLE event_log(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL CHECK(type IN ('desktop','resource','operation','incident','coverage')),aggregate_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
          INSERT INTO event_log(id,type,aggregate_id,payload,created_at) SELECT id,type,aggregate_id,payload,created_at FROM event_log_legacy;
          DROP TABLE event_log_legacy;
          CREATE INDEX event_log_aggregate ON event_log(aggregate_id,id);`);
      }
      if(!probeColumns.some(column=>column.name==='outage_open'))this.db.exec('ALTER TABLE service_probe_latest ADD COLUMN outage_open INTEGER NOT NULL DEFAULT 0');
      const prior=this.db.prepare('SELECT resource_id AS resourceId,payload FROM service_probe_latest').all() as Array<{resourceId:string;payload:string}>;
      const incidents=this.db.prepare("SELECT aggregate_id AS resourceId,payload FROM event_log WHERE type='incident' ORDER BY id").all() as Array<{resourceId:string;payload:string}>;
      const outageState=new Map<string,boolean>();
      for(const row of incidents){
        try{
          const event=JSON.parse(row.payload) as {source?:unknown;transitionReason?:unknown};
          if(event.source!=='https-probe')continue;
          if(event.transitionReason==='service_probe_unhealthy')outageState.set(row.resourceId,true);
          else if(event.transitionReason==='service_probe_recovered')outageState.set(row.resourceId,false);
        }catch{/* Malformed historical events cannot establish incident state. */}
      }
      const markOutage=this.db.prepare('UPDATE service_probe_latest SET outage_open=1 WHERE resource_id=?');
      for(const row of prior){
        try{if((JSON.parse(row.payload) as ServiceProbeSignal).state==='unhealthy'||outageState.get(row.resourceId)===true)markOutage.run(row.resourceId);}catch{/* Invalid legacy rows remain closed and will be replaced by the next valid probe. */}
      }
      this.db.exec('COMMIT');
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_dedup (dedup_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_dedup_created ON event_dedup(created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('aws','coolify','host')),
        provider_account_id TEXT NOT NULL, name TEXT NOT NULL, credential_ref TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(provider,provider_account_id));
      CREATE TABLE IF NOT EXISTS provider_connection_aliases (
        alias TEXT PRIMARY KEY, connection_id TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS catalog_projects (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, external_key TEXT NOT NULL,
        name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source,external_key));
      CREATE TABLE IF NOT EXISTS catalog_project_environments (
        project_id TEXT NOT NULL, environment_key TEXT NOT NULL, environment TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(project_id,environment_key),
        FOREIGN KEY(project_id) REFERENCES catalog_projects(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS catalog_services (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, external_key TEXT NOT NULL, name TEXT NOT NULL,
        project_id TEXT, environment TEXT, criticality TEXT NOT NULL CHECK(criticality IN ('critical','high','normal','low')),
        active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source,external_key), FOREIGN KEY(project_id) REFERENCES catalog_projects(id));
      CREATE TABLE IF NOT EXISTS catalog_service_resources (
        service_id TEXT NOT NULL, resource_ref TEXT NOT NULL, resource_id TEXT,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('hosted_on','depends_on')),
        evidence TEXT NOT NULL CHECK(evidence IN ('operator_confirmed','provider_metadata')),
        active INTEGER NOT NULL CHECK(active IN (0,1)), first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        PRIMARY KEY(service_id,resource_ref,relation_type),
        FOREIGN KEY(service_id) REFERENCES catalog_services(id) ON DELETE CASCADE,
        FOREIGN KEY(resource_id) REFERENCES catalog_resources(id));
      CREATE INDEX IF NOT EXISTS catalog_service_resources_resource ON catalog_service_resources(resource_id,active);
      CREATE TABLE IF NOT EXISTS catalog_resources (
        id TEXT PRIMARY KEY, provider_identity TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
        connection_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_key TEXT NOT NULL,
        region TEXT NOT NULL, resource_type TEXT NOT NULL, provider_id TEXT NOT NULL,
        name TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, tags TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','candidate_missing','retired')),
        first_seen TEXT, last_seen TEXT, state_changed_at TEXT, missing_since TEXT,
        missing_scans INTEGER NOT NULL DEFAULT 0, project_id TEXT, environment TEXT,
        FOREIGN KEY(connection_id) REFERENCES provider_connections(id),
        FOREIGN KEY(project_id) REFERENCES catalog_projects(id));
      CREATE INDEX IF NOT EXISTS catalog_resources_scope ON catalog_resources(connection_id,scope_key,lifecycle);
      CREATE TABLE IF NOT EXISTS catalog_resource_aliases (
        alias TEXT PRIMARY KEY, resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY(resource_id) REFERENCES catalog_resources(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS catalog_alias_resource ON catalog_resource_aliases(resource_id);
      CREATE TABLE IF NOT EXISTS catalog_resource_projects (
        resource_id TEXT NOT NULL, project_id TEXT NOT NULL, first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(resource_id,project_id,first_seen),
        FOREIGN KEY(resource_id) REFERENCES catalog_resources(id),
        FOREIGN KEY(project_id) REFERENCES catalog_projects(id));
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_one_active_project ON catalog_resource_projects(resource_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS catalog_scopes (
        connection_id TEXT NOT NULL, scope_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('healthy','partial','failed')),
        generation INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT NOT NULL, last_success_at TEXT,
        error_code TEXT, resource_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connection_id,scope_key), FOREIGN KEY(connection_id) REFERENCES provider_connections(id));
      CREATE TABLE IF NOT EXISTS cloud_event_inbox (
        event_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, region TEXT NOT NULL, instance_id TEXT NOT NULL,
        state TEXT NOT NULL, event_time TEXT NOT NULL, received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processed','ignored')), attempts INTEGER NOT NULL DEFAULT 0,
        processed_at TEXT, reason_code TEXT);
      CREATE INDEX IF NOT EXISTS cloud_event_inbox_pending ON cloud_event_inbox(status,received_at);
      CREATE TABLE IF NOT EXISTS operation_plans (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        resource_id TEXT NOT NULL, action TEXT NOT NULL, resource_state TEXT NOT NULL, observed_at TEXT,
        policy_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','consumed','expired')),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, operation_id TEXT,
        UNIQUE(actor,idempotency_key));
      CREATE INDEX IF NOT EXISTS operation_plans_expiry ON operation_plans(state,expires_at);
      CREATE TABLE IF NOT EXISTS mcp_consumers (
        consumer TEXT PRIMARY KEY, cursor INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_incident_deliveries (
        id TEXT PRIMARY KEY, consumer TEXT NOT NULL, event_id INTEGER NOT NULL, version TEXT NOT NULL,
        payload TEXT NOT NULL, aggregate_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('leased','acked','dead')),
        attempts INTEGER NOT NULL, lease_until TEXT NOT NULL, acked_at TEXT,
        UNIQUE(consumer,event_id));
      CREATE INDEX IF NOT EXISTS mcp_incident_delivery_lease ON mcp_incident_deliveries(consumer,status,lease_until,event_id);`);
    migrateHostProvider(this.db);
    this.hostObservations = new HostObservationStore(this);
    const deliveryColumns=this.db.prepare('PRAGMA table_info(mcp_incident_deliveries)').all() as Array<{name:string}>;
    if(!deliveryColumns.some(column=>column.name==='aggregate_id')){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec(`ALTER TABLE mcp_incident_deliveries ADD COLUMN aggregate_id TEXT NOT NULL DEFAULT '';
          UPDATE mcp_incident_deliveries AS d SET aggregate_id=COALESCE((SELECT aggregate_id FROM event_log WHERE id=d.event_id),'incident:'||d.event_id);`);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
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
      CREATE TABLE IF NOT EXISTS push_signal_state (
        subscription_id TEXT NOT NULL, signal_key TEXT NOT NULL, event_id INTEGER NOT NULL,
        signal TEXT NOT NULL CHECK(signal IN ('loss','recovery','unknown')),
        previous_event_id INTEGER, previous_signal TEXT CHECK(previous_signal IS NULL OR previous_signal IN ('loss','recovery','unknown')),
        PRIMARY KEY(subscription_id,signal_key),
        FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox(state,next_attempt_at,created_at);`);
    this.db.exec('CREATE INDEX IF NOT EXISTS push_outbox_terminal_age ON push_outbox(state,created_at)');
    this.expectations = new ExpectationLedger(this);
    this.probeLifecycle = new ProbeLifecycle(this);
    this.operational = new OperationalReadModel(this);
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
    this.operational.bootstrap();
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
        this.notifyEventListeners(this.deferredEvents.splice(0));
      } else this.transactionDepth--;
      return result;
    } catch (error) {
      if (outermost) {
        this.transactionDepth = 0;
        try { this.db.exec('ROLLBACK'); } catch { /* Commit may already have ended the transaction. */ }
        this.deferredEvents = [];
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
      const targetState = action === 'start' ? 'running' : action === 'stop' ? 'stopped' : null;
      if (targetState) this.db.prepare('INSERT INTO expected_transitions(operation_id,resource,target_state,created_at,expires_at) VALUES (?,?,?,?,?)').run(id, resource.id, targetState, now, new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString());
      const operation = this.get(id)!;
      this.expectations.begin(operation);
      this.appendEvent('operation', `operation:${id}`, operation);
      return operation;
    });
  }
  update(id: string, state: Operation['state'], message: string): void {
    this.transaction(() => {
      const before = this.get(id);
      if (!before || (before.state === state && before.message === message)) return;
      if (['succeeded','failed','uncertain'].includes(before.state)) return;
      if (before.state === 'running' && state === 'accepted') return;
      this.db.prepare('UPDATE operations SET state=?,message=?,updated=? WHERE id=?').run(state, message, new Date().toISOString(), id);
      if (state === 'failed') {
        this.db.prepare('UPDATE expected_transitions SET cancelled_at=? WHERE operation_id=? AND consumed_at IS NULL').run(new Date().toISOString(), id);
        this.expectations.cancel(id);
      }
      if (state === 'succeeded' && (before.action === 'start' || before.action === 'stop')) this.expectations.confirm(id, new Date().toISOString());
      const operation = this.get(id);
      if (operation) {
        const verification = this.operationVerification(id);
        this.appendEvent('operation', `operation:${id}`, { ...operation, ...(verification ? { verification } : {}) });
      }
    });
  }
  operationVerification(id: string): OperationVerification | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`power-verification-v1:${id}`) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as OperationVerification; } catch { return undefined; }
  }
  recordOperationVerification(id: string, update: PowerVerificationUpdate): void {
    const operation = this.get(id), now = Date.now(), deadline = Date.parse(update.deadlineAt);
    const maximum = update.phase === 'wake' ? 120_000 : update.phase === 'cooldown' ? 31_000 : update.phase === 'verify' ? 255_000 : 60_000;
    if (!operation || operation.resourceId !== 'computer:desktop' || operation.action === 'refresh' || !['accepted','running'].includes(operation.state)
      || !['dispatch','wake','cooldown','verify'].includes(update.phase) || !Number.isFinite(deadline) || deadline < now || deadline > now + maximum
      || update.bootId !== undefined && (typeof update.bootId !== 'string' || update.bootId.length > 100)) throw new Error('Invalid power verification');
    const previous = this.operationVerification(id);
    const value: OperationVerification = { ...update, operationId: id, startedAt: previous?.startedAt ?? new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(`power-verification-v1:${id}`, JSON.stringify(value));
  }
  activePowerVerification(lossAt: number, now = Date.now(), operationId?: string): OperationVerification | undefined {
    const row = this.db.prepare("SELECT id FROM operations WHERE resource='computer:desktop' AND action!='refresh' AND state IN ('accepted','running') LIMIT 1").get() as { id: string } | undefined;
    if (!row || operationId && row.id !== operationId) return undefined;
    const value = this.operationVerification(row.id);
    return value && Number.isFinite(lossAt) && Date.parse(value.startedAt) <= lossAt && now < Date.parse(value.deadlineAt) ? value : undefined;
  }
  recentExpectedOperation(resource:string,action:Action,since:string):boolean {
    return Boolean(this.db.prepare("SELECT id FROM operations WHERE resource=? AND action=? AND state IN ('accepted','running','succeeded','uncertain') AND created>=? LIMIT 1").get(resource,action,since));
  }
  consumeExpectedTransition(resource: string, targetState: string, observedAt: string): boolean {
    return this.expectations.consume(resource, targetState, observedAt);
  }
  hasExpectedTransition(resource: string, targetState: string, observedAt: string): boolean {
    return this.expectations.pending(resource, targetState, observedAt);
  }
  get(id: string): Operation | undefined {
    const operation=this.db.prepare('SELECT id, actor, resource AS resourceId, name AS resourceName, action, state, message, created AS createdAt, updated AS updatedAt FROM operations WHERE id=?').get(id) as Operation | undefined;
    return operation?this.operational?.decorate(operation)??operation:undefined;
  }
  createOperationPlan(actor: string, idempotencyKey: string, resource: Resource, action: Action, policyVersion: string, now = Date.now(), ttlMs = 5 * 60_000): { status: 'created' | 'existing' | 'conflict'; plan: OperationPlanRecord } {
    const fingerprint = JSON.stringify({ resourceId: resource.id, action, state: resource.state, observedAt: resource.observedAt ?? null, policyVersion });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,fingerprint FROM operation_plans WHERE actor=? AND idempotency_key=?').get(actor,idempotencyKey) as {id:string;fingerprint:string}|undefined;
      if(existing){const plan=this.operationPlan(existing.id)!;return {status:existing.fingerprint===fingerprint?'existing':'conflict',plan};}
      const id=randomUUID(),createdAt=new Date(now).toISOString(),expiresAt=new Date(now+ttlMs).toISOString();
      this.db.prepare(`INSERT INTO operation_plans(id,actor,idempotency_key,fingerprint,resource_id,action,resource_state,observed_at,policy_version,state,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'planned',?,?)`).run(id,actor,idempotencyKey,fingerprint,resource.id,action,resource.state,resource.observedAt??null,policyVersion,createdAt,expiresAt);
      return {status:'created',plan:this.operationPlan(id)!};
    });
  }
  operationPlan(id: string): OperationPlanRecord | undefined {
    return this.db.prepare(`SELECT id,actor,idempotency_key AS idempotencyKey,fingerprint,resource_id AS resourceId,action,resource_state AS resourceState,
      observed_at AS observedAt,policy_version AS policyVersion,state,created_at AS createdAt,expires_at AS expiresAt,operation_id AS operationId
      FROM operation_plans WHERE id=?`).get(id) as OperationPlanRecord|undefined;
  }
  consumeOperationPlan(id: string, actor: string, operationId: string, now = Date.now()): 'consumed' | 'replay' | 'missing' | 'wrong_actor' | 'expired' | 'already_consumed' {
    return this.transaction(()=>{
      const plan=this.operationPlan(id);
      if(!plan)return 'missing';
      if(plan.actor!==actor)return 'wrong_actor';
      if(plan.state==='consumed')return plan.operationId===operationId?'replay':'already_consumed';
      if(plan.state!=='planned'||Date.parse(plan.expiresAt)<=now){this.db.prepare("UPDATE operation_plans SET state='expired' WHERE id=? AND state='planned'").run(id);return 'expired';}
      this.db.prepare("UPDATE operation_plans SET state='consumed',operation_id=? WHERE id=? AND actor=? AND state='planned'").run(operationId,id,actor);
      return 'consumed';
    });
  }
  incidentEventsAfter(cursor: number, limit = 50): DurableEvent[] {
    const rows=this.db.prepare("SELECT id,type,aggregate_id AS aggregateId,payload,created_at AS createdAt FROM event_log WHERE type='incident' AND id>? ORDER BY id LIMIT ?").all(cursor,Math.max(1,Math.min(100,limit))) as EventRow[];
    return rows.map(row=>({...row,payload:JSON.parse(row.payload) as Record<string,unknown>}));
  }
  leaseIncidentDeliveries(consumer: string, limit = 20, now = Date.now(), leaseMs = 120_000, allow: (payload: Record<string,unknown>,aggregateId: string) => boolean = () => true): IncidentLeaseResult {
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT cursor FROM mcp_consumers WHERE consumer=?').get(consumer) as {cursor:number}|undefined;
      let cursor=existing?.cursor??this.latestEventId();
      const pageSize=Math.max(1,Math.min(100,limit)),selected:string[]=[];
      const nowIso=new Date(now).toISOString(),leaseUntil=new Date(now+leaseMs).toISOString();
      if(!existing)this.db.prepare('INSERT INTO mcp_consumers(consumer,cursor,created_at,updated_at) VALUES (?,?,?,?)').run(consumer,cursor,nowIso,nowIso);
      const active=this.db.prepare(`SELECT id,event_id AS eventId,payload,aggregate_id AS aggregateId FROM mcp_incident_deliveries
        WHERE consumer=? AND status='leased' AND lease_until>? ORDER BY event_id`).all(consumer,nowIso) as Array<{id:string;eventId:number;payload:string;aggregateId:string}>;
      for(const row of active){
        if(selected.length>=pageSize)break;
        if(allow(JSON.parse(row.payload) as Record<string,unknown>,row.aggregateId))selected.push(row.id);
      }
      if(selected.length<pageSize){
        const expired=this.db.prepare(`SELECT id,event_id AS eventId,version,payload,attempts,aggregate_id AS aggregateId FROM mcp_incident_deliveries
          WHERE consumer=? AND status='leased' AND lease_until<=? ORDER BY event_id`).all(consumer,nowIso) as Array<{id:string;eventId:number;version:string;payload:string;attempts:number;aggregateId:string}>;
        for(const row of expired){
          if(selected.length>=pageSize)break;
          if(!allow(JSON.parse(row.payload) as Record<string,unknown>,row.aggregateId))continue;
          if(row.attempts>=8){this.db.prepare("UPDATE mcp_incident_deliveries SET status='dead' WHERE id=? AND status='leased'").run(row.id);continue;}
          this.db.prepare("UPDATE mcp_incident_deliveries SET attempts=attempts+1,lease_until=? WHERE id=? AND status='leased' AND lease_until<=?").run(leaseUntil,row.id,nowIso);
          selected.push(row.id);
        }
      }
      if(selected.length<pageSize){
        for(const event of this.eventsAfter(cursor,250)){
          if(event.type==='incident'&&allow(event.payload,event.aggregateId)){
            const prior=this.db.prepare('SELECT id FROM mcp_incident_deliveries WHERE consumer=? AND event_id=?').get(consumer,event.id) as {id:string}|undefined;
            if(!prior){
              if(selected.length>=pageSize)break;
              const id=randomUUID();
              this.db.prepare(`INSERT INTO mcp_incident_deliveries(id,consumer,event_id,version,payload,aggregate_id,status,attempts,lease_until)
                VALUES (?,?,?,?,?,?,'leased',1,?)`).run(id,consumer,event.id,String(event.id),JSON.stringify(event.payload),event.aggregateId,leaseUntil);
              selected.push(id);
            }else if(selected.length<pageSize){
              const row=this.db.prepare("SELECT status FROM mcp_incident_deliveries WHERE consumer=? AND event_id=?").get(consumer,event.id) as {status:string};
              if(row.status==='leased'&&!selected.includes(prior.id))selected.push(prior.id);
            }
          }
          cursor=event.id;
          if(selected.length>=pageSize)break;
        }
      }
      this.db.prepare('UPDATE mcp_consumers SET cursor=?,updated_at=? WHERE consumer=?').run(cursor,nowIso,consumer);
      const rows=selected.length?this.db.prepare(`SELECT id,consumer,event_id AS eventId,version,payload,attempts,lease_until AS leaseUntil,aggregate_id AS aggregateId FROM mcp_incident_deliveries
        WHERE consumer=? AND id IN (${selected.map(()=>'?').join(',')}) ORDER BY event_id`).all(consumer,...selected) as Array<Omit<IncidentDeliveryRecord,'payload'>&{payload:string;aggregateId:string}>:[];
      let deadLetterCount=0;
      for(const value of this.db.prepare("SELECT payload,aggregate_id AS aggregateId FROM mcp_incident_deliveries WHERE consumer=? AND status='dead'").iterate(consumer)){
        const row=value as {payload:string;aggregateId:string};
        if(allow(JSON.parse(row.payload) as Record<string,unknown>,row.aggregateId))deadLetterCount++;
      }
      const deliveries=rows.flatMap(({aggregateId,...row})=>{
        const payload=JSON.parse(row.payload) as Record<string,unknown>;
        return allow(payload,aggregateId)?[{...row,payload}]:[];
      });
      return {cursor,deadLetterCount,deliveries};
    });
  }
  acknowledgeIncidentDelivery(consumer: string, id: string, version: string, now = Date.now(), allow: (payload:Record<string,unknown>,aggregateId:string)=>boolean = () => true): 'acknowledged' | 'duplicate' | 'not_found' | 'stale_version' | 'lease_expired' | 'dead_letter' {
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT version,status,lease_until AS leaseUntil,payload,aggregate_id AS aggregateId FROM mcp_incident_deliveries WHERE consumer=? AND id=?').get(consumer,id) as {version:string;status:'leased'|'acked'|'dead';leaseUntil:string;payload:string;aggregateId:string}|undefined;
      if(!row||!allow(JSON.parse(row.payload) as Record<string,unknown>,row.aggregateId))return 'not_found';
      if(row.version!==version)return 'stale_version';
      if(row.status==='acked')return 'duplicate';
      if(row.status==='dead')return 'dead_letter';
      if(Date.parse(row.leaseUntil)<=now)return 'lease_expired';
      this.db.prepare("UPDATE mcp_incident_deliveries SET status='acked',acked_at=? WHERE consumer=? AND id=? AND status='leased'").run(new Date(now).toISOString(),consumer,id);
      return 'acknowledged';
    });
  }
  list(): Operation[] {
    const rows=this.db.prepare('SELECT id, actor, resource AS resourceId, name AS resourceName, action, state, message, created AS createdAt, updated AS updatedAt FROM operations ORDER BY rowid DESC LIMIT 100').all() as unknown as Operation[];
    return rows.map(operation=>this.operational.decorate(operation));
  }
  operationHealth(): { total: number; active: number; uncertain: number; failed: number; oldestActiveAt: string | null } {
    const row=this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN state IN ('accepted','running') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertain,SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
      MIN(CASE WHEN state IN ('accepted','running') THEN created END) AS oldestActiveAt FROM operations`).get() as {total:number;active:number|null;uncertain:number|null;failed:number|null;oldestActiveAt:string|null};
    return {total:row.total,active:row.active??0,uncertain:row.uncertain??0,failed:row.failed??0,oldestActiveAt:row.oldestActiveAt};
  }
  eventLogHealth(): { retained: number; firstId: number | null; latestId: number; latestAt: string | null; retentionLimit: number } {
    const row=this.db.prepare('SELECT COUNT(*) AS retained,MIN(id) AS firstId,COALESCE(MAX(id),0) AS latestId,MAX(created_at) AS latestAt FROM event_log').get() as {retained:number;firstId:number|null;latestId:number;latestAt:string|null};
    return {...row,retentionLimit:EVENT_RETENTION};
  }
  recordHostTelemetry(resourceId:string,incoming:HostMetricsSnapshot,receivedAt=new Date().toISOString(),now=Date.now()):{accepted:boolean;sample:HostMetricsSnapshot;receivedAt:string} {
    if(!resourceId||resourceId.length>220||!Number.isFinite(Date.parse(receivedAt)))throw new Error('Invalid host telemetry identity');
    return this.atomic(()=>{
      const row=this.db.prepare('SELECT observed_at AS observedAt,received_at AS receivedAt,payload FROM host_telemetry_latest WHERE resource_id=?').get(resourceId) as {observedAt:string;receivedAt:string;payload:string}|undefined;
      const previous=row?JSON.parse(row.payload) as HostMetricsSnapshot:{};
      const sample:HostMetricsSnapshot={...previous};let changed=false;
      const newer=(next:{observedAt:string}|undefined,current:{observedAt:string}|undefined)=>Boolean(next&&(!current||Date.parse(next.observedAt)>Date.parse(current.observedAt)));
      if(newer(incoming.cpu,sample.cpu)){sample.cpu=incoming.cpu;changed=true;}
      if(newer(incoming.memory,sample.memory)){sample.memory=incoming.memory;changed=true;}
      if(incoming.filesystems){
        const values=new Map((sample.filesystems??[]).map(item=>[`${item.device}\0${item.mountpoint}`,item]));
        for(const item of incoming.filesystems){const key=`${item.device}\0${item.mountpoint}`,current=values.get(key);if(newer(item,current)){values.set(key,item);changed=true;}}
        sample.filesystems=[...values.values()].slice(-32);
      }
      if(incoming.network){
        const values=new Map((sample.network??[]).map(item=>[item.device,item]));
        for(const item of incoming.network){const key=item.device,current=values.get(key);if(newer(item,current)){values.set(key,item);changed=true;}}
        sample.network=[...values.values()].slice(-32);
      }
      const observedAt=[sample.cpu?.observedAt,sample.memory?.observedAt,...(sample.filesystems??[]).map(item=>item.observedAt),...(sample.network??[]).map(item=>item.observedAt)].filter((value):value is string=>Boolean(value)).sort().at(-1);
      if(!observedAt)throw new Error('Host telemetry has no observation');
      if(changed){
        const payload=JSON.stringify(sample);
        this.db.prepare('INSERT INTO host_telemetry_latest(resource_id,observed_at,received_at,payload) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=excluded.received_at,payload=excluded.payload').run(resourceId,observedAt,receivedAt,payload);
        this.db.prepare('INSERT INTO host_telemetry_samples(resource_id,observed_at,received_at,payload) VALUES (?,?,?,?) ON CONFLICT(resource_id,observed_at) DO UPDATE SET received_at=excluded.received_at,payload=excluded.payload').run(resourceId,observedAt,receivedAt,payload);
      }
      const cutoff=new Date(now-24*60*60_000).toISOString();
      this.db.prepare('DELETE FROM host_telemetry_samples WHERE received_at<?').run(cutoff);
      // 30 s host metrics plus 60 s filesystem metrics can yield 4,320
      // observations per day. Keep a 15% buffer while retaining a hard cap.
      this.db.prepare(`DELETE FROM host_telemetry_samples WHERE id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY resource_id ORDER BY received_at DESC,id DESC) AS rank FROM host_telemetry_samples WHERE resource_id=?) WHERE rank>5000)`).run(resourceId);
      return {accepted:changed,sample,receivedAt:changed?receivedAt:row?.receivedAt??receivedAt};
    });
  }
  hostTelemetry(resourceId:string):{sample:HostMetricsSnapshot;observedAt:string;receivedAt:string}|undefined {
    const row=this.db.prepare('SELECT payload,observed_at AS observedAt,received_at AS receivedAt FROM host_telemetry_latest WHERE resource_id=?').get(resourceId) as {payload:string;observedAt:string;receivedAt:string}|undefined;
    return row?{sample:JSON.parse(row.payload) as HostMetricsSnapshot,observedAt:row.observedAt,receivedAt:row.receivedAt}:undefined;
  }
  recordServiceProbe(resourceId:string,signal:ServiceProbeSignal,now=Date.now(),displayResourceId=resourceId,hostResourceId=resourceId):boolean {
    const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=220&&!/[\u0000-\u0020\u007f]/.test(value);
    if(!signal||typeof signal!=='object'||!validId(resourceId)||!validId(displayResourceId)||!validId(hostResourceId)
      ||signal.source!=='https-probe'||!['healthy','degraded','unhealthy','unknown'].includes(signal.state)
      ||typeof signal.observedAt!=='string'||!Number.isFinite(Date.parse(signal.observedAt))
      ||typeof signal.freshUntil!=='string'||!Number.isFinite(Date.parse(signal.freshUntil))||Date.parse(signal.freshUntil)<=Date.parse(signal.observedAt)
      ||Date.parse(signal.freshUntil)-Date.parse(signal.observedAt)>MAX_SERVICE_PROBE_FRESH_MS
      ||Date.parse(signal.observedAt)>now+MAX_FUTURE_TELEMETRY_SKEW_MS||typeof signal.reasonCode!=='string'||!/^[a-z0-9_]{1,80}$/.test(signal.reasonCode)
      ||signal.evidence!==undefined&&(typeof signal.evidence!=='string'||signal.evidence.length>120||/[\u0000-\u001f\u007f]/.test(signal.evidence)))throw new Error('Invalid service probe result');
    const safeSignal:ServiceProbeSignal={state:signal.state,source:'https-probe',observedAt:signal.observedAt,freshUntil:signal.freshUntil,reasonCode:signal.reasonCode,...(signal.evidence?{evidence:signal.evidence}:{})};
    return this.probeLifecycle.record(resourceId,safeSignal,now,displayResourceId,hostResourceId);
  }
  serviceProbe(resourceId:string):ServiceProbeSignal|undefined {
    const row=this.db.prepare('SELECT payload FROM service_probe_latest WHERE resource_id=?').get(resourceId) as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as ServiceProbeSignal:undefined;
  }
  serviceProbeHealth(resourceIds:readonly string[],now=Date.now()):{registered:number;observed:number;healthy:number;degraded:number;unhealthy:number;unknown:number;stale:number;lastObservedAt:string|null} {
    const ids=[...new Set(resourceIds)];
    if(!ids.length)return {registered:0,observed:0,healthy:0,degraded:0,unhealthy:0,unknown:0,stale:0,lastObservedAt:null};
    const rows=this.db.prepare(`SELECT resource_id AS resourceId,observed_at AS observedAt,payload FROM service_probe_latest WHERE resource_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Array<{resourceId:string;observedAt:string;payload:string}>;
    const counts={healthy:0,degraded:0,unhealthy:0,unknown:0,stale:0};
    for(const row of rows){
      const value=JSON.parse(row.payload) as ServiceProbeSignal;
      if(Date.parse(value.freshUntil)<=now)counts.stale++;else counts[value.state]++;
    }
    return {registered:ids.length,observed:rows.length,...counts,lastObservedAt:rows.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0]?.observedAt??null};
  }
  hostTelemetryHealth(resourceIds?:readonly string[],now=Date.now()):{registeredHosts:number;hostsWithData:number;fresh:number;stale:number;samples24h:number;lastReceivedAt:string|null} {
    const latest=this.db.prepare('SELECT resource_id AS resourceId,observed_at AS observedAt,received_at AS receivedAt FROM host_telemetry_latest ORDER BY received_at DESC').all() as Array<{resourceId:string;observedAt:string;receivedAt:string}>;
    const allowed=resourceIds?new Set(resourceIds):undefined,rows=latest.filter(item=>!allowed||allowed.has(item.resourceId));
    const sampleCount=rows.length?Number(this.db.prepare(`SELECT COUNT(*) AS count FROM host_telemetry_samples WHERE received_at>=? AND resource_id IN (${rows.map(()=>'?').join(',')})`).get(new Date(now-24*60*60_000).toISOString(),...rows.map(item=>item.resourceId))?.count??0):0;
    const registered=allowed?allowed.size:rows.length,fresh=rows.filter(item=>now-Date.parse(item.observedAt)<=90_000&&now>=Date.parse(item.observedAt)-MAX_FUTURE_TELEMETRY_SKEW_MS).length;
    return {registeredHosts:registered,hostsWithData:rows.length,fresh,stale:rows.length-fresh,samples24h:sampleCount,lastReceivedAt:rows[0]?.receivedAt??null};
  }
  incidentDeliveryHealth(consumer?:string,allow:(payload:Record<string,unknown>,aggregateId:string)=>boolean=()=>true): { consumers: number; leased: number; acked: number; dead: number } {
    const counts={consumers:0,leased:0,acked:0,dead:0},consumers=new Set<string>();
    const statement=this.db.prepare(`SELECT consumer,status,payload,aggregate_id AS aggregateId FROM mcp_incident_deliveries ${consumer?'WHERE consumer=?':''}`);
    for(const value of consumer?statement.iterate(consumer):statement.iterate()){
      const row=value as {consumer:string;status:'leased'|'acked'|'dead';payload:string;aggregateId:string};
      if(!allow(JSON.parse(row.payload) as Record<string,unknown>,row.aggregateId))continue;
      consumers.add(row.consumer);counts[row.status]++;
    }
    counts.consumers=consumers.size;return counts;
  }
  appendEvent(type: EventType, aggregateId: string, payload: Record<string, unknown>): number {
    return this.transaction(()=>{
      if(type==='operation'&&typeof payload.id==='string'&&!payload.reviewChange){
        this.operational?.operationChanged(payload.id);
        payload=this.operational?.decorate(payload as unknown as Operation) as unknown as Record<string,unknown>??payload;
      }
      const createdAt=new Date().toISOString();
      const serialized=JSON.stringify(payload);
      const result=this.db.prepare('INSERT INTO event_log(type,aggregate_id,payload,created_at) VALUES (?,?,?,?)').run(type,aggregateId,serialized,createdAt);
      const id=Number(result.lastInsertRowid);
      this.deferredEvents.push({id,type,aggregateId,payload:JSON.parse(serialized) as Record<string,unknown>,createdAt});
      this.operational?.acceptEvent({id,type,aggregateId,payload,createdAt});
      if(id%100===0)this.db.prepare('DELETE FROM event_log WHERE id <= ?').run(id-EVENT_RETENTION);
      return id;
    });
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
  private notifyEventListeners(events: DurableEvent[]): void {
    for(const event of events)this.eventNotifications.push(event);
    if(this.notifyingEvents)return;
    this.notifyingEvents=true;
    try{
      for(const event of this.eventNotifications){
        for(const listener of this.eventListeners){
          try{listener(event.id,event);}catch{/* Event consumers cannot invalidate a durable write. */}
        }
      }
    }finally{this.eventNotifications=[];this.notifyingEvents=false;}
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
  enqueueCloudEvent(event: Omit<PendingCloudEvent, 'attempts'>): 'accepted' | 'duplicate' | 'conflict' {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT account_id AS accountId,region,instance_id AS instanceId,state,event_time AS eventTime FROM cloud_event_inbox WHERE event_key=?').get(event.eventKey) as Omit<PendingCloudEvent, 'attempts' | 'receivedAt'> | undefined;
      if (existing) {
        return existing.accountId === event.accountId && existing.region === event.region && existing.instanceId === event.instanceId && existing.state === event.state && existing.eventTime === event.eventTime
          ? 'duplicate' : 'conflict';
      }
      this.db.prepare(`INSERT INTO cloud_event_inbox(event_key,account_id,region,instance_id,state,event_time,received_at,status)
        VALUES (?,?,?,?,?,?,?,'pending')`).run(event.eventKey,event.accountId,event.region,event.instanceId,event.state,event.eventTime,event.receivedAt);
      return 'accepted';
    });
  }
  pendingCloudEvents(limit = 100): PendingCloudEvent[] {
    return this.db.prepare("SELECT event_key AS eventKey,account_id AS accountId,region,instance_id AS instanceId,state,event_time AS eventTime,received_at AS receivedAt,attempts FROM cloud_event_inbox WHERE status='pending' ORDER BY received_at,event_key LIMIT ?").all(Math.max(1,Math.min(500,limit))) as PendingCloudEvent[];
  }
  finishCloudEvent(eventKey: string, status: 'processed' | 'ignored', reasonCode?: string): void {
    this.db.prepare("UPDATE cloud_event_inbox SET status=?,attempts=attempts+1,processed_at=?,reason_code=? WHERE event_key=? AND status='pending'").run(status,new Date().toISOString(),reasonCode??null,eventKey);
  }
  retryCloudEvent(eventKey: string, reasonCode: string): number {
    this.db.prepare("UPDATE cloud_event_inbox SET attempts=attempts+1,reason_code=? WHERE event_key=? AND status='pending'").run(reasonCode,eventKey);
    return (this.db.prepare('SELECT attempts FROM cloud_event_inbox WHERE event_key=?').get(eventKey) as {attempts:number}|undefined)?.attempts??0;
  }
  cloudEventHealth(): { pending: number; processed: number; ignored: number; lastReceivedAt: string | null; lastProcessedAt: string | null } {
    const counts=this.db.prepare("SELECT status,COUNT(*) AS count FROM cloud_event_inbox GROUP BY status").all() as Array<{status:'pending'|'processed'|'ignored';count:number}>;
    const latest=this.db.prepare('SELECT MAX(received_at) AS lastReceivedAt,MAX(processed_at) AS lastProcessedAt FROM cloud_event_inbox').get() as {lastReceivedAt:string|null;lastProcessedAt:string|null};
    const byStatus=new Map(counts.map(item=>[item.status,item.count]));
    return {pending:byStatus.get('pending')??0,processed:byStatus.get('processed')??0,ignored:byStatus.get('ignored')??0,...latest};
  }
  operationHistory(id: string): DurableEvent[] {
    const rows = this.db.prepare("SELECT id,type,aggregate_id AS aggregateId,payload,created_at AS createdAt FROM event_log WHERE aggregate_id=? AND type='operation' ORDER BY id").all(`operation:${id}`) as EventRow[];
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }
  subscribeEvents(listener: (eventId: number, event: DurableEvent) => void): () => void {
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
    return row?parsePushPreferences(row.preferences):undefined;
  }
  pushSubscriptions(): PushSubscriptionSummary[] {
    const rows=this.db.prepare('SELECT id,preferences,created_at AS createdAt,last_success_at AS lastSuccessAt FROM push_subscriptions ORDER BY created_at').all() as {id:string;preferences:string;createdAt:string;lastSuccessAt:string|null}[];
    return rows.map(row=>({...row,preferences:parsePushPreferences(row.preferences)}));
  }
  pushSubscription(id: string): PushSubscriptionRecord | undefined {
    const row=this.db.prepare('SELECT id,endpoint_hash AS endpointHash,ciphertext,preferences,created_at AS createdAt,last_success_at AS lastSuccessAt FROM push_subscriptions WHERE id=?').get(id) as (Omit<PushSubscriptionRecord,'preferences'>&{preferences:string})|undefined;
    return row?{...row,preferences:parsePushPreferences(row.preferences)}:undefined;
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
  enqueuePush(eventKey:string,subscriptionId:string,payload:Record<string,unknown>,now=Date.now(),notBefore=now):void {
    this.db.prepare("INSERT OR IGNORE INTO push_outbox(id,event_key,subscription_id,payload,state,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,'pending',0,?,?)").run(randomUUID(),eventKey,subscriptionId,JSON.stringify(payload),notBefore,new Date(now).toISOString());
  }
  /** Avisos de pérdida que esperan su turno (aún no se intentó entregarlos): una recuperación a tiempo los cancela. */
  heldPushIds(subscriptionId:string,lossKey:string,now=Date.now()):string[] {
    const rows=this.db.prepare("SELECT id FROM push_outbox WHERE subscription_id=? AND state='pending' AND attempts=0 AND next_attempt_at>? AND json_extract(payload,'$.lossKey')=?").all(subscriptionId,now,lossKey) as {id:string}[];
    return rows.map(row=>row.id);
  }
  lastSentPushEventId(subscriptionId:string,field:'lossKey'|'recoversKey',key:string):number|undefined {
    const row=this.db.prepare(`SELECT MAX(CAST(event_key AS INTEGER)) AS id FROM push_outbox WHERE subscription_id=? AND state='sent' AND json_extract(payload,'$.${field}')=?`).get(subscriptionId,key) as {id:number|null};
    return row.id===null?undefined:Number(row.id);
  }
  pushSignalBootstrapDone():boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM settings WHERE key='push-signal-state-bootstrap-v1'").get());
  }
  legacyPushSignalEvents():Array<{subscriptionId:string;signalKey:string;eventId:number;signal:'loss'|'recovery'}> {
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_signal_events'").get();
    if(!exists)return [];
    return this.db.prepare('SELECT subscription_id AS subscriptionId,signal_key AS signalKey,event_id AS eventId,signal FROM push_signal_events ORDER BY event_id').all() as Array<{subscriptionId:string;signalKey:string;eventId:number;signal:'loss'|'recovery'}>;
  }
  pushOutboxSignalEvents():Array<{subscriptionId:string;signalKey:string;eventId:number;signal:'loss'|'recovery'}> {
    const rows=this.db.prepare('SELECT subscription_id AS subscriptionId,event_key AS eventKey,payload FROM push_outbox ORDER BY CAST(event_key AS INTEGER)').all() as Array<{subscriptionId:string;eventKey:string;payload:string}>;
    const result:Array<{subscriptionId:string;signalKey:string;eventId:number;signal:'loss'|'recovery'}>=[];
    for(const row of rows){
      if(!/^(0|[1-9][0-9]*)$/.test(row.eventKey))continue;
      const eventId=Number(row.eventKey);if(!Number.isSafeInteger(eventId))continue;
      try{
        const payload=JSON.parse(row.payload) as {lossKey?:unknown;recoversKey?:unknown};
        if(typeof payload.lossKey==='string')result.push({subscriptionId:row.subscriptionId,signalKey:payload.lossKey,eventId,signal:'loss'});
        if(typeof payload.recoversKey==='string')result.push({subscriptionId:row.subscriptionId,signalKey:payload.recoversKey,eventId,signal:'recovery'});
      }catch{/* Invalid legacy payloads cannot establish the current incident cycle. */}
    }
    return result;
  }
  bootstrapPushSignalStates(seeds:readonly PushSignalSeed[]):void {
    this.transaction(()=>{
      if(this.pushSignalBootstrapDone())return;
      const insert=this.db.prepare(`INSERT INTO push_signal_state(subscription_id,signal_key,event_id,signal,previous_event_id,previous_signal)
        VALUES (?,?,?,?,?,?) ON CONFLICT(subscription_id,signal_key) DO UPDATE SET
        event_id=excluded.event_id,signal=excluded.signal,previous_event_id=excluded.previous_event_id,previous_signal=excluded.previous_signal
        WHERE excluded.event_id>=push_signal_state.event_id`);
      for(const seed of seeds)insert.run(seed.subscriptionId,seed.signalKey,seed.eventId,seed.signal,seed.previousEventId,seed.previousSignal);
      this.db.prepare("INSERT INTO settings(key,value) VALUES ('push-signal-state-bootstrap-v1','true')").run();
      const legacy=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_signal_events'").get();
      if(legacy)this.db.exec('DROP TABLE push_signal_events');
    });
  }
  observePushSignal(subscriptionId:string,key:string,eventId:number,signal:'loss'|'recovery'):PushSignalState|undefined {
    return this.transaction(()=>{
      const current=this.db.prepare('SELECT event_id AS eventId,signal,previous_signal AS previousSignal FROM push_signal_state WHERE subscription_id=? AND signal_key=?').get(subscriptionId,key) as {eventId:number;signal:PushSignalState;previousSignal:PushSignalState|null}|undefined;
      if(current?.eventId===eventId)return current.previousSignal??undefined;
      if(current&&current.eventId>eventId)return undefined;
      this.db.prepare(`INSERT INTO push_signal_state(subscription_id,signal_key,event_id,signal,previous_event_id,previous_signal)
        VALUES (?,?,?,?,?,?) ON CONFLICT(subscription_id,signal_key) DO UPDATE SET
        event_id=excluded.event_id,signal=excluded.signal,previous_event_id=excluded.previous_event_id,previous_signal=excluded.previous_signal
        WHERE excluded.event_id>push_signal_state.event_id`).run(subscriptionId,key,eventId,signal,current?.eventId??null,current?.signal??null);
      return current?.signal;
    });
  }
  markPushSignalsUnknown(cursor:number):void {
    this.db.prepare(`UPDATE push_signal_state SET previous_event_id=event_id,previous_signal='unknown',
      event_id=MAX(event_id,?),signal='unknown' WHERE event_id<=?`).run(cursor,cursor);
  }
  pendingPushIds(subscriptionId:string,field:'lossKey'|'recoversKey',key:string):string[] {
    const rows=this.db.prepare(`SELECT id FROM push_outbox WHERE subscription_id=? AND state='pending' AND json_extract(payload,'$.${field}')=? ORDER BY created_at,id`).all(subscriptionId,key) as {id:string}[];
    return rows.map(row=>row.id);
  }
  hasRecentPushTag(subscriptionId:string,tag:string,sinceIso:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM push_outbox WHERE subscription_id=? AND created_at>=? AND state IN ('pending','sending','sent') AND json_extract(payload,'$.tag')=? LIMIT 1").get(subscriptionId,sinceIso,tag));
  }
  claimPush(now=Date.now()):PushOutboxRecord|undefined {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT id,event_key AS eventKey,subscription_id AS subscriptionId,payload,attempts FROM push_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at,id LIMIT 1").get(now) as (PushOutboxRecord & {attempts:number})|undefined;
      if(!row)return undefined;
      this.db.prepare("UPDATE push_outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").run(row.id);
      return {...row,attempts:row.attempts+1};
    });
  }
  deferClaimedPush(id: string, until: number): void {
    this.db.prepare("UPDATE push_outbox SET state='pending',attempts=MAX(0,attempts-1),next_attempt_at=MAX(next_attempt_at,?) WHERE id=? AND state='sending'").run(until,id);
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
