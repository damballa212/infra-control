import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerMcpTools, type McpToolContext } from '../server/mcp/tools.js';
import type { OperationService } from '../server/operation-service.js';
import { CatalogRepository } from '../server/catalog.js';
import { Costs } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { Config } from '../server/types.js';
import { appendCostBudgetIncident } from './fixtures/aws-budget-events.js';
import { emitPhysicalBudgetAlerts } from './fixtures/physical-budget-alerts.js';

const stores:Store[]=[];
type Result={structuredContent:Record<string,unknown>;isError?:boolean};
type Handler=(input:Record<string,unknown>)=>Promise<Result>;
function fixture(longLabels=false){
  const store=new Store(':memory:');stores.push(store);const catalog=new CatalogRepository(store);
  const active=catalog.registerConnection({provider:'aws',providerAccountId:'111111111111',name:'active',displayName:longLabels?'A'.repeat(120):undefined,credentialRef:'fixture'});
  const suspended=catalog.registerConnection({provider:'aws',providerAccountId:'222222222222',name:'lab',displayName:longLabels?'S'.repeat(120):undefined,credentialRef:'fixture'});
  for(const connection of [active,suspended]){
    const alias=connection.id===active.id?'active':'lab';
    catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[{providerId:`i-${alias}`,resourceType:'ec2-instance',region:'us-east-1',name:connection.name,state:'running',detail:'fixture',observedAt:new Date().toISOString(),aliases:[`aws:${alias}:i-${alias}`]}],{complete:true,observedAt:new Date().toISOString()});
  }
  catalog.setConnectionState(suspended.id,'suspended');
  const records=catalog.listResources({includeRetired:true}),hidden=records.find(record=>record.connectionId===suspended.id)!,shown=records.find(record=>record.connectionId===active.id)!;
  const handlers=new Map<string,Handler>();
  const server={registerTool:(name:string,_definition:unknown,handler:Handler)=>{handlers.set(name,handler);return {disable:()=>{handlers.delete(name);}};}} as unknown as McpServer;
  const config:Config={aws:[],origin:'https://control.example.test',passwordHash:'fixture',agentTokens:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''}};
  const forbidden=()=>{throw new Error('No AWS IO');};
  const context:McpToolContext={actor:'fixture-reader',store,catalog,costs:new Costs(config,store,{ce:forbidden,budgets:forbidden}),operationService:{} as OperationService,
    authorize:()=>true,inventory:async()=>records.map(record=>catalog.asResource(record)),legacyActionAliases:new Set(),
    allowedTools:new Set(['list_resources','get_resource','get_incidents','get_pending_incidents','acknowledge_incident']),
    visibleResource:()=>true,filterScope:scope=>scope,visibleProject:()=>true,filterService:service=>service,
    visibleIncident:()=>true,visibleResourceId:()=>true,filterCosts:report=>report};
  registerMcpTools(server,context);
  const invoke=(name:string,input:Record<string,unknown>={})=>{const handler=handlers.get(name);if(!handler)throw new Error('Tool unavailable');return handler(input);};
  return {store,catalog,context,hidden,shown,active,suspended,invoke};
}
afterEach(()=>{for(const store of stores.splice(0))store.close();vi.restoreAllMocks();});

describe('MCP no rescata registros suspendidos por lecturas directas',()=>{
  it.each([false,true])('eventos, historia y leases usan accountId con etiquetas compartidas; ambas activas=%s',async bothActive=>{
    const f=fixture();
    f.catalog.registerConnection({provider:'aws',providerAccountId:'111111111111',name:'active',displayName:'Shared label',credentialRef:'fixture'});
    f.catalog.registerConnection({provider:'aws',providerAccountId:'222222222222',name:'lab',displayName:'Shared label',credentialRef:'fixture'});
    f.catalog.setConnectionState(f.suspended.id,bothActive?'active':'suspended');
    const allowAll=()=>true;
    const allowA=(payload:Record<string,unknown>)=>payload.accountId==='111111111111';
    for(const [actor,limited] of [['broad',false],['limited-a',true],['after-suspension',false],['limited-a-after',true]] as const){
      f.context.actor=actor;f.context.visibleIncident=limited?allowA:allowAll;
      await f.invoke('get_pending_incidents');
    }
    expect(await emitPhysicalBudgetAlerts(f.store,['111111111111','222222222222'])).toHaveLength(2);
    const ids=(result:Result)=>{
      const incidents=result.structuredContent.incidents as Array<Record<string,unknown>>;
      return incidents.map(item=>{
        const payload=item.incident&&typeof item.incident==='object'?item.incident as Record<string,unknown>:item;
        return payload.accountId;
      }).sort();
    };
    const check=async(actor:string,limited:boolean,expected:string[])=>{
      f.context.actor=actor;f.context.visibleIncident=limited?allowA:allowAll;
      for(const input of [{},{view:'history'}]){
        const result=await f.invoke('get_incidents',input);
        expect(result.isError).not.toBe(true);expect(ids(result)).toEqual(expected);
      }
      const result=await f.invoke('get_pending_incidents');
      const deliveries=result.structuredContent.deliveries as Array<{incident:Record<string,unknown>}>;
      expect(deliveries.map(item=>item.incident.accountId).sort()).toEqual(expected);
    };
    await check('broad',false,bothActive?['111111111111','222222222222']:['111111111111']);
    await check('limited-a',true,['111111111111']);
    if(bothActive){
      f.catalog.setConnectionState(f.suspended.id,'suspended');
      await check('after-suspension',false,['111111111111']);
      await check('limited-a-after',true,['111111111111']);
    }
  });

  it('filtra inventario suministrado, includeRetired y scopes antes de paginar o contar',async()=>{
    const f=fixture(),result=await f.invoke('list_resources',{includeRetired:true});
    const resources=result.structuredContent.resources as Array<{catalog:{accountId:string}}>;
    expect(resources.map(resource=>resource.catalog.accountId)).toEqual(['111111111111']);
    expect(result.structuredContent.totalMatched).toBe(1);
    expect(JSON.stringify(result.structuredContent.coverage)).not.toContain(f.suspended.id);
  });

  it('impide el fallback de get_resource aunque el contexto permita todo',async()=>{
    const f=fixture();f.context.inventory=async()=>[];
    for(const resourceId of [f.hidden.aliases[0],f.hidden.catalogId,`catalog:${f.hidden.catalogId}`]){
      const result=await f.invoke('get_resource',{resourceId});
      expect(result.isError).toBe(true);expect(JSON.stringify(result.structuredContent)).toContain('resource_not_found');
    }
    const allowed=await f.invoke('get_resource',{resourceId:f.shown.aliases[0]});
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed.structuredContent)).toContain('111111111111');
  });

  it('aplica la exclusión también a las vistas de incidentes y a las entregas',async()=>{
    const f=fixture();
    await f.invoke('get_pending_incidents');
    for(const record of [f.hidden,f.shown]){
      const resource={...f.catalog.asResource(record),name:record.connectionId===f.suspended.id?'suspended-incident':'active-incident',state:'stopped',observedAt:new Date().toISOString()};
      f.store.operational.setExpectation(resource.id,'always-on',0);
      f.store.operational.observeResources([resource]);
      f.store.appendEvent('incident',resource.id,{resourceId:resource.id,resourceName:resource.name,accountId:record.accountId,category:'ec2-state',from:'running',to:'stopped',source:'fixture'});
    }
    for(const input of [{},{view:'history'}]){
      const result=await f.invoke('get_incidents',input);
      expect(JSON.stringify(result.structuredContent)).toContain(f.shown.aliases[0]);
      expect(JSON.stringify(result.structuredContent)).not.toContain('suspended-incident');
    }
    const lease=vi.spyOn(f.store,'leaseIncidentDeliveries');
    const delivery=await f.invoke('get_pending_incidents');
    expect(lease).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(delivery.structuredContent)).not.toContain('suspended-incident');
    expect(JSON.stringify(delivery.structuredContent)).toContain(f.shown.aliases[0]);
  });

  it('lee el modelo de presupuesto y sus leases reales sin resolver agregados como recursos',async()=>{
    const f=fixture(true);
    await f.invoke('get_pending_incidents');
    const resolve=vi.spyOn(f.catalog,'resolveAlias'),reference=vi.spyOn(f.catalog,'isResourceReferenceActive');
    const active=appendCostBudgetIncident(f.store,{accountId:'111111111111',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'active-budget-'.padEnd(100,'a')});
    const suspended=appendCostBudgetIncident(f.store,{accountId:'222222222222',account:'S'.repeat(120),connectionId:f.suspended.id,budgetName:'suspended-budget-'.padEnd(100,'s')});
    expect(active.aggregateId).toHaveLength(228);expect(suspended.aggregateId).toHaveLength(228);
    for(const input of [{},{view:'current'},{view:'history'}]){
      const result=await f.invoke('get_incidents',input);
      expect(result.isError).not.toBe(true);
      // Budget threshold observations remain informational; current lists only
      // open/unknown incidents. Events and history retain the observation.
      if(input.view==='current')expect(JSON.stringify(result.structuredContent)).not.toContain(active.budgetName);
      else expect(JSON.stringify(result.structuredContent)).toContain(active.budgetName);
      expect(JSON.stringify(result.structuredContent)).not.toContain(suspended.budgetName);
    }
    const delivery=await f.invoke('get_pending_incidents');
    expect(JSON.stringify(delivery.structuredContent)).toContain(active.budgetName);
    expect(JSON.stringify(delivery.structuredContent)).not.toContain(suspended.budgetName);
    for(const aggregateId of [active.aggregateId,suspended.aggregateId]){
      expect(resolve).not.toHaveBeenCalledWith(aggregateId);
      expect(reference).not.toHaveBeenCalledWith(aggregateId);
    }
    const deliveries=delivery.structuredContent.deliveries as Array<{deliveryId:string;version:string;incident:Record<string,unknown>}>;
    const selected=deliveries.find(item=>item.incident.budgetName===active.budgetName)!;
    expect(selected).toBeDefined();
    const ack=await f.invoke('acknowledge_incident',{deliveryId:selected.deliveryId,version:selected.version});
    expect(ack.isError).not.toBe(true);
  });

  it('conserva la política del contexto para presupuestos sin usar aggregateId como permiso de recurso',async()=>{
    const f=fixture(true);
    const active=appendCostBudgetIncident(f.store,{accountId:'111111111111',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'active-policy-'.padEnd(100,'a')});
    const suspended=appendCostBudgetIncident(f.store,{accountId:'222222222222',account:'S'.repeat(120),connectionId:f.suspended.id,budgetName:'suspended-policy-'.padEnd(100,'s')});
    const policy=vi.fn((payload:Record<string,unknown>)=>payload.accountId==='222222222222');
    f.context.visibleIncident=policy;
    const result=await f.invoke('get_incidents');
    expect(JSON.stringify(result.structuredContent)).not.toContain(active.budgetName);
    expect(JSON.stringify(result.structuredContent)).not.toContain(suspended.budgetName);
    expect(policy.mock.calls.some(([payload])=>payload.accountId==='111111111111')).toBe(true);
    expect(policy.mock.calls.some(([payload])=>payload.accountId==='222222222222')).toBe(false);
  });

  it('no rescata presupuestos con referencia suspendida sin fila ni con accountId contradictorio',async()=>{
    const f=fixture(true);
    const hidden=appendCostBudgetIncident(f.store,{accountId:'111111111111',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'hidden-reference-'.padEnd(100,'a'),overrides:{resourceId:'aws:lab:i-unresolved'}});
    const wrong=appendCostBudgetIncident(f.store,{accountId:'111111111111',account:'A'.repeat(120),connectionId:f.suspended.id,budgetName:'wrong-connection-'.padEnd(100,'a')});
    const unknown=appendCostBudgetIncident(f.store,{accountId:'333333333333',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'unknown-account-'.padEnd(100,'a')});
    const projection=appendCostBudgetIncident(f.store,{accountId:'111111111111',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'projected-budget-'.padEnd(100,'a')});
    f.store.appendEvent('incident',projection.aggregateId,{...projection.payload,resourceId:projection.aggregateId});
    const reference=vi.spyOn(f.catalog,'isResourceReferenceActive');
    const result=await f.invoke('get_incidents');
    const text=JSON.stringify(result.structuredContent);
    expect(text).not.toContain(hidden.budgetName);expect(text).not.toContain(wrong.budgetName);expect(text).not.toContain(unknown.budgetName);
    expect(text).toContain(projection.budgetName);
    expect(reference).not.toHaveBeenCalledWith(projection.aggregateId);
  });
});
