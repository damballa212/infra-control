import type { DurableEvent } from './store.js';
import type { IncidentSourceContext, OperationalIncident } from './operational-types.js';

type BudgetSource=Pick<OperationalIncident,'accountId'|'account'|'budgetName'|'connectionId'>&{sourceContext:IncidentSourceContext};
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=240&&!/[\u0000-\u001f\u007f]/.test(value);
const nonResource=(id:string)=>/^(?:budget|budgets|cost-budget|scope|coverage):/.test(id);

/** Copies evidence from this exact event; never derives accountId from a label. */
export function costBudgetSource(event:DurableEvent):BudgetSource|undefined {
  if(event.type!=='incident'||event.payload.category!=='budget')return undefined;
  const sourceContext:IncidentSourceContext={eventIds:[event.id]},result:BudgetSource={sourceContext};
  for(const key of ['accountId','account','budgetName','connectionId'] as const){
    const value=event.payload[key];if(value===undefined)continue;
    if(!text(value)||key==='accountId'&&!/^\d{12}$/.test(value)){sourceContext.conflict=true;continue;}
    result[key]=value;
  }
  for(const key of ['resourceId','catalogId','scopeKey'] as const){
    const value=event.payload[key];if(value===undefined||value===null)continue;
    if(!text(value)){sourceContext.conflict=true;continue;}
    if(key!=='resourceId'||!nonResource(value))sourceContext[key]=value;
  }
  return result;
}

/** Hydrates only retained opening/last-event evidence supplied by the read model. */
export function hydrateCostBudgetSource(incident:OperationalIncident,events:readonly DurableEvent[]):OperationalIncident {
  if(incident.kind!=='budget'||incident.sourceContext)return incident;
  const sources=events.map(costBudgetSource).filter((source):source is BudgetSource=>source!==undefined);
  if(!sources.length)return incident;
  const sourceContext:IncidentSourceContext={eventIds:[...new Set(sources.flatMap(source=>source.sourceContext.eventIds))]};
  let conflict=sources.some(source=>source.sourceContext.conflict===true)
    ||events.some(event=>event.type!=='incident'||event.payload.category!=='budget'||String(event.payload.source??'provider')!==incident.source);
  const result={...incident};
  for(const key of ['accountId','connectionId','budgetName','account'] as const){
    const values=sources.map(source=>source[key]).filter((value):value is string=>value!==undefined);
    const previous=incident[key];
    if(key!=='account'&&(new Set(values).size>1||previous!==undefined&&!values.includes(previous)))conflict=true;
    const value=previous??values[0];if(value!==undefined)result[key]=value;
  }
  for(const key of ['resourceId','catalogId','scopeKey'] as const){
    const values=sources.map(source=>source.sourceContext[key]).filter((value):value is string=>value!==undefined);
    if(new Set(values).size>1)conflict=true;
    if(values[0]!==undefined)sourceContext[key]=values[0];
  }
  if(conflict)sourceContext.conflict=true;
  return {...result,sourceContext};
}

/** Validates only the structure of stored provenance; it grants no authority. */
export function readIncidentSourceContext(payload:Readonly<Record<string,unknown>>):IncidentSourceContext|undefined {
  const raw=payload.sourceContext;if(raw===undefined)return undefined;
  const invalid=():IncidentSourceContext=>({eventIds:[],conflict:true});
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();
  const value=raw as Record<string,unknown>,ids=value.eventIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>2||ids.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<=0))return invalid();
  const result:IncidentSourceContext={eventIds:[...ids] as number[]};
  if(value.conflict!==undefined){if(value.conflict!==true)return invalid();result.conflict=true;}
  for(const key of ['resourceId','catalogId','scopeKey'] as const){
    if(value[key]===undefined)continue;
    if(!text(value[key]))return invalid();
    result[key]=value[key];
  }
  return result;
}
