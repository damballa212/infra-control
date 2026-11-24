import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { BudgetsClient, DescribeBudgetsCommand, type DescribeBudgetsCommandOutput } from '@aws-sdk/client-budgets';
import type { AwsAccount, Config } from './types.js';
import type { Store } from './store.js';
import { createHash } from 'node:crypto';
import { awsCredentials, isAwsAccountEnabled } from './aws-credentials.js';

export type CostAccount = { account: string; accountId?: string; status: 'available' | 'partial' | 'unavailable'; net: number | null; usage: number | null; adjustments: number | null; currency: string; estimated: boolean; services: { name: string; amount: number }[]; daily: { date: string; amount: number }[]; budgetsStatus: 'available' | 'unavailable' | 'partial'; budgets: { name: string; limit: number | null; actual: number | null; forecast: number | null; currency: string; updatedAt: string | null }[]; fetchedAt: string };
export type CostReport = { accounts: CostAccount[]; fetchedAt: string; nextRefreshAt: string; periodStart: string; periodEnd: string; policy: string };
type CostIO = {
  ce(account: AwsAccount, accounts?: readonly AwsAccount[]): { send(command: GetCostAndUsageCommand): Promise<Partial<GetCostAndUsageCommandOutput>> };
  budgets(account: AwsAccount, accounts?: readonly AwsAccount[]): { send(command: DescribeBudgetsCommand): Promise<Partial<DescribeBudgetsCommandOutput>> };
};
const clients: CostIO = {
  ce: (account, accounts) => new CostExplorerClient({ region: 'us-east-1', credentials: awsCredentials(account, accounts), maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } }),
  budgets: (account, accounts) => new BudgetsClient({ region: 'us-east-1', credentials: awsCredentials(account, accounts), maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } })
};
const DAY = 86400000;
const REPORT_CACHE = 'costs-v1';
const REPORT_METADATA_CACHE = 'cost-report-metadata-v1';
const ACCOUNT_CACHE_PREFIX = 'cost-account-v1:';
const LEGACY_RESERVATION_CACHE = 'cost-legacy-reservation-v1';
const finite = (value: unknown): number | null => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
type AccountGroup = { accountId: string; displayName: string; credential: AwsAccount };
type AccountCache = { row: CostAccount; periodStart?: string; periodEnd?: string };
type AccountSnapshot = AccountCache & { expires: number };
export class Costs {
  private pending?: Promise<CostReport>;
  private closed = false;
  constructor(private config: Config, private store: Store, private io: CostIO = clients) {}
  close(): void { this.closed = true; }
  getCached(): { report: CostReport | null; stale: boolean; expiresAt: string | null } {
    const cached = this.store.cache<CostReport>(REPORT_CACHE);
    if (!cached) return { report: null, stale: true, expiresAt: null };
    const report = { ...cached.value, accounts: this.accountGroups().flatMap(group => {
      const row = this.legacyAccountRow(cached.value, group);
      return row ? [this.label(row, group)] : [];
    }), policy: this.policy(this.accountGroups().length) };
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
    const refreshAt = Date.parse(report.nextRefreshAt);
    const expires = Math.min(cached.expires, Number.isFinite(refreshAt) ? refreshAt : cached.expires);
    return { report, stale: expires <= Date.now() || report.periodStart !== monthStart, expiresAt: new Date(expires).toISOString() };
  }
  cacheHealth(accountIds?: readonly string[]): { configuredAccounts: number; reservedCycles: number; uncachedAccounts: number; earliestExpiry: string | null; costExplorerPageLimitPerAccount: number; cacheHours: number } {
    const allowed=accountIds?new Set(accountIds):undefined,now=Date.now();
    const groups=this.accountGroups().filter(group=>!allowed||allowed.has(group.accountId));
    const expiries=groups.map(group=>this.store.cache<CostAccount>(this.accountCacheKey(group.accountId))?.expires).filter((value):value is number=>value!==undefined&&value>now);
    return {configuredAccounts:groups.length,reservedCycles:expiries.length,uncachedAccounts:groups.length-expiries.length,
      earliestExpiry:expiries.length?new Date(Math.min(...expiries)).toISOString():null,costExplorerPageLimitPerAccount:2,cacheHours:24};
  }
  async get(): Promise<CostReport> {
    if (this.closed) {
      if (this.pending) return this.pending;
      throw new Error('Cost reader is closed');
    }
    if (this.pending) return this.pending;
    const now = Date.now(), cached = this.store.cache<CostReport>(REPORT_CACHE), groups = this.accountGroups();
    const metadata = this.store.cache<{ kind: 'per-account-v1'; expires: number; hash: string }>(REPORT_METADATA_CACHE);
    const perAccountReport = cached && metadata && metadata.expires > now
      && metadata.value.kind === 'per-account-v1' && metadata.value.expires === cached.expires
      && metadata.value.hash === this.reportHash(cached.value);
    // Only an unmarked legacy empty report carries the old global reservation.
    // A report emptied by current filtering must not reserve quota for anyone.
    if (cached && cached.expires > now && cached.value.accounts.length === 0 && !perAccountReport) return this.config.aws.some(account => !isAwsAccountEnabled(account, this.config.aws)) ? { ...cached.value, policy: this.policy(groups.length) } : cached.value;
    // Preserve every physically identified legacy reservation before filtering
    // the report. Removing and later re-adding an account must not reopen CE quota.
    if (cached && cached.expires > now) {
      for (const row of cached.value.accounts) {
        if (!row.accountId || !/^\d{12}$/.test(row.accountId)) continue;
        const key = this.accountCacheKey(row.accountId);
        if (this.store.cache<CostAccount | AccountCache>(key)) continue;
        const value: AccountCache = { row, periodStart: cached.value.periodStart, periodEnd: cached.value.periodEnd };
        this.store.putCache(key, value, cached.expires - now);
      }
    }
    const current = this.emptyReport(new Date(now));
    let legacyReservation = this.store.cache<{ fetchedAt: string }>(LEGACY_RESERVATION_CACHE);
    // Anonymous legacy rows cannot prove physical identity. Preserve their
    // quota globally even after replacing the report, without assigning sums.
    if (cached && cached.expires > now && cached.value.accounts.some(row => !row.accountId)
      && (!legacyReservation || legacyReservation.expires < cached.expires)) {
      this.store.putCache(LEGACY_RESERVATION_CACHE, { fetchedAt: cached.value.fetchedAt }, cached.expires - now);
      legacyReservation = this.store.cache<{ fetchedAt: string }>(LEGACY_RESERVATION_CACHE);
    }
    const snapshots = new Map<string, AccountSnapshot>();
    const missing: AccountGroup[] = [];
    for (const group of groups) {
      const accountCache = this.store.cache<CostAccount | AccountCache>(this.accountCacheKey(group.accountId));
      const legacy = cached ? this.legacyAccountRow(cached.value, group) : undefined;
      if (accountCache && accountCache.expires > now) {
        const raw = accountCache.value;
        // Migrate once. Neither fetchedAt nor a generated report placeholder
        // proves the interval of a raw account row.
        const value: AccountCache = 'row' in raw ? raw : { row: raw };
        if (!('row' in raw)) this.store.putCache(this.accountCacheKey(group.accountId), value, accountCache.expires - now);
        snapshots.set(group.accountId, { ...value, row: this.label(value.row, group), expires: accountCache.expires });
        continue;
      }
      if (legacy && cached && cached.expires > now) {
        const value: AccountCache = { row: this.label(legacy, group), periodStart: cached.value.periodStart, periodEnd: cached.value.periodEnd };
        this.store.putCache(this.accountCacheKey(group.accountId), value, cached.expires - now);
        snapshots.set(group.accountId, { ...value, expires: cached.expires });
        continue;
      }
      if (legacyReservation && legacyReservation.expires > now) {
        const value: AccountCache = { row: this.emptyAccount(group, legacyReservation.value.fetchedAt) };
        this.store.putCache(this.accountCacheKey(group.accountId), value, legacyReservation.expires - now);
        snapshots.set(group.accountId, { ...value, expires: legacyReservation.expires });
        continue;
      }
      missing.push(group);
      const value: AccountCache = { row: this.emptyAccount(group, current.fetchedAt), periodStart: current.periodStart, periodEnd: current.periodEnd };
      // Reserve each account before any Cost Explorer request, retaining the
      // actual interval independently of the aggregate report and its labels.
      this.store.putCache(this.accountCacheKey(group.accountId), value, DAY);
      snapshots.set(group.accountId, { ...value, expires: now + DAY });
    }

    // A valid previous-day report may retain its real interval. Any new cycle
    // uses today's UTC interval; incompatible snapshots retain quota, not sums.
    const keepPeriod = cached && cached.expires > now && missing.length === 0
      && cached.value.periodStart === current.periodStart
      && cached.value.periodEnd >= current.periodStart && cached.value.periodEnd <= current.periodEnd
      && [...snapshots.values()].every(value => value.periodStart === cached.value.periodStart && value.periodEnd === cached.value.periodEnd);
    const report = keepPeriod ? { ...cached.value, accounts: [] as CostAccount[] } : current;
    report.accounts = this.reportAccounts(groups, snapshots, report);
    report.policy = this.policy(groups.length);
    const reuseFetchedAt = keepPeriod && cached.value.accounts.length === groups.length
      && groups.every(group => cached.value.accounts.some(row => row.accountId === group.accountId));
    report.fetchedAt = reuseFetchedAt ? cached.value.fetchedAt : this.snapshotFetchedAt(snapshots, cached?.value.fetchedAt ?? report.fetchedAt);
    this.cacheReport(report, snapshots);

    this.pending = this.loadMissing(report, missing, snapshots).then(result => {
      result.accounts = this.reportAccounts(this.accountGroups(), snapshots, result);
      result.policy = this.policy(this.accountGroups().length);
      if (!this.closed) this.cacheReport(result, snapshots);
      return result;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private accountGroups(): AccountGroup[] {
    const groups = new Map<string, { names: Set<string>; credential: AwsAccount }>();
    for (const account of this.config.aws) {
      if (!isAwsAccountEnabled(account, this.config.aws)) continue;
      const name = account.displayName ?? account.name;
      const current = groups.get(account.accountId);
      if (current) current.names.add(name);
      else groups.set(account.accountId, { names: new Set([name]), credential: account });
    }
    return [...groups].map(([accountId, group]) => ({ accountId, displayName: [...group.names].sort().join(', '), credential: group.credential }));
  }
  private accountCacheKey(accountId: string): string { return `${ACCOUNT_CACHE_PREFIX}${accountId}`; }
  private emptyAccount(group: AccountGroup, fetchedAt: string): CostAccount {
    return { account: group.displayName, accountId: group.accountId, status: 'unavailable', net: null, usage: null, adjustments: null, currency: 'USD', estimated: true, services: [], daily: [], budgetsStatus: 'unavailable', budgets: [], fetchedAt };
  }
  private label(row: CostAccount, group: AccountGroup): CostAccount { return { ...row, account: group.displayName, accountId: group.accountId }; }
  private reportAccounts(groups: AccountGroup[], snapshots: Map<string, AccountSnapshot>, report: CostReport): CostAccount[] {
    return groups.map(group => {
      const snapshot = snapshots.get(group.accountId);
      return snapshot && snapshot.periodStart === report.periodStart && snapshot.periodEnd === report.periodEnd
        ? this.label(snapshot.row, group)
        : this.emptyAccount(group, snapshot?.row.fetchedAt ?? report.fetchedAt);
    });
  }
  private legacyAccountRow(report: CostReport, group: AccountGroup): CostAccount | undefined {
    return report.accounts.find(item => item.accountId === group.accountId);
  }
  private snapshotFetchedAt(snapshots: Map<string, AccountSnapshot>, fallback: string): string {
    // Use the oldest retained snapshot timestamp, never the time of a cache
    // read. Unfinished reservations retain their original creation timestamp.
    const times = [...snapshots.values()].map(value => Date.parse(value.row.fetchedAt)).filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)).toISOString() : fallback;
  }
  private reportHash(report: CostReport): string {
    return createHash('sha256').update(JSON.stringify(report)).digest('hex');
  }
  private cacheReport(report: CostReport, snapshots: Map<string, AccountSnapshot>): void {
    const now = Date.now();
    const expires = snapshots.size ? Math.min(...[...snapshots.values()].map(value => value.expires), now + DAY) : now;
    report.nextRefreshAt = new Date(expires).toISOString();
    if (!this.closed) this.store.atomic(() => {
      this.store.putCache(REPORT_CACHE, report, Math.max(1, expires - now));
      const written = this.store.cache<CostReport>(REPORT_CACHE);
      if (written) this.store.putCache(REPORT_METADATA_CACHE, { kind: 'per-account-v1', expires: written.expires, hash: this.reportHash(written.value) }, Math.max(1, written.expires - Date.now()));
    });
  }
  private emptyReport(now: Date): CostReport {
    const periodStart = `${now.toISOString().slice(0, 7)}-01`, periodEnd = now.toISOString().slice(0, 10);
    return { accounts: [], fetchedAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + DAY).toISOString(), periodStart, periodEnd, policy: this.policy(this.accountGroups().length) };
  }
  private policy(accountCount: number): string {
    const estimate = accountCount * 2 * 30 * 0.01;
    return `Caché compartida por cuenta AWS y hasta 24 h. Máximo 2 solicitudes Cost Explorer por cuenta/ciclo, sin reintentos; Cost Explorer: US$0,01 por solicitud a vista primaria. Estimación máxima bajo 2 páginas, 30 ciclos y ${accountCount} cuentas únicas: US$${estimate.toFixed(2)} solo Cost Explorer; no es el gasto total de AWS. Presupuestos se consultan una vez por cuenta/ciclo. AWS puede actualizar los datos con retraso; no es una factura.`;
  }
  private async loadMissing(report: CostReport, missing: AccountGroup[], snapshots: Map<string, AccountSnapshot>): Promise<CostReport> {
    // Account queries are sequential to keep provider bursts and cost predictable.
    for (const group of missing) {
      if (!isAwsAccountEnabled(group.credential, this.config.aws)) continue;
      const row = snapshots.get(group.accountId)!.row;
      if (report.periodStart !== report.periodEnd) {
        const client = this.io.ce(group.credential, this.config.aws);
        let services = new Map<string, number>(), daily = new Map<string, number>();
        let token: string | undefined, net = 0, usage = 0, adjustments = 0, estimated = false, receivedAny = false, failed = false;
        for (let page = 0; page < 2; page++) {
          try {
            if (!isAwsAccountEnabled(group.credential, this.config.aws)) throw new Error('AWS account unavailable');
            const data = await client.send(new GetCostAndUsageCommand({ TimePeriod: { Start: report.periodStart, End: report.periodEnd }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [group.accountId] } }, GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'RECORD_TYPE' }], ...(token ? { NextPageToken: token } : {}) }));
            // Commit a page only after every metric and aggregate is valid.
            const pageServices = new Map(services), pageDaily = new Map(daily);
            let pageNet = net, pageUsage = usage, pageAdjustments = adjustments;
            let pageEstimated: boolean = estimated;
            for (const day of data.ResultsByTime ?? []) {
              pageEstimated ||= day.Estimated ?? false;
              for (const item of day.Groups ?? []) {
                const metric = item.Metrics?.UnblendedCost, amount = finite(metric?.Amount);
                if (amount === null || metric?.Unit !== 'USD') throw new Error('invalid_cost_metric');
                const [service = 'Otro', type = ''] = item.Keys ?? [];
                pageNet += amount;
                if (type === 'Credit' || type === 'Refund') pageAdjustments += amount; else pageUsage += amount;
                pageServices.set(service, (pageServices.get(service) ?? 0) + amount);
                const date = day.TimePeriod?.Start ?? report.periodStart;
                pageDaily.set(date, (pageDaily.get(date) ?? 0) + amount);
              }
            }
            if (![pageNet, pageUsage, pageAdjustments, ...pageServices.values(), ...pageDaily.values()].every(Number.isFinite)) throw new Error('invalid_cost_total');
            net = pageNet; usage = pageUsage; adjustments = pageAdjustments; estimated = pageEstimated;
            services = pageServices; daily = pageDaily;
            receivedAny = true;
            token = data.NextPageToken;
            if (!token) break;
          } catch {
            failed = true;
            break;
          }
        }
        if (receivedAny) Object.assign(row, { status: failed || token ? 'partial' : 'available', net, usage, adjustments, estimated, services: [...services].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount), daily: [...daily].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)) });
      }
      try {
        if (!isAwsAccountEnabled(group.credential, this.config.aws)) throw new Error('AWS account unavailable');
        const data = await this.io.budgets(group.credential, this.config.aws).send(new DescribeBudgetsCommand({ AccountId: group.accountId, MaxResults: 100 }));
        row.budgets = (data.Budgets ?? []).filter(budget => budget.BudgetType === 'COST').map(budget => ({ name: budget.BudgetName ?? 'Presupuesto', limit: finite(budget.BudgetLimit?.Amount), actual: finite(budget.CalculatedSpend?.ActualSpend?.Amount), forecast: finite(budget.CalculatedSpend?.ForecastedSpend?.Amount), currency: budget.BudgetLimit?.Unit ?? 'USD', updatedAt: budget.LastUpdatedTime?.toISOString() ?? null }));
        row.budgetsStatus = data.NextToken ? 'partial' : 'available';
      } catch { row.budgetsStatus = 'unavailable'; }
      row.fetchedAt = new Date().toISOString();
      const value: AccountCache = { row, periodStart: report.periodStart, periodEnd: report.periodEnd };
      snapshots.set(group.accountId, { ...value, expires: Date.now() + DAY });
      if (!this.closed) this.store.putCache(this.accountCacheKey(group.accountId), value, DAY);
      report.accounts = this.reportAccounts(this.accountGroups(), snapshots, report);
      report.fetchedAt = this.snapshotFetchedAt(snapshots, report.fetchedAt);
      this.cacheReport(report, snapshots);
    }
    return report;
  }
}
