import { createHash } from 'node:crypto';
import type { CostReport } from './costs.js';
import type { Store } from './store.js';
import type { Adapter, Resource } from './types.js';

export const COLLECTOR_INTERVAL_SECONDS = 900;
const COLLECTOR_INTERVAL_MS = COLLECTOR_INTERVAL_SECONDS * 1000;
const BASELINE_KEY = 'provider-state-baselines-v1';
type CostReader = { get(): Promise<CostReport> };
type ProviderState = { state: string; observedAt: string; candidate?: string; candidateCount?: number; candidateExpected?: boolean };
export type MonitorHealth = {
  enabled: boolean;
  state: 'disabled' | 'idle' | 'running' | 'healthy' | 'degraded';
  intervalSeconds: number;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  consecutiveFailures: number;
  resourcesObserved: number;
  unknownResources: number;
};

export class InfrastructureMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private unsubscribe?: () => void;
  private health: MonitorHealth = { enabled: false, state: 'disabled', intervalSeconds: COLLECTOR_INTERVAL_SECONDS, lastAttemptAt: null, lastCompletedAt: null, consecutiveFailures: 0, resourcesObserved: 0, unknownResources: 0 };

  constructor(private readonly store: Store, private readonly adapter: Adapter, private readonly costs: CostReader, private readonly now = Date.now, private readonly refreshCloud?: () => Promise<Resource[]>, private readonly coverageHealthy: () => boolean = () => true) {
    this.health.enabled = true;
    this.health.state = 'idle';
    for (const effect of this.store.expectations.effects()) this.verifiedEffect(effect.resourceId, effect.target, effect.confirmedAt);
    this.unsubscribe = this.store.subscribeEvents(id => {
      if (this.closed) return;
      const event = this.store.eventsAfter(id - 1, 1)[0];
      if (event?.type !== 'operation' || event.payload.state !== 'succeeded') return;
      const { resourceId, action, updatedAt } = event.payload;
      if (typeof resourceId === 'string' && typeof updatedAt === 'string' && (action === 'start' || action === 'stop')) this.verifiedEffect(resourceId, action === 'start' ? 'running' : 'stopped', updatedAt);
    });
  }

  private verifiedEffect(resourceId: string, state: string, observedAt: string): void {
    const baselines = this.baselines(), current = baselines[resourceId];
    if (current && Date.parse(current.observedAt) > Date.parse(observedAt)) return;
    baselines[resourceId] = { state, observedAt };
    this.saveBaselines(baselines);
  }

  private currentObservation(resource: Resource): boolean {
    if (!resource.observedAt || !Number.isFinite(Date.parse(resource.observedAt))) return false;
    const age = this.now() - Date.parse(resource.observedAt);
    const until = resource.health?.presence?.freshUntil;
    return age >= -300_000 && (until ? Number.isFinite(Date.parse(until)) && this.now() <= Date.parse(until) : age <= (resource.kind === 'ec2' ? 1_200_000 : 240_000));
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, COLLECTOR_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  wake(): void { if (!this.closed) void this.tick(); }

  close(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  status(): MonitorHealth {
    return { ...this.health, ...(this.health.state === 'healthy' && !this.coverageHealthy() ? { state: 'degraded' as const } : {}) };
  }

  observeAwsEvent(resource: Resource, previousState: string | null, eventId: string): void {
    if (this.closed || resource.kind !== 'ec2' || !resource.observedAt || !this.currentObservation(resource)) return;
    const baselines = this.baselines(), current = baselines[resource.id];
    if (current && Date.parse(resource.observedAt) <= Date.parse(current.observedAt)) return;
    const from = current?.state ?? previousState;
    if (resource.state !== 'running' && resource.state !== 'stopped') this.store.expectations.observe(resource.id, resource.state, resource.observedAt);
    if (from && from !== 'unknown' && from !== 'unconfigured' && from !== resource.state) {
      const expected = this.expectedTransition(resource, resource.observedAt);
      if (!expected) {
        const dedupe = createHash('sha256').update(`aws-event:${eventId}`).digest('hex');
        this.store.appendEventOnce(`aws-event-${dedupe}`, 'incident', resource.id, {
          category: 'infrastructure', resourceId: resource.id, resourceName: resource.name, kind: resource.kind,
          from, to: resource.state, observedAt: resource.observedAt, transitionReason: 'provider_state_changed', evidence: 'eventbridge'
        });
      }
    }
    this.store.expectations.observe(resource.id, resource.state, resource.observedAt);
    baselines[resource.id] = { state: resource.state, observedAt: resource.observedAt };
    this.saveBaselines(baselines);
  }

  async tick(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    this.health.state = 'running';
    this.health.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const resources = this.refreshCloud
        ? await this.refreshCloud()
        : this.adapter.cloudInventory
        ? await this.adapter.cloudInventory()
        : (await this.adapter.inventory()).filter(resource => resource.kind === 'ec2' || resource.kind === 'service');
      if (this.closed) return;
      const providers = resources.filter(resource => resource.catalog?.provider !== 'host' && !resource.id.startsWith('host:') && (resource.kind === 'ec2' || resource.kind === 'service'));
      this.observe(providers);
      this.health.resourcesObserved = providers.length;
      this.health.unknownResources = providers.filter(resource => resource.state === 'unknown').length;
      const report = await this.costs.get();
      if (this.closed) return;
      this.observeBudgets(report);
      const covered = this.coverageHealthy() && providers.every(resource => this.currentObservation(resource) && (!resource.coverage || resource.coverage.state === 'healthy' && Boolean(resource.coverage.freshUntil) && this.now() <= Date.parse(resource.coverage.freshUntil!)));
      if (covered) this.health.lastCompletedAt = new Date(this.now()).toISOString();
      this.health.consecutiveFailures = covered ? 0 : this.health.consecutiveFailures + 1;
      this.health.state = !covered || providers.length === 0 || this.health.unknownResources > 0 ? 'degraded' : 'healthy';
    } catch {
      this.health.consecutiveFailures++;
      this.health.state = 'degraded';
    } finally { this.running = false; }
  }

  private baselines(): Record<string, ProviderState> {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(BASELINE_KEY) as { value: string } | undefined;
    if (!row) return {};
    try { return JSON.parse(row.value) as Record<string, ProviderState>; } catch { return {}; }
  }

  private saveBaselines(value: Record<string, ProviderState>): void {
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(BASELINE_KEY, JSON.stringify(value));
  }

  private observe(resources: Resource[]): void {
    const baselines = this.baselines();
    let changed = false;
    for (const resource of resources) {
      if (resource.kind !== 'ec2' && resource.kind !== 'service') continue;
      if (!resource.observedAt || !this.currentObservation(resource) || resource.state === 'unknown' || resource.state === 'unconfigured') continue;
      const current = baselines[resource.id];
      if (!current) {
        this.store.consumeExpectedTransition(resource.id, resource.state, resource.observedAt);
        baselines[resource.id] = { state: resource.state, observedAt: resource.observedAt };
        changed = true;
        continue;
      }
      if (Date.parse(resource.observedAt) <= Date.parse(current.observedAt)) continue;
      if (current.state === resource.state) {
        this.store.expectations.observe(resource.id, resource.state, resource.observedAt);
        if (current.candidate || current.candidateCount) {
          delete current.candidate;
          delete current.candidateCount;
          delete current.candidateExpected;
        }
        current.observedAt = resource.observedAt;
        changed = true;
        continue;
      }
      if (current.candidate !== resource.state) {
        current.candidate = resource.state;
        current.candidateCount = 1;
        // Vincular la primera evidencia al efecto concreto, no a la fecha en
        // que una segunda muestra termina la histéresis del aviso.
        current.candidateExpected = this.expectedTransition(resource, resource.observedAt);
        current.observedAt = resource.observedAt;
        changed = true;
        continue;
      }
      current.candidateCount = (current.candidateCount ?? 1) + 1;
      current.observedAt = resource.observedAt;
      changed = true;
      if (current.candidateCount < 2) continue;

      const from = current.state, to = resource.state;
      const expected = current.candidateExpected === true || this.expectedTransition(resource, resource.observedAt);
      if (!expected) {
        const dedupe = createHash('sha256').update(`${resource.id}:${from}:${to}:${resource.observedAt}`).digest('hex');
        this.store.appendEventOnce(`provider-${dedupe}`, 'incident', resource.id, {
          category: 'infrastructure', resourceId: resource.id, resourceName: resource.name, kind: resource.kind,
          from, to, observedAt: resource.observedAt, transitionReason: 'provider_state_changed'
        });
      }
      this.store.expectations.observe(resource.id, to, resource.observedAt);
      current.state = to;
      delete current.candidate;
      delete current.candidateCount;
      delete current.candidateExpected;
    }
    if (changed) this.saveBaselines(baselines);
  }

  private expectedTransition(resource: Resource, observedAt: string): boolean {
    if(this.store.expectations.wasExpectedEvidence(resource.id,resource.state,observedAt))return true;
    if(resource.state==='running'||resource.state==='stopped')return this.store.consumeExpectedTransition(resource.id,resource.state,observedAt);
    if(resource.kind==='ec2'&&resource.state==='pending')return this.store.hasExpectedTransition(resource.id,'running',observedAt);
    if(resource.kind==='ec2'&&resource.state==='stopping')return this.store.hasExpectedTransition(resource.id,'stopped',observedAt);
    return false;
  }

  private observeBudgets(report: CostReport): void {
    if(!/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(report.periodStart))return;
    const period=report.periodStart.slice(0,7);
    for (const account of report.accounts) {
      if (!account.accountId || !/^\d{12}$/.test(account.accountId) || account.budgetsStatus === 'unavailable') continue;
      const accountId=account.accountId;
      for (const budget of account.budgets) {
        const limit = budget.limit;
        if (limit === null || limit <= 0) continue;
        const actualPercent = budget.actual === null ? null : budget.actual / limit * 100;
        const forecastPercent = budget.forecast === null ? null : budget.forecast / limit * 100;
        const strongest = Math.max(actualPercent ?? -Infinity, forecastPercent ?? -Infinity);
        const threshold = strongest >= 100 ? 100 : strongest >= 80 ? 80 : null;
        if (threshold === null) continue;
        const useForecast = forecastPercent !== null && forecastPercent > (actualPercent ?? -Infinity);
        const amount = useForecast ? budget.forecast! : budget.actual!;
        const percent = useForecast ? forecastPercent! : actualPercent!;
        const key = (value:80|100) => `budget-v2-${createHash('sha256').update(JSON.stringify([accountId,period,budget.name,value])).digest('hex')}`;
        // Legacy keys have no durable binding to an event, account and period.
        // Only physical v2 keys suppress a newly observed threshold.
        this.store.appendEventOnce(key(threshold), 'incident', `budget:${accountId}:${period}:${budget.name}`, {
          category: 'budget', account: account.account, accountId, budgetName: budget.name, threshold,
          percent: Math.round(percent * 10) / 10, amount, limit, currency: budget.currency,
          source: useForecast ? 'forecast' : 'actual', asOf: budget.updatedAt ?? account.fetchedAt
        }, threshold >= 100 ? [key(80)] : []);
      }
    }
  }
}
