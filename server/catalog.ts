import { randomUUID } from 'node:crypto';
import type { CatalogIdentity, CatalogProvider, Resource, ServiceDefinition } from './types.js';
import { projectHostCatalogResource } from './host-catalog.js';
import type { Store } from './store.js';

export type ConnectionInput = { provider: CatalogProvider; providerAccountId: string; name: string; displayName?: string; credentialRef: string };
export type CatalogSnapshot = {
  providerId: string; resourceType: string; region: string; name: string; state: string; detail: string;
  observedAt?: string | null; stateChangedAt?: string | null; tags?: Record<string, string>; aliases?: string[];
};
export type ScopeResult = { complete: boolean; observedAt: string; errorCode?: string; state?: 'partial' | 'failed' };
export type CatalogResourceRecord = {
  catalogId: string; provider: CatalogProvider; connectionId: string; accountId: string; scopeKey: string;
  region: string; resourceType: string; providerId: string; name: string; state: string; detail: string;
  tags: Record<string, string>; lifecycle: 'active' | 'candidate_missing' | 'retired'; firstSeen: string | null;
  observedAt: string | null; stateChangedAt: string | null; missingSince: string | null; missingScans: number;
  projectId: string | null; project: string | null; environment: string | null; accountName: string;
  aliases: string[];
};
export type CatalogScopeRecord = {
  connectionId: string; scopeKey: string; state: 'healthy' | 'partial' | 'failed'; generation: number;
  lastAttemptAt: string; lastSuccessAt: string | null; errorCode: string | null; resourceCount: number;
};
export type CatalogServiceRelation = {
  resourceAlias:string; resourceId:string|null; resolved:boolean;
  relationType:'hosted_on'|'depends_on'; evidence:'operator_confirmed'|'provider_metadata';
  active:boolean; firstSeen:string; lastSeen:string;
  resource?:{catalogId:string;name:string;provider:CatalogProvider;accountId:string;region:string;state:string;lifecycle:CatalogResourceRecord['lifecycle']};
};
export type CatalogServiceRecord = {
  id:string; key:string; name:string; projectId:string|null; project:string|null; environment:string|null;
  criticality:'critical'|'high'|'normal'|'low'; source:string; active:boolean; relations:CatalogServiceRelation[];
};
type ResourceRow = {
  id: string; provider: CatalogProvider; connection_id: string; account_id: string; scope_key: string;
  region: string; resource_type: string; provider_id: string; name: string; state: string; detail: string;
  tags: string; lifecycle: CatalogResourceRecord['lifecycle']; first_seen: string | null; last_seen: string | null;
  state_changed_at: string | null; missing_since: string | null; missing_scans: number;
  project_id: string | null; project_name: string | null; environment: string | null; account_name: string;
};
const MIN_RETIREMENT_MS = 15 * 60_000;
const MAX_ACTION_OBSERVATION_AGE_MS = 20 * 60_000;
const MAX_FUTURE_OBSERVATION_SKEW_MS = 5 * 60_000;
const SAFE_TAGS = ['Project', 'Environment', 'Service', 'Role'] as const;
const validIso = (value: string | null | undefined): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const clean = (value: string, max: number, field: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`Invalid ${field}`);
  return normalized;
};
const identityOf = (provider: string, accountId: string, snapshot: CatalogSnapshot): string => JSON.stringify([provider, accountId, snapshot.region, snapshot.resourceType, snapshot.providerId]);

export class CatalogRepository {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  registerConnection(input: ConnectionInput): { id: string; provider: CatalogProvider; providerAccountId: string; name: string } {
    const providerAccountId = clean(input.providerAccountId, 255, 'provider account identity');
    const aliasName = clean(input.name, 120, 'connection alias');
    const name = clean(input.displayName ?? input.name, 120, 'connection name');
    const credentialRef = clean(input.credentialRef, 255, 'credential reference');
    return this.store.atomic(() => {
      const existing = this.store.db.prepare('SELECT id FROM provider_connections WHERE provider=? AND provider_account_id=?').get(input.provider, providerAccountId) as { id: string } | undefined;
      const now = new Date().toISOString();
      const id = existing?.id ?? randomUUID();
      this.store.db.prepare(`INSERT INTO provider_connections(id,provider,provider_account_id,name,credential_ref,state,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?) ON CONFLICT(provider,provider_account_id) DO UPDATE SET name=excluded.name,credential_ref=excluded.credential_ref,updated_at=excluded.updated_at`).run(id, input.provider, providerAccountId, name, credentialRef, now, now);
      const alias = `${input.provider}:${aliasName}`;
      const current = this.store.db.prepare('SELECT connection_id FROM provider_connection_aliases WHERE alias=?').get(alias) as { connection_id: string } | undefined;
      if (current && current.connection_id !== id) throw new Error('Connection alias already assigned');
      this.store.db.prepare('INSERT OR IGNORE INTO provider_connection_aliases(alias,connection_id) VALUES (?,?)').run(alias, id);
      return { id, provider: input.provider, providerAccountId, name };
    });
  }

  setConnectionState(connectionId: string, state: 'active' | 'suspended'): void {
    if (state !== 'active' && state !== 'suspended') throw new Error('Invalid connection state');
    this.store.atomic(() => {
      const current = this.store.db.prepare('SELECT state FROM provider_connections WHERE id=?').get(connectionId) as { state: string } | undefined;
      if (!current) throw new Error('Connection not found');
      if (current.state === state) return;
      this.store.db.prepare('UPDATE provider_connections SET state=?,updated_at=? WHERE id=?').run(state, new Date(this.now()).toISOString(), connectionId);
      // Suspension is administrative, not a provider observation or recovery.
      // Preserve resources, timestamps, generations, incidents and operations.
      if (state === 'suspended') this.store.db.prepare("UPDATE catalog_scopes SET state='partial',error_code='connection_suspended' WHERE connection_id=?").run(connectionId);
    });
  }

  isResourceReferenceActive(resourceId: string): boolean {
    const record = resourceId.startsWith('catalog:')
      ? this.store.db.prepare('SELECT connection_id FROM catalog_resources WHERE id=?').get(resourceId.slice('catalog:'.length)) as { connection_id: string } | undefined
      : this.store.db.prepare('SELECT r.connection_id FROM catalog_resources r JOIN catalog_resource_aliases a ON a.resource_id=r.id WHERE a.alias=?').get(resourceId) as { connection_id: string } | undefined;
    const inactive = this.connections().filter(connection => connection.state !== 'active');
    if (record && inactive.some(connection => connection.id === record.connection_id)) return false;
    if (inactive.some(connection => resourceId.startsWith(`${connection.provider}:${connection.providerAccountId}:`))) return false;
    const aliases = this.store.db.prepare("SELECT a.alias FROM provider_connection_aliases a JOIN provider_connections c ON c.id=a.connection_id WHERE c.state!='active'").all() as { alias: string }[];
    return !aliases.some(item => resourceId.startsWith(`${item.alias}:`));
  }

  connections(): Array<{ id: string; provider: CatalogProvider; providerAccountId: string; name: string; state: string }> {
    return this.store.db.prepare('SELECT id,provider,provider_account_id AS providerAccountId,name,state FROM provider_connections ORDER BY provider,name').all() as Array<{ id: string; provider: CatalogProvider; providerAccountId: string; name: string; state: string }>;
  }

  connectionByAlias(provider: CatalogProvider, name: string): { id: string; providerAccountId: string; name: string } | undefined {
    return this.store.db.prepare(`SELECT c.id,c.provider_account_id AS providerAccountId,c.name FROM provider_connections c
      JOIN provider_connection_aliases a ON a.connection_id=c.id WHERE a.alias=? AND c.provider=?`).get(`${provider}:${name}`, provider) as { id: string; providerAccountId: string; name: string } | undefined;
  }

  seedLegacyResource(connectionId: string, snapshot: CatalogSnapshot): void {
    const connection = this.store.db.prepare('SELECT provider,provider_account_id FROM provider_connections WHERE id=?').get(connectionId) as { provider: CatalogProvider; provider_account_id: string } | undefined;
    if (!connection) throw new Error('Connection not found');
    const safeSnapshot = this.validateSnapshot(snapshot, null);
    this.store.atomic(() => {
      const identity = identityOf(connection.provider, connection.provider_account_id, safeSnapshot);
      let row = this.store.db.prepare('SELECT id FROM catalog_resources WHERE provider_identity=?').get(identity) as { id: string } | undefined;
      if (!row) {
        const id = randomUUID(), tags = JSON.stringify(this.safeTags(safeSnapshot.tags));
        this.store.db.prepare(`INSERT INTO catalog_resources(id,provider_identity,provider,connection_id,account_id,scope_key,region,resource_type,provider_id,
          name,state,detail,tags,lifecycle,first_seen,last_seen,state_changed_at,missing_since,missing_scans,project_id,environment)
          VALUES (?,?,?,?,?,?,?,?,?,?,'unknown',?,?,'active',NULL,NULL,NULL,NULL,0,NULL,NULL)`).run(id, identity, connection.provider, connectionId, connection.provider_account_id, `legacy:${safeSnapshot.region}`, safeSnapshot.region, safeSnapshot.resourceType, safeSnapshot.providerId, safeSnapshot.name, safeSnapshot.detail, tags);
        row = { id };
      }
      this.addAliases(row.id, safeSnapshot.aliases ?? []);
    });
  }

  reconcileScope(connectionId: string, scopeKeyInput: string, snapshots: CatalogSnapshot[], result: ScopeResult, minRetirementMs = MIN_RETIREMENT_MS): { applied: boolean; generation: number; changed: number } {
    const scopeKey = clean(scopeKeyInput, 160, 'scope key');
    if (!validIso(result.observedAt) || !Number.isFinite(minRetirementMs) || minRetirementMs < 1) throw new Error('Invalid scope observation');
    const connection = this.store.db.prepare('SELECT provider,provider_account_id,name,state FROM provider_connections WHERE id=?').get(connectionId) as { provider: CatalogProvider; provider_account_id: string; name: string; state: string } | undefined;
    if (!connection) throw new Error('Connection not found');
    if (connection.state !== 'active') {
      const previous = this.store.db.prepare('SELECT generation FROM catalog_scopes WHERE connection_id=? AND scope_key=?').get(connectionId, scopeKey) as { generation: number } | undefined;
      return { applied: false, generation: previous?.generation ?? 0, changed: 0 };
    }
    const safeSnapshots = result.complete ? snapshots.map(item => this.validateSnapshot(item, result.observedAt)) : [];
    const seen = new Set<string>();
    for (const item of safeSnapshots) {
      const identity = identityOf(connection.provider, connection.provider_account_id, item);
      if (seen.has(identity)) throw new Error('Duplicate resource identity in scope');
      seen.add(identity);
    }
    const distinctProviderIds = new Set(safeSnapshots.map(item => item.providerId));
    if (distinctProviderIds.size !== safeSnapshots.length) throw new Error('Duplicate provider ID in scope');

    return this.store.atomic(() => {
      const previous = this.store.db.prepare('SELECT state,generation,last_success_at AS lastSuccessAt FROM catalog_scopes WHERE connection_id=? AND scope_key=?').get(connectionId, scopeKey) as { state: CatalogScopeRecord['state']; generation: number; lastSuccessAt: string | null } | undefined;
      const scopeObservedAt = result.observedAt;
      if (previous?.lastSuccessAt && Date.parse(scopeObservedAt) <= Date.parse(previous.lastSuccessAt)) {
        return { applied: false, generation: previous.generation, changed: 0 };
      }
      if (!result.complete) {
        const state = result.state ?? 'partial';
        this.store.db.prepare(`INSERT INTO catalog_scopes(connection_id,scope_key,state,generation,last_attempt_at,last_success_at,error_code,resource_count)
          VALUES (?,?,?,?,?,NULL,?,0) ON CONFLICT(connection_id,scope_key) DO UPDATE SET state=excluded.state,last_attempt_at=excluded.last_attempt_at,error_code=excluded.error_code`).run(connectionId, scopeKey, state, previous?.generation ?? 0, scopeObservedAt, result.errorCode ? clean(result.errorCode, 80, 'error code') : 'incomplete_snapshot');
        if(previous?.state!==state)this.store.appendEvent('coverage',`coverage:${connectionId}:${scopeKey}`,{
          connectionId,connectionName:connection.name,provider:connection.provider,scopeKey,previousState:previous?.state??null,state,errorCode:result.errorCode?clean(result.errorCode,80,'error code'):'incomplete_snapshot',observedAt:scopeObservedAt
        });
        return { applied: false, generation: previous?.generation ?? 0, changed: 0 };
      }

      let changed = 0;
      for (const snapshot of safeSnapshots) if (this.upsertResource(connectionId, connection.provider, connection.provider_account_id, scopeKey, snapshot)) changed++;

      const existing = this.store.db.prepare(`SELECT id,provider_identity,name,state,lifecycle,missing_since,last_seen FROM catalog_resources
        WHERE connection_id=? AND scope_key=? AND lifecycle IN ('active','candidate_missing')`).all(connectionId, scopeKey) as Array<{ id: string; provider_identity: string; name: string; state: string; lifecycle: CatalogResourceRecord['lifecycle']; missing_since: string | null; last_seen: string | null }>;
      for (const row of existing) {
        if (row.last_seen && Date.parse(row.last_seen) > Date.parse(scopeObservedAt)) continue;
        if (seen.has(row.provider_identity)) continue;
        if (row.lifecycle === 'active') {
          this.store.db.prepare("UPDATE catalog_resources SET lifecycle='candidate_missing',missing_since=?,missing_scans=1 WHERE id=?").run(scopeObservedAt, row.id);
          this.store.appendEvent('resource', `catalog:${row.id}`, { catalogId: row.id, name: row.name, state: row.state, lifecycle: 'candidate_missing', observedAt: scopeObservedAt, reason: 'missing_from_complete_snapshot' });
          changed++;
        } else {
          const elapsed = Date.parse(scopeObservedAt) - Date.parse(row.missing_since ?? scopeObservedAt);
          const lifecycle = elapsed >= minRetirementMs ? 'retired' : 'candidate_missing';
          this.store.db.prepare('UPDATE catalog_resources SET lifecycle=?,missing_scans=missing_scans+1 WHERE id=?').run(lifecycle, row.id);
          if (lifecycle === 'retired') {
            this.store.appendEvent('resource', `catalog:${row.id}`, { catalogId: row.id, name: row.name, state: row.state, lifecycle, observedAt: scopeObservedAt, reason: 'absent_from_repeated_complete_snapshots' });
            changed++;
          }
        }
      }
      const generation = (previous?.generation ?? 0) + 1;
      this.store.db.prepare(`INSERT INTO catalog_scopes(connection_id,scope_key,state,generation,last_attempt_at,last_success_at,error_code,resource_count)
        VALUES (?,?,'healthy',?,?,?,NULL,?) ON CONFLICT(connection_id,scope_key) DO UPDATE SET state='healthy',generation=excluded.generation,
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error_code=NULL,resource_count=excluded.resource_count`).run(connectionId, scopeKey, generation, scopeObservedAt, scopeObservedAt, safeSnapshots.length);
      if(previous?.state!=='healthy')this.store.appendEvent('coverage',`coverage:${connectionId}:${scopeKey}`,{
        connectionId,connectionName:connection.name,provider:connection.provider,scopeKey,previousState:previous?.state??null,state:'healthy',generation,resourceCount:safeSnapshots.length,observedAt:scopeObservedAt
      });
      return { applied: true, generation, changed };
    });
  }

  /** Update source coverage without reconciling resources or counting another scan. */
  setHostScopeReadState(connectionId: string, scopeKey: string, outcome: {
    state: CatalogScopeRecord['state']; errorCode: string | null; at: string; duplicate?: true;
  }): void {
    const connection = this.store.db.prepare("SELECT name FROM provider_connections WHERE id=? AND provider='host' AND state='active'").get(connectionId) as { name: string } | undefined;
    if (!connection) return;
    const previous = this.store.db.prepare(`SELECT state,generation,error_code AS errorCode,last_success_at AS lastSuccessAt,resource_count AS resourceCount
      FROM catalog_scopes WHERE connection_id=? AND scope_key=?`).get(connectionId, scopeKey) as CatalogScopeRecord | undefined;
    if (outcome.duplicate) {
      if (previous?.state !== 'failed') return;
      if (outcome.state === 'healthy' && previous.lastSuccessAt !== outcome.at) return;
      if (previous.lastSuccessAt && Date.parse(outcome.at) < Date.parse(previous.lastSuccessAt)) return;
      this.store.db.prepare('UPDATE catalog_scopes SET state=?,error_code=?,last_attempt_at=? WHERE connection_id=? AND scope_key=?')
        .run(outcome.state, outcome.errorCode, outcome.at, connectionId, scopeKey);
    } else {
      if (previous?.state === outcome.state && previous.errorCode === outcome.errorCode) return;
      this.store.db.prepare(`INSERT INTO catalog_scopes(connection_id,scope_key,state,generation,last_attempt_at,last_success_at,error_code,resource_count)
        VALUES (?,?,?,0,?,NULL,?,0) ON CONFLICT(connection_id,scope_key) DO UPDATE SET state=excluded.state,error_code=excluded.error_code`)
        .run(connectionId, scopeKey, outcome.state, outcome.at, outcome.errorCode);
    }
    if (previous?.state !== outcome.state) this.store.appendEvent('coverage', `coverage:${connectionId}:${scopeKey}`, {
      connectionId, connectionName: connection.name, provider: 'host', scopeKey, previousState: previous?.state ?? null,
      state: outcome.state, errorCode: outcome.errorCode, generation: previous?.generation ?? 0,
      resourceCount: previous?.resourceCount ?? 0, observedAt: outcome.at
    });
  }

  listResources(options: { includeRetired?: boolean } = {}): CatalogResourceRecord[] {
    const retiredFilter = options.includeRetired ? '' : "WHERE r.lifecycle!='retired'";
    const rows = this.store.db.prepare(`SELECT r.id,r.provider,r.connection_id,r.account_id,r.scope_key,r.region,r.resource_type,r.provider_id,r.name,r.state,r.detail,r.tags,r.lifecycle,r.first_seen,r.last_seen,r.state_changed_at,r.missing_since,r.missing_scans,r.project_id,p.name AS project_name,r.environment,c.name AS account_name
      FROM catalog_resources r JOIN provider_connections c ON c.id=r.connection_id LEFT JOIN catalog_projects p ON p.id=r.project_id ${retiredFilter} ORDER BY c.name,r.region,r.name`).all() as ResourceRow[];
    const aliases = this.store.db.prepare('SELECT alias,resource_id FROM catalog_resource_aliases ORDER BY created_at,alias').all() as Array<{ alias: string; resource_id: string }>;
    const byId = new Map<string, string[]>();
    for (const alias of aliases) byId.set(alias.resource_id, [...(byId.get(alias.resource_id) ?? []), alias.alias]);
    return rows.map(row => ({
      catalogId: row.id, provider: row.provider, connectionId: row.connection_id, accountId: row.account_id, scopeKey: row.scope_key,
      region: row.region, resourceType: row.resource_type, providerId: row.provider_id, name: row.name, state: row.state, detail: row.detail,
      tags: this.safeTags(JSON.parse(row.tags) as Record<string, string>), lifecycle: row.lifecycle, firstSeen: row.first_seen,
      observedAt: row.last_seen, stateChangedAt: row.state_changed_at, missingSince: row.missing_since, missingScans: row.missing_scans,
      projectId: row.project_id, project: row.project_name, environment: row.environment, accountName: row.account_name, aliases: byId.get(row.id) ?? []
    }));
  }

  listScopes(): CatalogScopeRecord[] {
    return this.store.db.prepare(`SELECT connection_id AS connectionId,scope_key AS scopeKey,state,generation,last_attempt_at AS lastAttemptAt,
      last_success_at AS lastSuccessAt,error_code AS errorCode,resource_count AS resourceCount FROM catalog_scopes ORDER BY connection_id,scope_key`).all() as CatalogScopeRecord[];
  }

  resolveAlias(alias: string): CatalogResourceRecord | undefined {
    const safeAlias = clean(alias, 200, 'resource alias');
    const match = this.store.db.prepare('SELECT resource_id FROM catalog_resource_aliases WHERE alias=?').get(safeAlias) as { resource_id: string } | undefined;
    return match ? this.listResources({ includeRetired: true }).find(item => item.catalogId === match.resource_id) : undefined;
  }

  applyAwsStateEvent(input: { accountId: string; region: string; instanceId: string; state: string; eventTime: string; eventId: string }): { status: 'applied' | 'ignored'; reasonCode?: string; previousState: string | null; resource?: CatalogResourceRecord } {
    if (!validIso(input.eventTime)) throw new Error('Invalid cloud event timestamp');
    const connection = this.store.db.prepare("SELECT id FROM provider_connections WHERE provider='aws' AND provider_account_id=? AND state='active'").get(input.accountId) as { id: string } | undefined;
    if (!connection) return { status: 'ignored', reasonCode: 'connection_unavailable', previousState: null };
    const snapshot: CatalogSnapshot = {
      providerId: clean(input.instanceId, 200, 'provider resource ID'), resourceType: 'ec2-instance', region: clean(input.region, 100, 'resource region'),
      name: input.instanceId, state: clean(input.state, 80, 'resource state'), detail: 'EC2 · estado recibido por EventBridge',
      observedAt: input.eventTime, stateChangedAt: input.eventTime, aliases: [`aws:${input.accountId}:${input.region}:${input.instanceId}`]
    };
    const identity = identityOf('aws', input.accountId, snapshot);
    let outcome: { status: 'applied' | 'ignored'; reasonCode?: string; previousState: string | null } = { status: 'applied', previousState: null };
    this.store.atomic(() => {
      const current = this.store.db.prepare('SELECT id,name,state,detail,tags,lifecycle,project_id,environment,state_changed_at,last_seen,scope_key FROM catalog_resources WHERE provider_identity=?').get(identity) as (ResourceRow & { last_seen: string | null; scope_key: string }) | undefined;
      if (current?.last_seen && Date.parse(input.eventTime) <= Date.parse(current.last_seen)) {
        outcome = { status: 'ignored', reasonCode: 'stale_event', previousState: current.state };
        return;
      }
      if (!current) {
        this.upsertResource(connection.id, 'aws', input.accountId, `aws:ec2:${input.region}`, snapshot);
        return;
      }
      const previousState = current.state;
      const stateChanged = previousState !== input.state;
      this.store.db.prepare(`UPDATE catalog_resources SET state=?,last_seen=?,state_changed_at=?,lifecycle='active',missing_since=NULL,missing_scans=0 WHERE id=?`).run(
        input.state, input.eventTime, stateChanged ? input.eventTime : current.state_changed_at, current.id
      );
      this.addAliases(current.id, snapshot.aliases ?? []);
      this.store.expectations.observe(`catalog:${current.id}`, input.state, input.eventTime);
      if (stateChanged || current.lifecycle !== 'active') this.store.appendEvent('resource', `catalog:${current.id}`, {
        catalogId: current.id, provider: 'aws', accountId: input.accountId, region: input.region, providerId: input.instanceId,
        name: current.name, state: input.state, stateChangedAt: stateChanged ? input.eventTime : current.state_changed_at,
        lifecycle: 'active', observedAt: input.eventTime, reason: 'aws_eventbridge_state_change', eventId: input.eventId
      });
      outcome = { status: 'applied', previousState };
    });
    if (outcome.status === 'ignored') return outcome;
    const resource = this.listResources({ includeRetired: true }).find(item => item.provider === 'aws' && item.accountId === input.accountId && item.region === input.region && item.providerId === input.instanceId);
    return { ...outcome, ...(resource ? { resource } : {}) };
  }

  applyVerifiedObservation(resourceId: string, stateInput: string, observedAt: string, stateChangedAt?: string | null): boolean {
    const state=clean(stateInput,80,'verified resource state');
    if(!['pending','running','stopping','stopped','shutting-down','terminated'].includes(state)||!validIso(observedAt)||(stateChangedAt!==undefined&&stateChangedAt!==null&&!validIso(stateChangedAt)))throw new Error('Invalid verified resource observation');
    const age=this.now()-Date.parse(observedAt);
    if(age< -MAX_FUTURE_OBSERVATION_SKEW_MS||age>MAX_ACTION_OBSERVATION_AGE_MS)return false;
    const record=this.resolveAlias(resourceId);
    if(!record||record.provider!=='aws'||record.resourceType!=='ec2-instance'||!this.isResourceReferenceActive(`catalog:${record.catalogId}`))return false;
    return this.store.atomic(()=>{
      const current=this.store.db.prepare('SELECT state,lifecycle,last_seen,state_changed_at FROM catalog_resources WHERE id=?').get(record.catalogId) as {state:string;lifecycle:CatalogResourceRecord['lifecycle'];last_seen:string|null;state_changed_at:string|null}|undefined;
      if(!current||current.last_seen&&Date.parse(current.last_seen)>=Date.parse(observedAt))return false;
      const stateChanged=current.state!==state;
      const nextStateChangedAt=stateChanged?stateChangedAt??null:current.state_changed_at;
      this.store.db.prepare(`UPDATE catalog_resources SET state=?,last_seen=?,state_changed_at=?,lifecycle='active',missing_since=NULL,missing_scans=0 WHERE id=?`)
        .run(state,observedAt,nextStateChangedAt,record.catalogId);
      this.store.expectations.observe(`catalog:${record.catalogId}`,state,observedAt);
      if(stateChanged||current.lifecycle!=='active')this.store.appendEvent('resource',`catalog:${record.catalogId}`,{
        catalogId:record.catalogId,provider:'aws',accountId:record.accountId,region:record.region,providerId:record.providerId,
        name:record.name,state,stateChangedAt:nextStateChangedAt,lifecycle:'active',observedAt,reason:'operation_verified'
      });
      return true;
    });
  }

  listProjects(): Array<{ id: string; name: string; environments: string[]; source: string }> {
    const projects = this.store.db.prepare('SELECT id,name,source FROM catalog_projects ORDER BY name').all() as Array<{ id: string; name: string; source: string }>;
    const environments = this.store.db.prepare('SELECT project_id,environment FROM catalog_project_environments ORDER BY environment').all() as Array<{ project_id: string; environment: string }>;
    return projects.map(project => ({ id: project.id, name: project.name, source: project.source, environments: environments.filter(item => item.project_id === project.id).map(item => item.environment) }));
  }

  mergeInventory(providerResources: Resource[], legacyActionAliases: ReadonlySet<string> = new Set()): Resource[] {
    const connections = this.connections();
    const active = new Set(connections.filter(connection => connection.state === 'active').map(connection => connection.id));
    const byId = new Map(providerResources.filter(resource => this.isResourceReferenceActive(resource.id)
      && (!resource.catalog || !connections.some(connection => connection.provider === resource.catalog!.provider && connection.providerAccountId === resource.catalog!.accountId && connection.state !== 'active'))).map(resource => [resource.id, resource]));
    const records = this.listResources({ includeRetired: true });
    const hiddenAliases = new Set(records.filter(item => item.lifecycle === 'retired' || !active.has(item.connectionId)).flatMap(item => [...item.aliases, `catalog:${item.catalogId}`]));
    for (const alias of hiddenAliases) byId.delete(alias);
    for (const record of records.filter(item => item.lifecycle !== 'retired' && active.has(item.connectionId))) {
      const known = record.aliases.map(alias => byId.get(alias)).find((value): value is Resource => Boolean(value));
      const projected = this.asResource(record, legacyActionAliases);
      if (!known) { byId.set(projected.id, projected); continue; }
      const hasObservation = record.observedAt !== null;
      byId.set(known.id, {
        ...known,
        ...(hasObservation ? { name: record.name, state: record.state, detail: record.detail, location: record.region, observedAt: record.observedAt, stateChangedAt: record.stateChangedAt, actions: projected.actions, actionAvailability: projected.actionAvailability } : {}),
        catalog: projected.catalog,
        ...(hasObservation ? { health: { ...known.health, ...projected.health }, coverage: projected.coverage } : {}),
        ...(record.lifecycle === 'candidate_missing' ? { note: projected.note } : {})
      });
    }
    return [...byId.values()];
  }

  asResource(record: CatalogResourceRecord, legacyActionAliases: ReadonlySet<string> = new Set()): Resource {
    if (record.provider === 'host') {
      const scope = this.listScopes().find(item => item.connectionId === record.connectionId && item.scopeKey === record.scopeKey);
      const active = this.connections().some(item => item.id === record.connectionId && item.state === 'active');
      return projectHostCatalogResource(record, scope, active, this.now());
    }
    const id = record.aliases[0] ?? `catalog:${record.catalogId}`;
    const catalog: CatalogIdentity = {
      catalogId: record.catalogId, provider: record.provider, accountId: record.accountId, region: record.region,
      resourceType: record.resourceType, providerId: record.providerId, lifecycle: record.lifecycle,
      ...(record.projectId ? { projectId: record.projectId } : {}), ...(record.project ? { project: record.project } : {}),
      ...(record.environment ? { environment: record.environment } : {})
    };
    const note = record.lifecycle === 'candidate_missing'
      ? 'No apareció en un snapshot completo. Se conserva mientras se confirma la ausencia.'
      : record.lifecycle === 'retired'
        ? 'Ausencia confirmada en snapshots completos. El historial se conserva.'
        : record.aliases.length ? undefined : 'Recurso descubierto automáticamente. Las operaciones requieren permiso explícito.';
    const connectionActive = this.connections().some(connection => connection.id === record.connectionId && connection.state === 'active');
    const legacyAllowed = connectionActive && record.provider === 'aws' && record.aliases.some(alias => legacyActionAliases.has(alias));
    const scope = this.store.db.prepare('SELECT state,last_success_at AS lastSuccessAt,last_attempt_at AS lastAttemptAt FROM catalog_scopes WHERE connection_id=? AND scope_key=?').get(record.connectionId, record.scopeKey) as { state: CatalogScopeRecord['state']; lastSuccessAt: string | null; lastAttemptAt: string } | undefined;
    const fresh = (value: string | null): boolean => {
      if (!validIso(value)) return false;
      const age = this.now() - Date.parse(value);
      return age >= -MAX_FUTURE_OBSERVATION_SKEW_MS && age <= MAX_ACTION_OBSERVATION_AGE_MS;
    };
    const observationFresh = fresh(record.observedAt);
    const scopeFresh = connectionActive && scope?.state === 'healthy' && fresh(scope.lastSuccessAt);
    const scopeUsable = record.lifecycle === 'active' && scopeFresh;
    const reason = (expectedState: string): string => {
      if (!connectionActive) return 'connection_suspended';
      if (!legacyAllowed) return 'not_in_legacy_allowlist';
      if (record.lifecycle !== 'active') return 'resource_not_active';
      if (!scopeUsable) return 'scope_unavailable';
      if (!observationFresh) return 'observation_stale';
      if (record.state !== expectedState) return 'state_mismatch';
      return 'available';
    };
    const stopReason = reason('running'), startReason = reason('stopped');
    const actionAvailability: NonNullable<Resource['actionAvailability']> = {
      stop: { allowed: stopReason === 'available', reasonCode: stopReason, observedAt: record.observedAt },
      start: { allowed: startReason === 'available', reasonCode: startReason, observedAt: record.observedAt },
      refresh: { allowed: legacyAllowed, reasonCode: !connectionActive ? 'connection_suspended' : legacyAllowed ? 'available' : 'not_in_legacy_allowlist', observedAt: record.observedAt }
    };
    const actions: Resource['actions'] = legacyAllowed ? ['refresh'] : [];
    if (stopReason === 'available') actions.unshift('stop');
    if (startReason === 'available') actions.unshift('start');
    return { id, name: record.name, kind: record.provider === 'aws' && record.resourceType === 'ec2-instance' ? 'ec2' : 'service', state: record.state,
      location: record.region, account: record.accountName, detail: record.detail, actions, observedAt: record.observedAt,
      stateChangedAt: record.stateChangedAt, catalog, actionAvailability,
      coverage: { state: connectionActive ? scope?.state ?? 'unknown' : 'unknown', observedAt: scope?.lastAttemptAt ?? null, freshUntil: connectionActive && scope?.lastSuccessAt ? new Date(Date.parse(scope.lastSuccessAt) + (record.provider === 'aws' ? MAX_ACTION_OBSERVATION_AGE_MS : 240_000)).toISOString() : null },
      health: { presence: { state: !connectionActive || !record.observedAt ? 'unknown' : this.now() >= Date.parse(record.observedAt) - MAX_FUTURE_OBSERVATION_SKEW_MS && this.now() - Date.parse(record.observedAt) <= (record.provider === 'aws' ? MAX_ACTION_OBSERVATION_AGE_MS : 240_000) ? 'fresh' : 'stale', source: `${record.provider}-catalog`, observedAt: record.observedAt, freshUntil: connectionActive && record.observedAt ? new Date(Date.parse(record.observedAt) + (record.provider === 'aws' ? MAX_ACTION_OBSERVATION_AGE_MS : 240_000)).toISOString() : null } },
      ...(note ? { note } : {}) };
  }

  private validateSnapshot(snapshot: CatalogSnapshot, scopeObservedAt: string | null): CatalogSnapshot {
    const safe: CatalogSnapshot = {
      providerId: clean(snapshot.providerId, 200, 'provider resource ID'), resourceType: clean(snapshot.resourceType, 100, 'resource type'),
      region: clean(snapshot.region, 100, 'resource region'), name: clean(snapshot.name || snapshot.providerId, 200, 'resource name'),
      state: clean(snapshot.state, 80, 'resource state'), detail: clean(snapshot.detail || 'Sin detalle del proveedor', 240, 'resource detail'),
      observedAt: snapshot.observedAt ?? null,
      stateChangedAt: snapshot.stateChangedAt ?? null,
      tags: this.safeTags(snapshot.tags), aliases: snapshot.aliases?.map(alias => clean(alias, 200, 'resource alias')) ?? []
    };
    if (safe.observedAt !== null && !validIso(safe.observedAt)) throw new Error('Invalid resource observedAt');
    if (scopeObservedAt && safe.observedAt && Date.parse(safe.observedAt) > Date.parse(scopeObservedAt) + 300_000) throw new Error('Future resource observation');
    if (safe.stateChangedAt !== null && !validIso(safe.stateChangedAt)) throw new Error('Invalid stateChangedAt');
    return safe;
  }

  private safeTags(tags?: Record<string, string>): Record<string, string> {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {};
    const safe: Record<string, string> = {};
    for (const key of SAFE_TAGS) {
      const value = tags[key];
      if (typeof value === 'string' && value.trim() && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value)) safe[key] = value.trim();
    }
    return safe;
  }

  private addAliases(resourceId: string, aliases: string[]): void {
    const now = new Date().toISOString();
    for (const aliasValue of aliases) {
      const alias = clean(aliasValue, 200, 'resource alias');
      const existing = this.store.db.prepare('SELECT resource_id FROM catalog_resource_aliases WHERE alias=?').get(alias) as { resource_id: string } | undefined;
      if (existing && existing.resource_id !== resourceId) throw new Error('Resource alias already assigned');
      const inserted=this.store.db.prepare('INSERT OR IGNORE INTO catalog_resource_aliases(alias,resource_id,created_at) VALUES (?,?,?)').run(alias,resourceId,now);
      if(Number(inserted.changes)>0)this.store.operational.identityLearned(alias,resourceId);
      this.store.db.prepare('UPDATE catalog_service_resources SET resource_id=? WHERE resource_ref=? AND resource_id IS NULL').run(resourceId,alias);
    }
  }

  configureServices(definitions:ServiceDefinition[]):void {
    const now=new Date(this.now()).toISOString(),source='service-config';
    const keys=new Set<string>();
    for(const definition of definitions){
      const key=clean(definition.key,80,'service key').toLocaleLowerCase();
      if(keys.has(key))throw new Error('Duplicate service key');keys.add(key);
      clean(definition.name,160,'service name');
      if(Boolean(definition.projectKey)!==Boolean(definition.projectName))throw new Error('Project key and name must be configured together');
      const relationKeys=new Set<string>();
      for(const relation of definition.relations){
        clean(relation.resourceId,220,'service resource reference');
        const relationKey=`${relation.relationType}:${relation.resourceId}`;
        if(relationKeys.has(relationKey))throw new Error('Duplicate service relation');relationKeys.add(relationKey);
        if(!['hosted_on','depends_on'].includes(relation.relationType)||!['operator_confirmed','provider_metadata'].includes(relation.evidence))throw new Error('Invalid service relation');
      }
    }
    this.store.atomic(()=>{
    const serviceIds=new Map<string,string>();
      for(const definition of definitions){
        let projectId:string|null=null;
        if(definition.projectKey&&definition.projectName){
          const projectKey=clean(definition.projectKey,80,'project key').toLocaleLowerCase(),projectName=clean(definition.projectName,160,'project name');
          const existing=this.store.db.prepare("SELECT id FROM catalog_projects WHERE source=? AND external_key=?").get(source,projectKey) as {id:string}|undefined;
          projectId=existing?.id??randomUUID();
          this.store.db.prepare(`INSERT INTO catalog_projects(id,source,external_key,name,created_at,updated_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(source,external_key) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).run(projectId,source,projectKey,projectName,now,now);
          if(definition.environment){
            const environment=clean(definition.environment,80,'service environment'),environmentKey=environment.normalize('NFKC').toLocaleLowerCase();
            this.store.db.prepare('INSERT INTO catalog_project_environments(project_id,environment_key,environment,created_at) VALUES (?,?,?,?) ON CONFLICT(project_id,environment_key) DO UPDATE SET environment=excluded.environment').run(projectId,environmentKey,environment,now);
          }
        }
        const key=definition.key.toLocaleLowerCase();
        const existing=this.store.db.prepare('SELECT id FROM catalog_services WHERE source=? AND external_key=?').get(source,key) as {id:string}|undefined;
        const serviceId=existing?.id??randomUUID();
        this.store.db.prepare(`INSERT INTO catalog_services(id,source,external_key,name,project_id,environment,criticality,active,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,1,?,?) ON CONFLICT(source,external_key) DO UPDATE SET name=excluded.name,project_id=excluded.project_id,
          environment=excluded.environment,criticality=excluded.criticality,active=1,updated_at=excluded.updated_at`).run(serviceId,source,key,definition.name,projectId,definition.environment??null,definition.criticality,now,now);
        serviceIds.set(key,serviceId);
        this.store.db.prepare('UPDATE catalog_service_resources SET active=0,last_seen=? WHERE service_id=? AND active=1').run(now,serviceId);
        for(const relation of definition.relations){
          const ref=clean(relation.resourceId,220,'service resource reference');
          const resourceId=this.resolveResourceRef(ref);
          this.store.db.prepare(`INSERT INTO catalog_service_resources(service_id,resource_ref,resource_id,relation_type,evidence,active,first_seen,last_seen)
            VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(service_id,resource_ref,relation_type) DO UPDATE SET resource_id=excluded.resource_id,
            evidence=excluded.evidence,active=1,last_seen=excluded.last_seen`).run(serviceId,ref,resourceId,relation.relationType,relation.evidence,now,now);
        }
      }
      const configured=[...serviceIds.values()];
      if(configured.length){
        this.store.db.prepare(`UPDATE catalog_services SET active=0,updated_at=? WHERE source=? AND id NOT IN (${configured.map(()=>'?').join(',')})`).run(now,source,...configured);
      }else this.store.db.prepare('UPDATE catalog_services SET active=0,updated_at=? WHERE source=?').run(now,source);
      this.store.db.prepare("UPDATE catalog_service_resources SET active=0,last_seen=? WHERE service_id IN (SELECT id FROM catalog_services WHERE source=? AND active=0) AND active=1").run(now,source);
    });
  }

  private resolveResourceRef(resourceRef:string):string|null {
    if(resourceRef.startsWith('catalog:')){
      const row=this.store.db.prepare('SELECT id FROM catalog_resources WHERE id=?').get(resourceRef.slice('catalog:'.length)) as {id:string}|undefined;
      return row?.id??null;
    }
    const row=this.store.db.prepare('SELECT resource_id AS id FROM catalog_resource_aliases WHERE alias=?').get(resourceRef) as {id:string}|undefined;
    return row?.id??null;
  }

  listServices(includeInactive=false):CatalogServiceRecord[] {
    const services=this.store.db.prepare(`SELECT s.id,s.external_key AS key,s.name,s.project_id AS projectId,p.name AS project,s.environment,s.criticality,s.source,s.active
      FROM catalog_services s LEFT JOIN catalog_projects p ON p.id=s.project_id ${includeInactive?'':'WHERE s.active=1'} ORDER BY s.name,s.external_key`).all() as Array<{
        id:string;key:string;name:string;projectId:string|null;project:string|null;environment:string|null;
        criticality:CatalogServiceRecord['criticality'];source:string;active:number
      }>;
    return services.map(service=>{
      const relations=this.store.db.prepare(`SELECT sr.resource_ref AS resourceAlias,sr.resource_id AS resourceId,sr.relation_type AS relationType,sr.evidence,sr.active,sr.first_seen AS firstSeen,sr.last_seen AS lastSeen,
        r.name AS resourceName,r.provider,r.account_id AS accountId,r.region,r.state,r.lifecycle
        FROM catalog_service_resources sr LEFT JOIN catalog_resources r ON r.id=sr.resource_id LEFT JOIN provider_connections c ON c.id=r.connection_id WHERE sr.service_id=? ${includeInactive ? '' : "AND (r.id IS NULL OR c.state='active')"} ORDER BY sr.first_seen,sr.resource_ref`).all(service.id) as Array<{
          resourceAlias:string;resourceId:string|null;relationType:'hosted_on'|'depends_on';evidence:'operator_confirmed'|'provider_metadata';active:number;firstSeen:string;lastSeen:string;
          resourceName:string|null;provider:CatalogProvider|null;accountId:string|null;region:string|null;state:string|null;lifecycle:CatalogResourceRecord['lifecycle']|null
        }>;
      return {...service,active:Boolean(service.active),relations:relations.filter(relation=>includeInactive||this.isResourceReferenceActive(relation.resourceAlias)).map(relation=>({
        resourceAlias:relation.resourceAlias,resourceId:relation.resourceId,resolved:Boolean(relation.resourceId),relationType:relation.relationType,
        evidence:relation.evidence,active:Boolean(relation.active),firstSeen:relation.firstSeen,lastSeen:relation.lastSeen,
        ...(relation.resourceId&&relation.resourceName&&relation.provider&&relation.accountId&&relation.region&&relation.state&&relation.lifecycle?{
          resource:{catalogId:relation.resourceId,name:relation.resourceName,provider:relation.provider,accountId:relation.accountId,region:relation.region,state:relation.state,lifecycle:relation.lifecycle}
        }:{})
      }))};
    });
  }

  private projectFor(snapshot: CatalogSnapshot, provider: CatalogProvider, observedAt: string): { projectId: string | null; project: string | null; environment: string | null } {
    if (provider === 'host') return { projectId: null, project: null, environment: null };
    const tags = this.safeTags(snapshot.tags), name = tags.Project ?? null, environment = tags.Environment ?? null;
    if (!name) return { projectId: null, project: null, environment };
    const source = provider === 'aws' ? 'aws-tag' : 'coolify-project';
    const externalKey = name.normalize('NFKC').toLowerCase();
    const existing = this.store.db.prepare('SELECT id FROM catalog_projects WHERE source=? AND external_key=?').get(source, externalKey) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.store.db.prepare(`INSERT INTO catalog_projects(id,source,external_key,name,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(source,external_key) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).run(id, source, externalKey, name, observedAt, observedAt);
    if (environment) {
      const key = environment.normalize('NFKC').toLowerCase();
      this.store.db.prepare('INSERT OR IGNORE INTO catalog_project_environments(project_id,environment_key,environment,created_at) VALUES (?,?,?,?)').run(id, key, environment, observedAt);
    }
    return { projectId: id, project: name, environment };
  }

  private updateProjectLink(resourceId: string, projectId: string | null, observedAt: string): void {
    const current = this.store.db.prepare('SELECT project_id FROM catalog_resource_projects WHERE resource_id=? AND active=1').get(resourceId) as { project_id: string } | undefined;
    if (current?.project_id === projectId) {
      if (projectId) this.store.db.prepare('UPDATE catalog_resource_projects SET last_seen=? WHERE resource_id=? AND project_id=? AND active=1').run(observedAt, resourceId, projectId);
      return;
    }
    if (current) this.store.db.prepare('UPDATE catalog_resource_projects SET active=0,last_seen=? WHERE resource_id=? AND active=1').run(observedAt, resourceId);
    if (projectId) this.store.db.prepare('INSERT INTO catalog_resource_projects(resource_id,project_id,first_seen,last_seen,active) VALUES (?,?,?,?,1)').run(resourceId, projectId, observedAt, observedAt);
  }

  private upsertResource(connectionId: string, provider: CatalogProvider, accountId: string, scopeKey: string, snapshot: CatalogSnapshot): boolean {
    const identity = identityOf(provider, accountId, snapshot);
    const current = this.store.db.prepare('SELECT id,name,state,detail,tags,lifecycle,project_id,environment,state_changed_at,last_seen FROM catalog_resources WHERE provider_identity=?').get(identity) as { id: string; name: string; state: string; detail: string; tags: string; lifecycle: CatalogResourceRecord['lifecycle']; project_id: string | null; environment: string | null; state_changed_at: string | null; last_seen: string | null } | undefined;
    const observedAt = snapshot.observedAt ?? new Date().toISOString();
    if (current?.last_seen && Date.parse(observedAt) <= Date.parse(current.last_seen)) {
      this.addAliases(current.id, snapshot.aliases ?? []);
      return false;
    }
    const tags = this.safeTags(snapshot.tags), serializedTags = JSON.stringify(tags), project = this.projectFor({ ...snapshot, tags }, provider, observedAt);
    const id = current?.id ?? randomUUID();
    const stateChangedAt = current
      ? current.state === snapshot.state ? current.state_changed_at ?? snapshot.stateChangedAt ?? null : snapshot.stateChangedAt ?? null
      : snapshot.stateChangedAt ?? null;
    const changed = !current || current.name !== snapshot.name || current.state !== snapshot.state || current.detail !== snapshot.detail || current.tags !== serializedTags || current.lifecycle !== 'active' || current.project_id !== project.projectId || current.environment !== project.environment;
    if (current) {
      this.store.db.prepare(`UPDATE catalog_resources SET connection_id=?,account_id=?,scope_key=?,region=?,resource_type=?,provider_id=?,name=?,state=?,detail=?,tags=?,lifecycle='active',
        first_seen=COALESCE(first_seen,?),last_seen=?,state_changed_at=?,missing_since=NULL,missing_scans=0,project_id=?,environment=? WHERE id=?`).run(connectionId, accountId, scopeKey, snapshot.region, snapshot.resourceType, snapshot.providerId, snapshot.name, snapshot.state, snapshot.detail, serializedTags, observedAt, observedAt, stateChangedAt, project.projectId, project.environment, id);
    } else {
      this.store.db.prepare(`INSERT INTO catalog_resources(id,provider_identity,provider,connection_id,account_id,scope_key,region,resource_type,provider_id,name,state,detail,tags,lifecycle,first_seen,last_seen,state_changed_at,missing_since,missing_scans,project_id,environment)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,NULL,0,?,?)`).run(id, identity, provider, connectionId, accountId, scopeKey, snapshot.region, snapshot.resourceType, snapshot.providerId, snapshot.name, snapshot.state, snapshot.detail, serializedTags, observedAt, observedAt, stateChangedAt, project.projectId, project.environment);
    }
    this.addAliases(id, snapshot.aliases ?? []);
    this.store.expectations.observe(`catalog:${id}`, snapshot.state, observedAt);
    this.updateProjectLink(id, project.projectId, observedAt);
    if (changed) this.store.appendEvent('resource', `catalog:${id}`, {
      catalogId: id, provider, accountId, region: snapshot.region, resourceType: snapshot.resourceType, providerId: snapshot.providerId,
      name: snapshot.name, state: snapshot.state, stateChangedAt, lifecycle: 'active', project: project.project, environment: project.environment, observedAt
    });
    return changed;
  }
}
