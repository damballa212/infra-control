import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { VaultAdapter } from './secrets-vault.js';
import { SecretsPages } from './secrets-pagination.js';
import type { PageQuery } from './pagination.js';

/**
 * Solicitudes de secretos de agentes: un agente pide, una persona decide, el agente reclama una sola vez.
 * El panel nunca persiste valores: viven en la bóveda y solo transitan en memoria durante pegar/entregar.
 */
/**
 * `projects: ['*']` permite pedir para cualquier proyecto.
 * `autoDeliver`: si la bóveda ya guarda un único ítem con ese nombre en la colección del proyecto, la solicitud se aprueba
 * sola (sin esperar a Admin) para una única entrega. Sin `autoDeliver`, cada petición sin permiso permanente espera decisión humana.
 */
export type SecretsPolicy = { projects: string[]; names?: string[]; autoDeliver?: boolean };
/** Lo que un agente puede saber de la bóveda: nombres y fecha, nunca valores ni referencias internas. */
export type AvailableSecret = { name: string; updatedAt: string };
export type SecretDestination = { kind: 'dotenv'; path: string } | { kind: 'process' };
export type SecretScope = 'once' | 'machine_project' | 'always';
export type SecretRequestState = 'pending' | 'approved' | 'denied' | 'expired' | 'delivered' | 'failed';
export type SecretRequestInput = {
  name: string; project: string; environment?: string; machine: string; reason: string; destination: SecretDestination;
};
export type SecretRequest = {
  id: string; agent: string; machine: string; name: string; project: string; environment: string | null;
  destination: SecretDestination; reason: string; state: SecretRequestState; scope: SecretScope | null;
  createdAt: string; expiresAt: string; decidedAt: string | null; deliveredAt: string | null; auto: boolean;
};
export type SecretApproval = { mode: 'paste'; value: string } | { mode: 'existing'; itemRef: string };
export type SecretDelivery = { name: string; value: string; destination: SecretDestination };
export type SecretGrant = {
  id: string; agent: string; machine: string; project: string; environment: string | null; name: string;
  scope: Exclude<SecretScope, 'once'>; createdAt: string;
};
export type SecretAuditEvent = { id: number; at: string; requestId: string | null; event: string; actor: string };

export type SecretsErrorCode =
  | 'invalid_request' | 'forbidden_project' | 'forbidden_name' | 'idempotency_conflict' | 'not_found'
  | 'not_pending' | 'not_claimable' | 'invalid_value' | 'item_not_found' | 'vault_unavailable';
export type SecretsHooks = {
  /** Plazo de una solicitud pendiente. */
  pendingTtlMs?: number;
  /** Entrega automática (auto_found o permiso permanente) ya reclamada por el agente. Informativo; un fallo no la afecta. */
  onAutoDelivered?: (request: SecretRequest) => void;
  /** Solicitud que venció sin decidirse. Informativo. */
  onExpiredPending?: (request: SecretRequest) => void;
};
export class SecretsError extends Error {
  constructor(readonly code: SecretsErrorCode, message: string) { super(message); }
}

/** Plazo por defecto para que Admin decida; configurable (SECRETS_PENDING_HOURS). La recogida tras aprobar sigue en 10 min. */
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60_000;
const CLAIM_TTL_MS = 10 * 60_000;
const MAX_VALUE_BYTES = 8192;
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const ENV_FILE = /^\.env(\.[A-Za-z0-9_-]{1,32})?$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{1,100}$/;

type RequestRow = {
  id: string; agent: string; machine: string; name: string; project: string; environment: string | null;
  destination: string; reason: string; state: SecretRequestState; scope: SecretScope | null; item_ref: string | null;
  payload_hash: string; created_at: string; expires_at: string; decided_at: string | null; delivered_at: string | null; auto: number;
};
type GrantRow = {
  id: string; agent: string; machine: string; project: string; environment: string | null; name: string;
  scope: Exclude<SecretScope, 'once'>; item_ref: string; created_at: string; revoked_at: string | null;
};

const iso = (ms: number): string => new Date(ms).toISOString();
const collectionOf = (project: string, environment: string | null): string => `${project}/${environment ?? 'default'}`;

function validDestination(destination: SecretDestination): void {
  if (destination.kind === 'process') return;
  const { path } = destination;
  const parts = path.split('/');
  const safe = typeof path === 'string' && path.length > 0 && path.length <= 200 && !path.startsWith('/') &&
    parts.every(part => part !== '' && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f\\]/.test(part));
  if (!safe || !ENV_FILE.test(parts[parts.length - 1]!))
    throw new SecretsError('invalid_request', 'La ruta debe ser relativa al proyecto y terminar en un archivo .env.');
}

function validate(input: SecretRequestInput): void {
  if (!NAME.test(input.name)) throw new SecretsError('invalid_request', 'Nombre de variable no válido.');
  if (!SLUG.test(input.project)) throw new SecretsError('invalid_request', 'Proyecto no válido.');
  if (input.environment !== undefined && !SLUG.test(input.environment)) throw new SecretsError('invalid_request', 'Entorno no válido.');
  if (!MACHINE.test(input.machine)) throw new SecretsError('invalid_request', 'Equipo no válido.');
  if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 200 || /[\u0000-\u001f\u007f]/.test(input.reason))
    throw new SecretsError('invalid_request', 'El motivo debe tener entre 1 y 200 caracteres.');
  validDestination(input.destination);
}

export class SecretsService {
  private readonly pages:SecretsPages;
  constructor(
    private readonly store: Store, private readonly vault: VaultAdapter, private readonly now: () => number = Date.now,
    /** Se llama con cada solicitud nueva que espera a Admin (p. ej. para el aviso push). Un fallo aquí no afecta a la solicitud. */
    private readonly onPending?: (request: SecretRequest) => void,
    private readonly hooks: SecretsHooks = {}
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS secret_requests (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, machine TEXT NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL,
        environment TEXT, destination TEXT NOT NULL, reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired','delivered','failed')),
        scope TEXT, item_ref TEXT, idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, delivered_at TEXT, auto INTEGER NOT NULL DEFAULT 0,
        UNIQUE(agent, idem_key)
      );
      CREATE TABLE IF NOT EXISTS secret_grants (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, environment TEXT,
        name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('machine_project','always')), item_ref TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS secret_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, request_id TEXT, event TEXT NOT NULL, actor TEXT NOT NULL
      );
    `);
    this.pages=new SecretsPages(store,id=>this.get(id),this.now);
  }

  requestPage(query:PageQuery,context:string){return this.pages.requests(query,context);}
  grantPage(query:PageQuery,context:string){return this.pages.grants(query,context);}
  auditPage(query:PageQuery,context:string){return this.pages.audit(query,context);}
  requestCounts(){return this.pages.counts();}

  create(agent: string, policy: SecretsPolicy, input: SecretRequestInput, idempotencyKey: string): SecretRequest {
    const { request, isNew } = this.insert(agent, policy, input, idempotencyKey);
    if (isNew) this.notifyIfPending(request);
    return request;
  }

  /**
   * Crea la solicitud y, si la política del agente tiene `autoDeliver`, busca en la bóveda un ítem con ese nombre en la
   * colección del proyecto. Con una coincidencia única la aprueba sola para una entrega; si no hay, hay varias o la bóveda
   * falla, queda pendiente para Admin (y solo entonces se avisa). Nunca expone valores.
   */
  async request(agent: string, policy: SecretsPolicy, input: SecretRequestInput, idempotencyKey: string): Promise<SecretRequest> {
    const { request, isNew } = this.insert(agent, policy, input, idempotencyKey);
    let current = request;
    if (current.state === 'pending' && policy.autoDeliver) current = await this.resolveFromVault(current.id);
    if (isNew) this.notifyIfPending(current);
    return current;
  }

  /** Nombres disponibles en la colección de un proyecto dentro de la política del agente. Sin valores ni referencias. */
  async available(policy: SecretsPolicy, project: string, environment?: string): Promise<AvailableSecret[]> {
    if (!SLUG.test(project) || (environment !== undefined && !SLUG.test(environment))) throw new SecretsError('invalid_request', 'Proyecto o entorno no válido.');
    if (!policy.projects.includes('*') && !policy.projects.includes(project)) throw new SecretsError('forbidden_project', 'Este agente no puede consultar secretos de ese proyecto.');
    let items;
    try { items = await this.vault.list(collectionOf(project, environment ?? null)); }
    catch { throw new SecretsError('vault_unavailable', 'No se pudo leer la bóveda.'); }
    return items
      .filter(item => NAME.test(item.name) && (!policy.names || policy.names.includes(item.name)))
      .map(item => ({ name: item.name, updatedAt: item.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private insert(agent: string, policy: SecretsPolicy, input: SecretRequestInput, idempotencyKey: string): { request: SecretRequest; isNew: boolean } {
    if (!IDEMPOTENCY.test(idempotencyKey)) throw new SecretsError('invalid_request', 'Idempotency-Key no válida.');
    validate(input);
    if (!policy.projects.includes('*') && !policy.projects.includes(input.project)) throw new SecretsError('forbidden_project', 'Este agente no puede pedir secretos de ese proyecto.');
    if (policy.names && !policy.names.includes(input.name)) throw new SecretsError('forbidden_name', 'Este agente no puede pedir esa variable.');
    const environment = input.environment ?? null;
    const payloadHash = createHash('sha256').update(JSON.stringify([input.name, input.project, environment, input.machine, input.destination])).digest('hex');
    const existing = this.store.db.prepare('SELECT * FROM secret_requests WHERE agent=? AND idem_key=?').get(agent, idempotencyKey) as RequestRow | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new SecretsError('idempotency_conflict', 'Esa Idempotency-Key ya se usó con otra solicitud.');
      return { request: this.view(this.refresh(existing.id)!), isNew: false };
    }
    const id = randomUUID(), at = this.now();
    this.store.db.prepare(`INSERT INTO secret_requests (id,agent,machine,name,project,environment,destination,reason,state,idem_key,payload_hash,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?)`)
      .run(id, agent, input.machine, input.name, input.project, environment, JSON.stringify(input.destination), input.reason, idempotencyKey, payloadHash, iso(at), iso(at + (this.hooks.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS)));
    this.record(id, 'created', agent);
    const grant = this.matchingGrant(agent, input.machine, input.project, environment, input.name);
    if (grant) {
      this.store.db.prepare("UPDATE secret_requests SET state='approved',scope=?,item_ref=?,decided_at=?,expires_at=?,auto=1 WHERE id=?")
        .run(grant.scope, grant.item_ref, iso(at), iso(at + CLAIM_TTL_MS), id);
      this.record(id, 'auto_approved', 'Admin');
    }
    return { request: this.view(this.row(id)!), isNew: true };
  }

  private async resolveFromVault(id: string): Promise<SecretRequest> {
    const row = this.refresh(id);
    if (!row || row.state !== 'pending') return this.view(row!);
    let matches;
    try { matches = (await this.vault.list(collectionOf(row.project, row.environment))).filter(item => item.name === row.name); }
    catch { return this.view(this.refresh(id)!); }
    if (matches.length !== 1) return this.view(this.refresh(id)!);
    const at = this.now();
    const changed = this.store.db.prepare("UPDATE secret_requests SET state='approved',scope='once',item_ref=?,decided_at=?,expires_at=?,auto=1 WHERE id=? AND state='pending'")
      .run(matches[0]!.itemRef, iso(at), iso(at + CLAIM_TTL_MS), id).changes;
    if (changed === 1) this.record(id, 'auto_found', 'sistema');
    return this.view(this.row(id)!);
  }

  private notifyIfPending(request: SecretRequest): void {
    if (request.state !== 'pending') return;
    try { this.onPending?.(request); } catch { /* el aviso es accesorio; la solicitud ya existe */ }
  }

  get(id: string): SecretRequest | undefined {
    const row = this.refresh(id);
    return row ? this.view(row) : undefined;
  }

  list(): SecretRequest[] {
    const rows = this.store.db.prepare('SELECT id FROM secret_requests ORDER BY created_at DESC LIMIT 200').all() as { id: string }[];
    const views = rows.map(({ id }) => this.view(this.refresh(id)!));
    return [...views.filter(r => r.state === 'pending'), ...views.filter(r => r.state !== 'pending')];
  }

  async approve(id: string, approval: SecretApproval, scope: SecretScope, actor = 'Admin'): Promise<SecretRequest> {
    const row = this.refresh(id);
    if (!row) throw new SecretsError('not_found', 'Solicitud no encontrada.');
    if (row.state !== 'pending') throw new SecretsError('not_pending', 'La solicitud ya no está pendiente.');
    const collection = collectionOf(row.project, row.environment);
    let itemRef: string;
    if (approval.mode === 'paste') {
      const bytes = typeof approval.value === 'string' ? Buffer.byteLength(approval.value) : 0;
      if (bytes === 0 || bytes > MAX_VALUE_BYTES || /[\n\r\u0000]/.test(approval.value))
        throw new SecretsError('invalid_value', 'El valor debe ser una sola línea de hasta 8 KB.');
      try { itemRef = await this.vault.put({ collection, name: row.name }, approval.value); }
      catch { throw new SecretsError('vault_unavailable', 'No se pudo guardar en la bóveda.'); }
    } else {
      let items;
      try { items = await this.vault.list(collection); }
      catch { throw new SecretsError('vault_unavailable', 'No se pudo leer la bóveda.'); }
      if (!items.some(item => item.itemRef === approval.itemRef)) throw new SecretsError('item_not_found', 'Ese ítem no existe en la colección del proyecto.');
      itemRef = approval.itemRef;
    }
    const at = this.now();
    const changed = this.store.db.prepare("UPDATE secret_requests SET state='approved',scope=?,item_ref=?,decided_at=?,expires_at=? WHERE id=? AND state='pending'")
      .run(scope, itemRef, iso(at), iso(at + CLAIM_TTL_MS), id).changes;
    if (changed !== 1) throw new SecretsError('not_pending', 'La solicitud ya no está pendiente.');
    if (scope !== 'once')
      this.store.db.prepare('INSERT INTO secret_grants (id,agent,machine,project,environment,name,scope,item_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), row.agent, row.machine, row.project, row.environment, row.name, scope, itemRef, iso(at));
    this.record(id, 'approved', actor);
    return this.view(this.row(id)!);
  }

  deny(id: string, actor = 'Admin'): SecretRequest {
    const row = this.refresh(id);
    if (!row) throw new SecretsError('not_found', 'Solicitud no encontrada.');
    const changed = this.store.db.prepare("UPDATE secret_requests SET state='denied',decided_at=? WHERE id=? AND state='pending'").run(iso(this.now()), id).changes;
    if (changed !== 1) throw new SecretsError('not_pending', 'La solicitud ya no está pendiente.');
    this.record(id, 'denied', actor);
    return this.view(this.row(id)!);
  }

  /** Entrega el valor una sola vez al agente solicitante. La transición es atómica antes de leer la bóveda. */
  async claim(id: string, agent: string): Promise<SecretDelivery> {
    const row = this.refresh(id);
    if (!row || row.agent !== agent) throw new SecretsError('not_found', 'Solicitud no encontrada.');
    if (row.state !== 'approved' || !row.item_ref) throw new SecretsError('not_claimable', 'La solicitud no está lista para entregarse.');
    const changed = this.store.db.prepare("UPDATE secret_requests SET state='delivered',delivered_at=? WHERE id=? AND state='approved'").run(iso(this.now()), id).changes;
    if (changed !== 1) throw new SecretsError('not_claimable', 'La solicitud no está lista para entregarse.');
    let value: string;
    try { value = await this.vault.get(row.item_ref); }
    catch {
      this.store.db.prepare("UPDATE secret_requests SET state='failed' WHERE id=?").run(id);
      this.record(id, 'failed', agent);
      throw new SecretsError('vault_unavailable', 'La bóveda no entregó el valor. Pide la credencial de nuevo.');
    }
    this.record(id, 'delivered', agent);
    if (row.auto === 1) this.safely(() => this.hooks.onAutoDelivered?.(this.view(this.row(id)!)));
    return { name: row.name, value, destination: JSON.parse(row.destination) as SecretDestination };
  }

  grants(): SecretGrant[] {
    const rows = this.store.db.prepare('SELECT * FROM secret_grants WHERE revoked_at IS NULL ORDER BY created_at DESC').all() as GrantRow[];
    return rows.map(({ item_ref: _itemRef, revoked_at: _revoked, created_at, ...rest }) => ({ ...rest, createdAt: created_at }));
  }

  revokeGrant(id: string, actor = 'Admin'): boolean {
    const changed = this.store.db.prepare('UPDATE secret_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(iso(this.now()), id).changes;
    if (changed === 1) this.record(null, 'grant_revoked', actor);
    return changed === 1;
  }

  audit(limit = 200): SecretAuditEvent[] {
    const rows = this.store.db.prepare('SELECT id,at,request_id AS requestId,event,actor FROM secret_audit ORDER BY id DESC LIMIT ?').all(Math.max(1,Math.min(200,limit))) as SecretAuditEvent[];
    return rows;
  }

  private matchingGrant(agent: string, machine: string, project: string, environment: string | null, name: string): GrantRow | undefined {
    return this.store.db.prepare(`SELECT * FROM secret_grants WHERE revoked_at IS NULL AND agent=? AND project=? AND name=?
      AND COALESCE(environment,'')=COALESCE(?,'') AND (scope='always' OR (scope='machine_project' AND machine=?)) ORDER BY created_at DESC LIMIT 1`)
      .get(agent, project, name, environment, machine) as GrantRow | undefined;
  }

  private row(id: string): RequestRow | undefined {
    return this.store.db.prepare('SELECT * FROM secret_requests WHERE id=?').get(id) as RequestRow | undefined;
  }

  /** Vence de forma perezosa las solicitudes pendientes o aprobadas sin reclamar. */
  private refresh(id: string): RequestRow | undefined {
    const row = this.row(id);
    if (!row || (row.state !== 'pending' && row.state !== 'approved') || Date.parse(row.expires_at) > this.now()) return row;
    const changed = this.store.db.prepare("UPDATE secret_requests SET state='expired' WHERE id=? AND state IN ('pending','approved')").run(id).changes;
    if (changed === 1) {
      this.record(id, 'expired', 'sistema');
      if (row.state === 'pending') this.safely(() => this.hooks.onExpiredPending?.(this.view(this.row(id)!)));
    }
    return this.row(id);
  }

  /** Vence las pendientes cuyo plazo pasó aunque nadie las consulte, para que el aviso llegue a tiempo. */
  sweepExpired(): number {
    const rows = this.store.db.prepare("SELECT id FROM secret_requests WHERE state IN ('pending','approved') AND expires_at<=?").all(iso(this.now())) as { id: string }[];
    for (const { id } of rows) this.refresh(id);
    return rows.length;
  }

  private safely(task: () => void): void {
    try { task(); } catch { /* los avisos son accesorios */ }
  }

  private record(requestId: string | null, event: string, actor: string): void {
    this.store.db.prepare('INSERT INTO secret_audit (at,request_id,event,actor) VALUES (?,?,?,?)').run(iso(this.now()), requestId, event, actor);
  }

  private view(row: RequestRow): SecretRequest {
    return {
      id: row.id, agent: row.agent, machine: row.machine, name: row.name, project: row.project, environment: row.environment,
      destination: JSON.parse(row.destination) as SecretDestination, reason: row.reason, state: row.state, scope: row.scope,
      createdAt: row.created_at, expiresAt: row.expires_at, decidedAt: row.decided_at, deliveredAt: row.delivered_at, auto: row.auto === 1
    };
  }
}
