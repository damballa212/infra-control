import type { Store } from '../../server/store.js';

type CostBudgetFixture = {
  accountId: string; account: string; connectionId: string; budgetName: string;
  overrides?: Record<string, unknown>;
};
/** Budget events exercise the cost-budget projection, without EC2 observations
 * or resource expectations. The aggregate is deliberately longer than aliases.
 */
export function appendCostBudgetIncident(store: Store, input: CostBudgetFixture) {
  const aggregateId = `budget:${input.account}:${input.budgetName}`;
  const payload: Record<string, unknown> = {
    category: 'budget', source: 'cost-budget', accountId: input.accountId,
    account: input.account, connectionId: input.connectionId, budgetName: input.budgetName,
    threshold: 80, percent: 90, amount: 90, limit: 100, currency: 'USD',
    observedAt: new Date().toISOString(), ...input.overrides
  };
  store.appendEvent('incident', aggregateId, payload);
  return { aggregateId, payload, budgetName: input.budgetName };
}
