import { ActiveOperationError, DeploymentBlockedError, Store, type OperationPlanRecord } from './store.js';
import { UncertainError } from './operation-error.js';
import type { Action, AdapterOperationResult, Operation, Resource, OperationProgress } from './types.js';

export type OperationRequestResult =
  | { status: 'created' | 'replay'; operation: Operation }
  | { status: 'invalid'; reason: 'confirmation_required' | 'idempotency_key_required' }
  | { status: 'forbidden' }
  | { status: 'unavailable'; reason: 'resource_or_action_unavailable' }
  | { status: 'conflict'; reason: 'idempotency_conflict' | 'operation_active' }
  | { status: 'blocked'; reason: 'deployment_in_progress' };
export type OperationPlanResult =
  | { status: 'created' | 'existing'; plan: OperationPlanRecord }
  | { status: 'invalid'; reason: 'idempotency_key_required' }
  | { status: 'unavailable'; reason: 'resource_or_action_unavailable' | 'operation_not_permitted' }
  | { status: 'conflict'; reason: 'idempotency_conflict' };
export type OperationExecutionResult =
  | { status: 'created' | 'replay'; operation: Operation }
  | { status: 'not_found' | 'wrong_actor' | 'expired' | 'stale' | 'not_authorized' | 'active' | 'blocked' };
export type ResourceResolver = (requestedId: string, resources: Resource[]) => { resource?: Resource; canonicalId: string };
class OperationPreflightError extends Error {}
class PlanConsumptionError extends Error {
  constructor(readonly result: 'expired' | 'stale') { super(result); }
}

export class OperationService {
  constructor(
    private readonly store: Store,
    private readonly inventory: () => Promise<Resource[]>,
    private readonly resolver: ResourceResolver,
    private readonly perform: (resource: Resource, action: Action, progress: OperationProgress) => Promise<AdapterOperationResult>,
    private readonly closed: () => boolean,
    private readonly authorizeMcp: (actor: string, resource: Resource, action: Action) => boolean = () => false,
    private readonly policyVersion: (actor: string) => string = () => 'policy-v1',
    private readonly now: () => number = Date.now
  ) {}

  async submit(actor: string, idempotencyKey: string | undefined, resourceId: string, action: Action, confirmed: boolean): Promise<OperationRequestResult> {
    if (action !== 'refresh' && !confirmed) return { status: 'invalid', reason: 'confirmation_required' };
    if (!this.validKey(idempotencyKey)) return { status: 'invalid', reason: 'idempotency_key_required' };
    const resources = await this.inventory();
    const resolved = this.resolver(resourceId, resources);
    const resource = resolved.resource;
    const prior = this.store.existing(actor, idempotencyKey);
    if (prior) {
      if (this.matchesFingerprint(prior.fingerprint, action, resolved.canonicalId, resources)) {
        if (!resource || !this.authorizeMcp(actor, resource, action)) return { status: 'forbidden' };
        const operation = this.store.get(prior.id);
        if (operation) return { status: 'replay', operation };
      }
      return { status: 'conflict', reason: 'idempotency_conflict' };
    }
    if (!resource || !resource.actions.includes(action)) return { status: 'unavailable', reason: 'resource_or_action_unavailable' };
    if (!this.authorizeMcp(actor, resource, action)) return { status: 'forbidden' };
    const fingerprint = JSON.stringify({ resourceId: resolved.canonicalId, action });
    if (this.store.busy(resolved.canonicalId)) return { status: 'conflict', reason: 'operation_active' };
    try {
      const operation = this.store.create(actor, idempotencyKey, fingerprint, { ...resource, id: resolved.canonicalId }, action);
      this.start(operation, { ...resource, id: resolved.canonicalId }, action);
      return { status: 'created', operation };
    } catch (error) {
      if (error instanceof DeploymentBlockedError) return { status: 'blocked', reason: 'deployment_in_progress' };
      if (error instanceof ActiveOperationError) return { status: 'conflict', reason: 'operation_active' };
      throw error;
    }
  }

  async plan(actor: string, idempotencyKey: string | undefined, resourceId: string, action: Action): Promise<OperationPlanResult> {
    if (!this.validKey(idempotencyKey)) return { status: 'invalid', reason: 'idempotency_key_required' };
    const resources = await this.inventory(), resolved = this.resolver(resourceId, resources), resource = resolved.resource;
    if (!resource || !resource.actions.includes(action) || this.store.busy(resolved.canonicalId)) return { status: 'unavailable', reason: 'resource_or_action_unavailable' };
    if (!this.authorizeMcp(actor, resource, action)) return { status: 'unavailable', reason: 'operation_not_permitted' };
    const canonical = { ...resource, id: resolved.canonicalId };
    const planned = this.store.createOperationPlan(actor, idempotencyKey, canonical, action, this.policyVersion(actor), this.now());
    if (planned.status === 'conflict') return { status: 'conflict', reason: 'idempotency_conflict' };
    return { status: planned.status, plan: planned.plan };
  }

  async executePlan(actor: string, planId: string): Promise<OperationExecutionResult> {
    const initial = this.store.operationPlan(planId);
    if (!initial) return { status: 'not_found' };
    if (initial.actor !== actor) return { status: 'wrong_actor' };
    if (initial.state === 'consumed' && initial.operationId) {
      if (initial.policyVersion !== this.policyVersion(actor)) return { status: 'not_authorized' };
      const resources = await this.inventory(), resolved = this.resolver(initial.resourceId, resources);
      if (!resolved.resource || resolved.canonicalId !== initial.resourceId || !this.authorizeMcp(actor, resolved.resource, initial.action)) return { status: 'not_authorized' };
      const operation = this.store.get(initial.operationId);
      return operation ? { status: 'replay', operation } : { status: 'stale' };
    }
    if (initial.state !== 'planned' || Date.parse(initial.expiresAt) <= this.now()) return { status: 'expired' };
    const resources = await this.inventory(), resolved = this.resolver(initial.resourceId, resources), resource = resolved.resource;
    if (!resource || resolved.canonicalId !== initial.resourceId || !resource.actions.includes(initial.action)
      || resource.state !== initial.resourceState || (resource.observedAt ?? null) !== initial.observedAt || initial.policyVersion !== this.policyVersion(actor)) return { status: 'stale' };
    if (!this.authorizeMcp(actor, resource, initial.action)) return { status: 'not_authorized' };
    const key = `mcp-${initial.id}`;
    const fingerprint = JSON.stringify({ resourceId: initial.resourceId, action: initial.action });
    let created: Operation | undefined, replay: Operation | undefined, failure: 'not_found' | 'wrong_actor' | 'expired' | 'stale' | 'not_authorized' | 'active' | 'blocked' | undefined;
    try { this.store.atomic(() => {
      const transactionNow = this.now();
      const plan = this.store.operationPlan(initial.id);
      if (!plan || plan.actor !== actor) { failure = 'not_found'; return; }
      if (plan.state === 'consumed' && plan.operationId) { replay = this.store.get(plan.operationId); failure = replay ? undefined : 'stale'; return; }
      if (plan.state !== 'planned' || Date.parse(plan.expiresAt) <= transactionNow) { failure = 'expired'; return; }
      if (this.store.busy(initial.resourceId)) { failure = 'active'; return; }
      const existing = this.store.existing(actor, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) { failure = 'stale'; return; }
        replay = this.store.get(existing.id);
        if (!replay) { failure = 'stale'; return; }
        const result = this.store.consumeOperationPlan(initial.id, actor, replay.id, transactionNow);
        if (result !== 'consumed' && result !== 'replay') failure = 'stale';
        return;
      }
      try {
        created = this.store.create(actor, key, fingerprint, { ...resource, id: initial.resourceId }, initial.action);
        const result = this.store.consumeOperationPlan(initial.id, actor, created.id, transactionNow);
        if (result !== 'consumed') throw new PlanConsumptionError(result === 'expired' ? 'expired' : 'stale');
      } catch (error) {
        if (error instanceof PlanConsumptionError) throw error;
        if (error instanceof DeploymentBlockedError) failure = 'blocked';
        else if (error instanceof ActiveOperationError) failure = 'active';
        else throw error;
      }
    }); } catch (error) {
      if (error instanceof PlanConsumptionError) { created = undefined; failure = error.result; }
      else throw error;
    }
    if (created) { this.start(created, { ...resource, id: initial.resourceId }, initial.action); return { status: 'created', operation: created }; }
    if (replay) return { status: 'replay', operation: replay };
    return { status: failure ?? 'stale' };
  }

  private validKey(value: string | undefined): value is string { return Boolean(value && /^[a-zA-Z0-9_-]{1,100}$/.test(value)); }
  private matchesFingerprint(value: string, action: Action, canonicalId: string, resources: Resource[]): boolean {
    try {
      const parsed = JSON.parse(value) as { resourceId?: unknown; action?: unknown };
      return parsed.action === action && typeof parsed.resourceId === 'string' && this.resolver(parsed.resourceId, resources).canonicalId === canonicalId;
    } catch { return false; }
  }
  private start(operation: Operation, resource: Resource, action: Action): void {
    if (this.closed()) return;
    this.store.update(operation.id, 'running', 'Revalidando estado, evidencia y permisos…');
    void this.revalidateAndPerform(operation, resource, action, (message, verification) => {
      if (this.closed()) return;
      if (verification) this.store.recordOperationVerification(operation.id, verification);
      try { this.store.update(operation.id, 'running', message); } catch { /* Progress cannot interrupt an operation. */ }
    }).then(result => {
      if (!this.closed()) this.store.update(operation.id, 'succeeded', result.message);
    }).catch((error: unknown) => {
      if (this.closed()) return;
      const message = error instanceof OperationPreflightError
        ? 'La orden no se envió: cambiaron el estado, la capacidad o los permisos durante la revalidación.'
        : error instanceof UncertainError ? error.message : 'El proveedor no pudo completar o verificar la operación. Comprueba el equipo antes de repetir.';
      this.store.update(operation.id, error instanceof UncertainError ? 'uncertain' : 'failed', message);
    });
  }

  private async revalidateAndPerform(operation: Operation, expected: Resource, action: Action, progress: OperationProgress): Promise<{ message: string }> {
    let current: Resource | undefined;
    try {
      const resources = await this.inventory();
      const resolved = this.resolver(operation.resourceId, resources);
      current = resolved.resource;
      if (!current || resolved.canonicalId !== operation.resourceId || !current.actions.includes(action)
        || action !== 'refresh' && (current.state !== expected.state || (current.observedAt ?? null) !== (expected.observedAt ?? null))
        || !this.authorizeMcp(operation.actor, current, action)) throw new OperationPreflightError();
    } catch (error) {
      if (error instanceof OperationPreflightError) throw error;
      throw new OperationPreflightError();
    }
    return this.perform(current, action, progress);
  }
}
