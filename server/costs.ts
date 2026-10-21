import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { BudgetsClient, DescribeBudgetsCommand, type DescribeBudgetsCommandOutput } from '@aws-sdk/client-budgets';
import type { AwsAccount, Config } from './types.js';
import type { Store } from './store.js';

export type CostAccount = { account: string; status: 'available' | 'partial' | 'unavailable'; net: number | null; usage: number | null; adjustments: number | null; currency: string; estimated: boolean; services: { name: string; amount: number }[]; daily: { date: string; amount: number }[]; budgetsStatus: 'available' | 'unavailable' | 'partial'; budgets: { name: string; limit: number | null; actual: number | null; forecast: number | null; currency: string; updatedAt: string | null }[]; fetchedAt: string };
export type CostReport = { accounts: CostAccount[]; fetchedAt: string; nextRefreshAt: string; periodStart: string; periodEnd: string; policy: string };
type CostIO = {
  ce(account: AwsAccount): { send(command: GetCostAndUsageCommand): Promise<Partial<GetCostAndUsageCommandOutput>> };
  budgets(account: AwsAccount): { send(command: DescribeBudgetsCommand): Promise<Partial<DescribeBudgetsCommandOutput>> };
};
const clients: CostIO = {
  ce: account => new CostExplorerClient({ region: 'us-east-1', credentials: account, maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } }),
  budgets: account => new BudgetsClient({ region: 'us-east-1', credentials: account, maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } })
};
const DAY = 86400000;
const finite = (value: unknown): number | null => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export class Costs {
  private pending?: Promise<CostReport>;
  private closed = false;
  constructor(private config: Config, private store: Store, private io: CostIO = clients) {}
  close(): void { this.closed = true; }
  async get(): Promise<CostReport> {
    if (this.closed) {
      if (this.pending) return this.pending;
      throw new Error('Cost reader is closed');
    }
    if (this.pending) return this.pending;
    const cached = this.store.cache<CostReport>('costs-v1');
    if (cached && cached.expires > Date.now()) return cached.value;
    // Persist the reservation BEFORE calling a paid API. A restart while loading
    // cannot bypass the daily cap. An incomplete cycle is explicitly unavailable.
    const now = new Date();
    const report: CostReport = { accounts: [], fetchedAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + DAY).toISOString(), periodStart: `${now.toISOString().slice(0, 7)}-01`, periodEnd: now.toISOString().slice(0, 10), policy: 'Caché 24 h compartida. Hasta 2 solicitudes Cost Explorer por cuenta y ciclo, sin reintentos. Cost Explorer: US$0,01 por solicitud a vista primaria; hasta US$1,80 por 30 días para 3 cuentas. Presupuestos se consultan una vez por ciclo. Datos de AWS con retraso; no es una factura.' };
    report.accounts = this.config.aws.map(account => ({ account: account.name, status: 'unavailable', net: null, usage: null, adjustments: null, currency: 'USD', estimated: true, services: [], daily: [], budgetsStatus: 'unavailable', budgets: [], fetchedAt: report.fetchedAt }));
    this.store.putCache('costs-v1', report, DAY);
    this.pending = this.load(report).then(result => {
      if (!this.closed) this.store.putCache('costs-v1', result, Math.max(1, Date.parse(report.nextRefreshAt) - Date.now()));
      return result;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(report: CostReport): Promise<CostReport> {
    // Account queries are sequential to keep bursts and spending predictable.
    for (const [index, account] of this.config.aws.entries()) {
      const row = report.accounts[index];
      try {
        if (report.periodStart === report.periodEnd) throw new Error('No complete days this month');
        const client = this.io.ce(account), services = new Map<string, number>(), daily = new Map<string, number>();
        let token: string | undefined, net = 0, usage = 0, adjustments = 0, estimated = false;
        for (let page = 0; page < 2; page++) {
          const data = await client.send(new GetCostAndUsageCommand({ TimePeriod: { Start: report.periodStart, End: report.periodEnd }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [account.accountId] } }, GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'RECORD_TYPE' }], ...(token ? { NextPageToken: token } : {}) }));
          for (const day of data.ResultsByTime ?? []) {
            estimated ||= day.Estimated ?? false;
            for (const group of day.Groups ?? []) {
              const metric = group.Metrics?.UnblendedCost, amount = finite(metric?.Amount);
              if (amount === null || metric?.Unit !== 'USD') throw new Error('Unexpected cost metric');
              const [service = 'Otro', type = ''] = group.Keys ?? [];
              net += amount;
              if (type === 'Credit' || type === 'Refund') adjustments += amount; else usage += amount;
              services.set(service, (services.get(service) ?? 0) + amount);
              const date = day.TimePeriod?.Start ?? report.periodStart;
              daily.set(date, (daily.get(date) ?? 0) + amount);
            }
          }
          token = data.NextPageToken;
          if (!token) break;
        }
        Object.assign(row, { status: token ? 'partial' : 'available', net, usage, adjustments, estimated, services: [...services].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount), daily: [...daily].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)) });
      } catch { row.status = 'unavailable'; }
      try {
        const data = await this.io.budgets(account).send(new DescribeBudgetsCommand({ AccountId: account.accountId, MaxResults: 100 }));
        row.budgets = (data.Budgets ?? []).filter(budget => budget.BudgetType === 'COST').map(budget => ({ name: budget.BudgetName ?? 'Presupuesto', limit: finite(budget.BudgetLimit?.Amount), actual: finite(budget.CalculatedSpend?.ActualSpend?.Amount), forecast: finite(budget.CalculatedSpend?.ForecastedSpend?.Amount), currency: budget.BudgetLimit?.Unit ?? 'USD', updatedAt: budget.LastUpdatedTime?.toISOString() ?? null }));
        row.budgetsStatus = data.NextToken ? 'partial' : 'available';
      } catch { row.budgetsStatus = 'unavailable'; }
    }
    return report;
  }
}
