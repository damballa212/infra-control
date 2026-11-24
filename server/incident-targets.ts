import { readIncidentSourceContext } from './incident-source.js';
type IncidentResource = { readonly catalogId: string; readonly aliases: readonly string[]; readonly accountId?:string; readonly connectionId?:string };
export type IncidentTargets = { kind: 'resource' | 'budget' | 'scope' | 'other'; resourceIds: string[]; valid:boolean };
const budgetId = (id: string): boolean => /^(?:budget|budgets|cost-budget):/.test(id);
const scopeId = (id: string): boolean => /^(?:scope|coverage):/.test(id);
const nonResourceId = (id: string): boolean => budgetId(id) || scopeId(id);
const localResources = new Set(['computer:desktop', 'computer:mac', 'router:fiberhome', 'hermes:orchestrator']);

/** Aggregate IDs are opaque. Only explicit resource fields or an already-known
 * resource aggregate enter resource authorization. No alias resolver is called.
 * Budget projections may carry their aggregate ID in a field named resourceId.
 */
export function incidentTargets(payload: Readonly<Record<string, unknown>>, aggregateId: string, records: readonly IncidentResource[]): IncidentTargets {
  const source=readIncidentSourceContext(payload);
  const resourceIds: string[] = [];
  for(const id of [payload.resourceId,source?.resourceId])if(typeof id==='string'&&id&&!nonResourceId(id))resourceIds.push(id);
  for(const id of [payload.catalogId,source?.catalogId])if(typeof id==='string'&&id)resourceIds.push(`catalog:${id}`);
  if (!nonResourceId(aggregateId)) {
    const record = records.find(item => item.catalogId === aggregateId || `catalog:${item.catalogId}` === aggregateId || item.aliases.includes(aggregateId));
    if (record) resourceIds.push(record.catalogId === aggregateId ? `catalog:${record.catalogId}` : aggregateId);
    else if (localResources.has(aggregateId)) resourceIds.push(aggregateId);
  }
  const kind = budgetId(aggregateId)||payload.kind==='budget' ? 'budget' : scopeId(aggregateId)||payload.kind==='coverage' ? 'scope'
    : resourceIds.length ? 'resource' : typeof payload.budgetName === 'string' ? 'budget'
    : typeof payload.connectionId === 'string' && typeof payload.scopeKey === 'string' ? 'scope' : 'other';
  const referenced=records.filter(record=>resourceIds.some(id=>id===record.catalogId||id===`catalog:${record.catalogId}`||record.aliases.includes(id)));
  const contradiction=referenced.some(record=>typeof payload.accountId==='string'&&record.accountId!==undefined&&record.accountId!==payload.accountId
    ||typeof payload.connectionId==='string'&&record.connectionId!==undefined&&record.connectionId!==payload.connectionId);
  return { kind, resourceIds: [...new Set(resourceIds)], valid:source?.conflict!==true&&!contradiction };
}
