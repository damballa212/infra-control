import type { Store } from './store.js';
import type { Operation } from './types.js';

/** Tolerancia de ejecución/estabilización, nunca una obligación permanente de disponibilidad. */
const TRANSITION_MS = 10 * 60_000;
const PREFIX = 'host-intent-v1:';
type Intent = {
  operationId: string; resourceId: string; target: 'running' | 'stopped';
  requestedAt: string; phase: 'transition' | 'stabilizing' | 'stopped';
  expiresAt: string | null; confirmedAt?: string; lastEvidenceAt?: string;
};
export type ExpectationContext = { expected: boolean; reasonCode?: 'expected_ec2_transition' | 'intended_host_stop'; expiresAt: string | null };

export class ExpectationLedger {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS expected_transition_evidence (
      resource_key TEXT NOT NULL, state TEXT NOT NULL, observed_at INTEGER NOT NULL, operation_id TEXT NOT NULL,
      PRIMARY KEY(resource_key,state,observed_at),
      FOREIGN KEY(operation_id) REFERENCES operations(id) ON DELETE CASCADE);`);
  }

  private rememberEvidence(resourceId: string, state: string, observedAt: string, operationId: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO expected_transition_evidence(resource_key,state,observed_at,operation_id) VALUES (?,?,?,?)')
      .run(this.key(resourceId).slice(PREFIX.length), state, Date.parse(observedAt), operationId);
  }

  /** Clasificación de esa evidencia exacta; no es una ventana de gracia ni confirma una operación. */
  wasExpectedEvidence(resourceId: string, state: string, observedAt: string): boolean {
    const at = Date.parse(observedAt);
    if (!Number.isFinite(at)) return false;
    const identity = this.key(resourceId).slice(PREFIX.length);
    return Boolean(this.store.db.prepare(`SELECT 1 FROM expected_transition_evidence
      WHERE state=? AND observed_at=? AND (resource_key=? OR resource_key IN (
        SELECT alias FROM catalog_resource_aliases WHERE 'catalog:'||resource_id=?)) LIMIT 1`).get(state, at, identity, identity));
  }

  private key(resourceId: string): string {
    const row = resourceId.startsWith('catalog:')
      ? this.store.db.prepare('SELECT id FROM catalog_resources WHERE id=?').get(resourceId.slice('catalog:'.length)) as { id: string } | undefined
      : this.store.db.prepare('SELECT resource_id AS id FROM catalog_resource_aliases WHERE alias=?').get(resourceId) as { id: string } | undefined;
    return PREFIX + (row ? `catalog:${row.id}` : resourceId);
  }

  private read(resourceId: string): Intent | undefined {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key(resourceId)) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as Intent;
      return value.operationId && Number.isFinite(Date.parse(value.requestedAt)) && ['transition', 'stabilizing', 'stopped'].includes(value.phase) && ['running', 'stopped'].includes(value.target) ? value : undefined;
    } catch { return undefined; }
  }

  private write(intent: Intent): void {
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(this.key(intent.resourceId), JSON.stringify(intent));
  }

  private discard(intent: Intent, at: string): void {
    this.store.db.prepare('UPDATE expected_transitions SET cancelled_at=? WHERE operation_id=? AND consumed_at IS NULL AND cancelled_at IS NULL').run(at, intent.operationId);
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run(this.key(intent.resourceId));
  }

  begin(operation: Operation): void {
    if (operation.action === 'refresh') return;
    const previous = this.read(operation.resourceId);
    if (previous) this.discard(previous, operation.createdAt);
    if (operation.action !== 'start' && operation.action !== 'stop') return;
    const expiresAt = new Date(Date.parse(operation.createdAt) + TRANSITION_MS).toISOString();
    this.store.db.prepare('UPDATE expected_transitions SET expires_at=? WHERE operation_id=?').run(expiresAt, operation.id);
    this.write({ operationId: operation.id, resourceId: operation.resourceId, target: operation.action === 'start' ? 'running' : 'stopped', requestedAt: operation.createdAt, phase: 'transition', expiresAt });
  }

  cancel(operationId: string): void {
    const operation = this.store.get(operationId);
    const current = operation && this.read(operation.resourceId);
    if (current?.operationId === operationId) this.discard(current, operation!.updatedAt);
  }

  confirm(operationId: string, observedAt: string): boolean {
    return this.store.atomic(() => {
      const operation = this.store.get(operationId);
      const current = operation && this.read(operation.resourceId);
      if (!current || current.operationId !== operationId || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < Date.parse(current.requestedAt)) return false;
      if (current.confirmedAt) return true;
      this.store.db.prepare('UPDATE expected_transitions SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL AND cancelled_at IS NULL').run(observedAt, operationId);
      this.write({ ...current, phase: current.target === 'stopped' ? 'stopped' : 'stabilizing', confirmedAt: observedAt, lastEvidenceAt: observedAt, expiresAt: current.target === 'stopped' ? null : new Date(Date.parse(observedAt) + TRANSITION_MS).toISOString() });
      return true;
    });
  }

  pending(resourceId: string, target: string, observedAt: string): boolean {
    const current = this.read(resourceId), at = Date.parse(observedAt);
    if (!current || current.phase !== 'transition' || current.target !== target || !Number.isFinite(at) || at < Date.parse(current.requestedAt) || !current.expiresAt || at >= Date.parse(current.expiresAt)) return false;
    return Boolean(this.store.db.prepare('SELECT 1 FROM expected_transitions WHERE operation_id=? AND consumed_at IS NULL AND cancelled_at IS NULL').get(current.operationId));
  }

  consume(resourceId: string, target: string, observedAt: string): boolean {
    return this.store.atomic(() => {
      if (!this.pending(resourceId, target, observedAt)) return false;
      const operationId = this.read(resourceId)!.operationId;
      if (!this.confirm(operationId, observedAt)) return false;
      this.rememberEvidence(resourceId, target, observedAt, operationId);
      return true;
    });
  }

  /** Solo se invoca después de aceptar evidencia ordenada del recurso. No altera resultados de operaciones. */
  observe(resourceId: string, state: string, observedAt: string): void {
    if (!['pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated'].includes(state)) return;
    this.store.atomic(() => {
      const current = this.read(resourceId), at = Date.parse(observedAt);
      if (!current || !Number.isFinite(at) || at < Date.parse(current.requestedAt) || current.lastEvidenceAt && at <= Date.parse(current.lastEvidenceAt)) return;
      if (current.phase !== 'transition') {
        if (state !== current.target) this.discard(current, observedAt);
        else this.write({ ...current, lastEvidenceAt: observedAt });
        return;
      }
      if (!current.expiresAt || at >= Date.parse(current.expiresAt)) { this.discard(current, observedAt); return; }
      if (state === current.target) {
        if (this.pending(resourceId, state, observedAt) && this.confirm(current.operationId, observedAt)) this.rememberEvidence(resourceId, state, observedAt, current.operationId);
        return;
      }
      const operation = this.store.get(current.operationId);
      if (!operation || ['failed', 'uncertain', 'succeeded'].includes(operation.state) && at > Date.parse(operation.updatedAt)) this.discard(current, observedAt);
      else {
        const target = state === 'pending' ? 'running' : state === 'stopping' ? 'stopped' : undefined;
        if (target && this.pending(resourceId, target, observedAt)) this.rememberEvidence(resourceId, state, observedAt, current.operationId);
        this.write({ ...current, lastEvidenceAt: observedAt });
      }
    });
  }

  healthy(resourceId: string, observedAt: string): void {
    this.store.atomic(() => {
      const current = this.read(resourceId), at = Date.parse(observedAt);
      if (!current || !Number.isFinite(at) || at <= Date.parse(current.requestedAt)) return;
      if (current.target === 'running') {
        this.store.db.prepare('UPDATE expected_transitions SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL AND cancelled_at IS NULL').run(observedAt, current.operationId);
        this.store.db.prepare('DELETE FROM settings WHERE key=?').run(this.key(resourceId));
      } else if (current.phase === 'stopped' && current.confirmedAt && at > Date.parse(current.confirmedAt)) this.discard(current, observedAt);
    });
  }

  context(resourceIds: readonly string[], now = Date.now()): ExpectationContext {
    const current = resourceIds.flatMap(id => { const intent = this.read(id); return intent ? [intent] : []; }).sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))[0];
    if (!current) return { expected: false, expiresAt: null };
    if (current.phase === 'stopped') return { expected: true, reasonCode: 'intended_host_stop', expiresAt: null };
    if (!current.expiresAt || now >= Date.parse(current.expiresAt)) return { expected: false, expiresAt: null };
    return { expected: true, reasonCode: 'expected_ec2_transition', expiresAt: current.expiresAt };
  }

  effects(): Array<{ resourceId: string; target: 'running' | 'stopped'; confirmedAt: string }> {
    const rows = this.store.db.prepare('SELECT value FROM settings WHERE key LIKE ?').all(`${PREFIX}%`) as Array<{ value: string }>;
    return rows.flatMap(row => {
      try { const value = JSON.parse(row.value) as Intent; return value.confirmedAt && Number.isFinite(Date.parse(value.confirmedAt)) ? [{ resourceId: value.resourceId, target: value.target, confirmedAt: value.confirmedAt }] : []; }
      catch { return []; }
    });
  }
}
