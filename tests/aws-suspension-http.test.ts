import { afterEach, describe, expect, it } from 'vitest';
import { createServer, get, type Server } from 'node:http';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { CatalogRepository } from '../server/catalog.js';
import type { Store } from '../server/store.js';
import type { Adapter, Config } from '../server/types.js';
import { appendCostBudgetIncident } from './fixtures/aws-budget-events.js';
import { emitPhysicalBudgetAlerts } from './fixtures/physical-budget-alerts.js';

const ACTIVE='111111111111',SUSPENDED='222222222222';
const fixtures:Array<{app:ReturnType<typeof createApp>;server:Server}>=[];
async function fixture(ownerPolicy=false,longLabels=false,sharedLabels=false,bothActive=false){
  const config:Config={origin:'https://control.example.test',passwordHash:'fixture',agentTokens:[
    {name:'active-reader',hash:tokenHash('fixture-active'),scopes:['read'],readPolicy:{accountIds:[ACTIVE],costs:false}},
    {name:'suspended-reader',hash:tokenHash('fixture-suspended'),scopes:['read'],readPolicy:{accountIds:[SUSPENDED],costs:false}},
    {name:'unrestricted-reader',hash:tokenHash('fixture-unrestricted'),scopes:['read']},
    {name:'resource-reader',hash:tokenHash('fixture-resource'),scopes:['read'],readPolicy:{resourceIds:['aws:active:i-active'],costs:false}},
    ...(ownerPolicy?[{name:'Admin',hash:tokenHash('fixture-owner-agent'),scopes:['read'] as ('read'|'operate')[],readPolicy:{accountIds:[ACTIVE],costs:false}}]:[])
  ],aws:[
    {name:'active',displayName:sharedLabels?'Shared label':longLabels?'A'.repeat(120):undefined,accountId:ACTIVE,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[{id:'i-active',region:'us-east-1',name:'Active fixture',type:'t3.small'}]},
    {name:'lab',displayName:sharedLabels?'Shared label':longLabels?'S'.repeat(120):undefined,accountId:SUSPENDED,accessKeyId:'fixture-g',secretAccessKey:'fixture-g',enabled:bothActive,disabledReason:bothActive?undefined:'account_suspended',instances:[{id:'i-suspended',region:'us-east-1',name:'Suspended fixture',type:'t3.small'}]}
  ],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},services:[{key:'fixture-service',name:'Fixture service',criticality:'normal',relations:[
    {resourceId:'aws:lab:i-never-discovered',relationType:'depends_on',evidence:'operator_confirmed'},
    {resourceId:'aws:lab:i-suspended',relationType:'depends_on',evidence:'operator_confirmed'},
    {resourceId:'aws:active:i-active',relationType:'hosted_on',evidence:'operator_confirmed'}
  ]}]};
  const adapter:Adapter={inventory:async()=>[],localInventory:async()=>[],localSnapshot:()=>[],perform:async()=>{throw new Error('No operations in this test');}};
  const app=createApp(config,':memory:',adapter),server=createServer(app);fixtures.push({app,server});
  const catalog=app.locals.catalog as CatalogRepository,store=app.locals.store as Store;
  const active=catalog.connectionByAlias('aws','active')!,suspended=catalog.connectionByAlias('aws','lab')!;
  const observe=(id:string,accountId:string,profile:string,instanceId:string)=>catalog.reconcileScope(id,'aws:ec2:us-east-1',[{providerId:instanceId,resourceType:'ec2-instance',region:'us-east-1',name:profile==='active'?'Active fixture':'Suspended fixture',state:'running',detail:'fixture',observedAt:new Date().toISOString(),aliases:[`aws:${profile}:${instanceId}`,`aws:${accountId}:us-east-1:${instanceId}`]}],{complete:true,observedAt:new Date().toISOString()});
  observe(active.id,ACTIVE,'active','i-active');
  catalog.setConnectionState(suspended.id,'active');observe(suspended.id,SUSPENDED,'lab','i-suspended');catalog.setConnectionState(suspended.id,bothActive?'active':'suspended');
  store.addSession(tokenHash('fixture-owner-session'));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test listener');
  const port=address.port;
  const headers=(token?:string)=>({Host:'control.example.test','X-Forwarded-Proto':'https',...(token?{Authorization:`Bearer ${token}`}:{Cookie:'__Host-infra=fixture-owner-session'})});
  const json=(path:string,token?:string)=>new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{
    const request=get({hostname:'127.0.0.1',port,path,headers:headers(token)},response=>{
      let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode??0,body:JSON.parse(body)});}catch(error){reject(error);}});
    });request.on('error',reject);request.setTimeout(3000,()=>request.destroy(new Error('HTTP test timeout')));
  });
  const scopedCursors=new Map<string,string>();
  for(const token of ['fixture-active','fixture-suspended','fixture-resource',...(ownerPolicy?['fixture-owner-agent']:[])]){
    const snapshot=await json('/api/resources',token);expect(snapshot.status).toBe(200);expect(typeof snapshot.body.cursor).toBe('string');scopedCursors.set(token,snapshot.body.cursor as string);
  }
  const events=(cursor:number,token?:string)=>new Promise<string>((resolve,reject)=>{
    let settled=false,body='';
    const request=get({hostname:'127.0.0.1',port,path:`/api/events?cursor=${encodeURIComponent(token&&scopedCursors.get(token)||cursor)}`,headers:headers(token)},response=>{
      response.setEncoding('utf8');response.on('data',chunk=>{
        body+=chunk;
        const attention=body.indexOf('event: attention\n');
        if(attention>=0&&body.slice(attention).includes('\n\n')&&!settled){settled=true;resolve(body);response.destroy();request.destroy();}
      });response.on('error',error=>{if(!settled){settled=true;reject(error);}});response.on('end',()=>{if(!settled){settled=true;reject(new Error('SSE ended before snapshot'));}});
    });request.on('error',error=>{if(!settled){settled=true;reject(error);}});request.setTimeout(3000,()=>request.destroy(new Error('SSE test timeout')));
  });
  return {app,catalog,store,active,suspended,json,events};
}
afterEach(async()=>{for(const f of fixtures.splice(0)){f.app.locals.close();f.server.closeAllConnections();await new Promise<void>((resolve,reject)=>f.server.close(error=>error?reject(error):resolve()));}});

describe('proyecciones actuales e historia explícita',()=>{
  it.each([false,true])('etiquetas compartidas no silencian presupuestos por HTTP/SSE; ambas activas=%s',async bothActive=>{
    const f=await fixture(false,false,true,bothActive),cursor=f.store.latestEventId();
    const emitted=await emitPhysicalBudgetAlerts(f.store,[ACTIVE,SUSPENDED]);
    expect(emitted).toHaveLength(2);
    const accountIds=(wire:string)=>wire.split('\n\n').filter(frame=>frame.includes('event: incident\n')).flatMap(frame=>{
      const line=frame.split('\n').find(line=>line.startsWith('data: '));
      if(!line)return [];
      const payload=JSON.parse(line.slice(6)) as Record<string,unknown>;
      return payload.category==='budget'?[payload.accountId]:[];
    }).sort();
    for(const token of [undefined,'fixture-unrestricted']){
      expect((await f.json('/api/system/health',token)).status).toBe(200);
      expect(accountIds(await f.events(cursor,token))).toEqual(bothActive?[ACTIVE,SUSPENDED]:[ACTIVE]);
    }
    expect(accountIds(await f.events(cursor,'fixture-active'))).toEqual([ACTIVE]);
    if(bothActive){
      f.catalog.setConnectionState(f.suspended.id,'suspended');
      expect(accountIds(await f.events(cursor,'fixture-unrestricted'))).toEqual([ACTIVE]);
      expect(accountIds(await f.events(cursor,'fixture-active'))).toEqual([ACTIVE]);
    }
    expect(f.store.eventsAfter(cursor,250).filter(event=>event.type==='incident'&&event.payload.category==='budget')).toHaveLength(2);
  });

  it('oculta suspendidas en catálogo, inventario y scopes incluso con permiso de lectura explícito',async()=>{
    const f=await fixture();
    for(const path of ['/api/catalog/resources','/api/resources','/api/catalog/scopes']){
      const response=await f.json(path,'fixture-suspended');expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(SUSPENDED);
      const key=path.endsWith('scopes')?'scopes':'resources';expect(response.body[key]).toEqual([]);
    }
    const owner=await f.json('/api/catalog/resources');
    expect(JSON.stringify(owner.body)).toContain(ACTIVE);expect(JSON.stringify(owner.body)).not.toContain(SUSPENDED);
  });

  it('history=true permite historia personal y no amplía el acceso de agentes',async()=>{
    const f=await fixture();
    const owner=await f.json('/api/catalog/resources?history=true');
    expect(JSON.stringify(owner.body)).toContain(SUSPENDED);
    const ownerScopes=await f.json('/api/catalog/scopes?history=true');expect(JSON.stringify(ownerScopes.body)).toContain(f.suspended.id);
    for(const token of ['fixture-suspended','fixture-unrestricted','fixture-active']){
      const response=await f.json('/api/catalog/resources?history=true',token);
      expect(response.status).toBe(200);expect(JSON.stringify(response.body)).not.toContain(SUSPENDED);
      const scopes=await f.json('/api/catalog/scopes?history=true',token);expect(JSON.stringify(scopes.body)).not.toContain(f.suspended.id);
    }
  });

  it('la lectura histórica personal sigue aplicando readPolicy y no autoriza un Bearer llamado Admin',async()=>{
    const f=await fixture(true);
    const owner=await f.json('/api/catalog/resources?history=true');expect(JSON.stringify(owner.body)).not.toContain(SUSPENDED);
    const agent=await f.json('/api/catalog/resources?history=true','fixture-owner-agent');expect(JSON.stringify(agent.body)).not.toContain(SUSPENDED);
    const services=await f.json('/api/catalog/services?history=true');expect(JSON.stringify(services.body)).not.toContain('aws:lab:');
  });

  it('filtra relaciones suspendidas sin resolver y conserva su lectura histórica personal',async()=>{
    const f=await fixture();
    expect(f.catalog.resolveAlias('aws:lab:i-never-discovered')).toBeUndefined();
    const current=await f.json('/api/catalog/services');
    expect(JSON.stringify(current.body)).not.toContain('aws:lab:');
    expect(JSON.stringify(current.body)).toContain('aws:active:i-active');
    const history=await f.json('/api/catalog/services?history=true');
    expect(JSON.stringify(history.body)).toContain('aws:lab:i-never-discovered');
    expect(JSON.stringify(history.body)).toContain('aws:lab:i-suspended');
    const agent=await f.json('/api/catalog/services?history=true','fixture-unrestricted');
    expect(JSON.stringify(agent.body)).not.toContain('aws:lab:');
  });

  it('el replay SSE no reenvía recursos ni cobertura suspendidos al propietario o agentes',async()=>{
    const f=await fixture(),cursor=f.store.latestEventId();
    const records=f.catalog.listResources({includeRetired:true});
    const suspended=records.find(record=>record.accountId===SUSPENDED)!,active=records.find(record=>record.accountId===ACTIVE)!;
    f.store.appendEvent('resource',`catalog:${suspended.catalogId}`,{catalogId:suspended.catalogId,accountId:SUSPENDED,replayMarker:'suspended-resource'});
    f.store.appendEvent('coverage',`coverage:${f.suspended.id}:aws:ec2:us-east-1`,{connectionId:f.suspended.id,scopeKey:'aws:ec2:us-east-1',resourceCount:999,replayMarker:'suspended-coverage'});
    f.store.appendEvent('resource',`catalog:${active.catalogId}`,{catalogId:active.catalogId,replayMarker:'active-resource'});
    for(const token of [undefined,'fixture-unrestricted','fixture-suspended']){
      const replay=await f.events(cursor,token);
      expect(replay).not.toContain('suspended-resource');expect(replay).not.toContain('suspended-coverage');
      expect(replay).not.toContain(SUSPENDED);
      if(token!=='fixture-suspended')expect(replay).toContain('active-resource');
      else expect(replay).not.toContain('active-resource');
    }
    expect(f.store.eventsAfter(cursor,250).some(event=>event.payload.replayMarker==='suspended-resource')).toBe(true);
  });

  it('presupuestos de 228 caracteres no rompen HTTP ni SSE y respetan la cuenta autorizada',async()=>{
    const f=await fixture(false,true),cursor=f.store.latestEventId();
    const active=appendCostBudgetIncident(f.store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:f.active.id,budgetName:'active-budget-'.padEnd(100,'a')});
    const suspended=appendCostBudgetIncident(f.store,{accountId:SUSPENDED,account:'S'.repeat(120),connectionId:f.suspended.id,budgetName:'suspended-budget-'.padEnd(100,'s')});
    expect(active.aggregateId).toHaveLength(228);expect(suspended.aggregateId).toHaveLength(228);
    for(const token of [undefined,'fixture-unrestricted','fixture-active']){
      expect((await f.json('/api/system/health',token)).status).toBe(200);
      const replay=await f.events(cursor,token);
      expect(replay).toContain(active.budgetName);
      expect(replay).not.toContain(suspended.budgetName);
    }
    const restricted=await f.events(cursor,'fixture-suspended');
    expect(restricted).not.toContain(active.budgetName);expect(restricted).not.toContain(suspended.budgetName);
    expect(f.store.eventsAfter(cursor,250).filter(event=>[active.aggregateId,suspended.aggregateId].includes(event.aggregateId))).toHaveLength(2);
  });

  it('un permiso de recurso no concede presupuestos mediante metadata falsa',async()=>{
    const f=await fixture(false,true),cursor=f.store.latestEventId();
    const budget=appendCostBudgetIncident(f.store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:f.active.id,budgetName:'resource-spoof-'.padEnd(100,'a'),overrides:{resourceId:'aws:active:i-active',scopeKey:'aws:ec2:us-east-1'}});
    const replay=await f.events(cursor,'fixture-resource');
    expect(replay).not.toContain(budget.budgetName);
    expect(await f.events(cursor,'fixture-active')).toContain(budget.budgetName);
  });

  it('mantiene el gate de referencias explícitas sin fila y rechaza identidades contradictorias',async()=>{
    const f=await fixture(false,true),cursor=f.store.latestEventId();
    const hiddenReference=appendCostBudgetIncident(f.store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:f.active.id,budgetName:'hidden-host-'.padEnd(100,'a'),overrides:{resourceId:'aws:lab:i-never-discovered'}});
    const contradictory=appendCostBudgetIncident(f.store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:f.suspended.id,budgetName:'wrong-connection-'.padEnd(100,'a')});
    const unknown=appendCostBudgetIncident(f.store,{accountId:'333333333333',account:'A'.repeat(120),connectionId:f.active.id,budgetName:'unknown-account-'.padEnd(100,'a')});
    const projection=appendCostBudgetIncident(f.store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:f.active.id,budgetName:'projected-budget-'.padEnd(100,'a')});
    f.store.appendEvent('incident',projection.aggregateId,{...projection.payload,resourceId:projection.aggregateId});
    const replay=await f.events(cursor,'fixture-active');
    expect(replay).not.toContain(hiddenReference.budgetName);
    expect(replay).not.toContain(contradictory.budgetName);
    expect(replay).not.toContain(unknown.budgetName);
    expect(replay).toContain(projection.budgetName);
  });

  it('identificadores de cobertura largos se filtran por su conexión, no como aliases',async()=>{
    const f=await fixture(),cursor=f.store.latestEventId();
    const activeAggregate='scope:'+ 'a'.repeat(222),suspendedAggregate='scope:'+'s'.repeat(222);
    f.store.appendEvent('coverage',activeAggregate,{connectionId:f.active.id,scopeKey:'aws:ec2:us-east-1',replayMarker:'active-long-coverage'});
    f.store.appendEvent('coverage',suspendedAggregate,{connectionId:f.suspended.id,scopeKey:'aws:ec2:us-east-1',accountId:ACTIVE,replayMarker:'suspended-long-coverage'});
    const replay=await f.events(cursor,'fixture-active');
    expect(replay).toContain('active-long-coverage');expect(replay).not.toContain('suspended-long-coverage');
    const denied=await f.events(cursor,'fixture-suspended');
    expect(denied).not.toContain('active-long-coverage');expect(denied).not.toContain('suspended-long-coverage');
  });
});
