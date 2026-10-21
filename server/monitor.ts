import { createHash } from 'node:crypto';
import type { CostReport } from './costs.js';
import type { Store } from './store.js';
import type { Adapter, Resource } from './types.js';

const COLLECTOR_INTERVAL_MS = 300_000;
const EXPECTED_OPERATION_WINDOW_MS = 600_000;
const BASELINE_KEY = 'provider-state-baselines-v1';
type CostReader = { get(): Promise<CostReport> };
type ProviderState = { state: string; observedAt: string; candidate?: string; candidateCount?: number };
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
  private health: MonitorHealth = { enabled: false, state: 'disabled', intervalSeconds: COLLECTOR_INTERVAL_MS / 1000, lastAttemptAt: null, lastCompletedAt: null, consecutiveFailures: 0, resourcesObserved: 0, unknownResources: 0 };

  constructor(private readonly store: Store, private readonly adapter: Adapter, private readonly costs: CostReader, private readonly now = Date.now) {
    this.health.enabled = true;
    this.health.state = 'idle';
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, COLLECTOR_INTERVAL_MS);
    this.timer.unref();
    if (this.store.pushSubscriptionCount() > 0) void this.tick();
  }

  wake(): void { if (!this.closed && this.store.pushSubscriptionCount() > 0) void this.tick(); }

  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  status(): MonitorHealth {
    if (!this.store.pushSubscriptionCount() && this.health.state !== 'running') return { ...this.health, state: 'idle' };
    return { ...this.health };
  }

  async tick(): Promise<void> {
    if (this.closed || this.running || this.store.pushSubscriptionCount() === 0) return;
    this.running = true;
    this.health.state = 'running';
    this.health.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const resources = this.adapter.cloudInventory
        ? await this.adapter.cloudInventory()
        : (await this.adapter.inventory()).filter(resource => resource.kind === 'ec2' || resource.kind === 'service');
      if (this.closed) return;
      const providers = resources.filter(resource => resource.kind === 'ec2' || resource.kind === 'service');
      this.observe(providers);
      this.health.resourcesObserved = providers.length;
      this.health.unknownResources = providers.filter(resource => resource.state === 'unknown').length;
      const report = await this.costs.get();
      if (this.closed) return;
      this.observeBudgets(report);
      this.health.lastCompletedAt = new Date(this.now()).toISOString();
      this.health.consecutiveFailures = 0;
      this.health.state = providers.length === 0 || this.health.unknownResources > 0 ? 'degraded' : 'healthy';
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
      if (!resource.observedAt || !Number.isFinite(Date.parse(resource.observedAt)) || resource.state === 'unknown' || resource.state === 'unconfigured') continue;
      const current = baselines[resource.id];
      if (!current) {
        baselines[resource.id] = { state: resource.state, observedAt: resource.observedAt };
        changed = true;
        continue;
      }
      if (current.observedAt === resource.observedAt) continue;
      if (current.state === resource.state) {
        if (current.candidate || current.candidateCount) {
          delete current.candidate;
          delete current.candidateCount;
        }
        current.observedAt = resource.observedAt;
        changed = true;
        continue;
      }
      if (current.candidate !== resource.state) {
        current.candidate = resource.state;
        current.candidateCount = 1;
        current.observedAt = resource.observedAt;
        changed = true;
        continue;
      }
      current.candidateCount = (current.candidateCount ?? 1) + 1;
      current.observedAt = resource.observedAt;
      changed = true;
      if (current.candidateCount < 2) continue;

      const from = current.state, to = resource.state;
      const since = new Date(this.now() - EXPECTED_OPERATION_WINDOW_MS).toISOString();
      const expectedAction = to === 'running' ? 'start' : to === 'stopped' ? 'stop' : undefined;
      const expected = expectedAction ? this.store.recentExpectedOperation(resource.id, expectedAction, since) : false;
      if (!expected) {
        const dedupe = createHash('sha256').update(`${resource.id}:${from}:${to}:${resource.observedAt}`).digest('hex');
        this.store.appendEventOnce(`provider-${dedupe}`, 'incident', resource.id, {
          category: 'infrastructure', resourceId: resource.id, resourceName: resource.name, kind: resource.kind,
          from, to, observedAt: resource.observedAt, transitionReason: 'provider_state_changed'
        });
      }
      current.state = to;
      delete current.candidate;
      delete current.candidateCount;
    }
    if (changed) this.saveBaselines(baselines);
  }

  private observeBudgets(report: CostReport): void {
    for (const account of report.accounts) {
      if (account.budgetsStatus === 'unavailable') continue;
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
        const base = `${account.account}:${report.periodStart.slice(0, 7)}:${budget.name}`;
        const key = (value: number) => `budget-${createHash('sha256').update(`${base}:${value}`).digest('hex')}`;
        this.store.appendEventOnce(key(threshold), 'incident', `budget:${account.account}:${budget.name}`, {
          category: 'budget', account: account.account, budgetName: budget.name, threshold,
          percent: Math.round(percent * 10) / 10, amount, limit, currency: budget.currency,
          source: useForecast ? 'forecast' : 'actual', asOf: budget.updatedAt ?? account.fetchedAt
        }, threshold >= 100 ? [key(80)] : []);
      }
    }
  }
}
