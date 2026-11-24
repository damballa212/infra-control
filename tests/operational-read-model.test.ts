import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import { SecretsService } from '../server/secrets.js';
import { MemoryVault } from '../server/secrets-vault.js';
import { LiveState } from '../design/handoff/ui/src/lib/liveState.ts';
import type { Config, Resource } from '../server/types.js';
const closers:Array<()=>void>=[],origin='https://control.example.test',token='scoped-reader';
const resource=(id='computer:desktop'):Resource=>({id,name:id,kind:'computer',state:'running',account:'test',location:'test',detail:'fixture',actions:['start','stop','boot-windows','boot-cachyos'],observedAt:new Date().toISOString()});
const allow=()=>true;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));});
afterEach(()=>{closers.splice(0).reverse().forEach(close=>close());vi.useRealTimers();});
function database(path=':memory:'){const store=new Store(path);closers.push(()=>store.close());return store;}
function terminal(store:Store,key:string,id:string,action:'stop'|'start'|'boot-cachyos'|'boot-windows'|'refresh'='stop',state:'failed'|'uncertain'|'succeeded'='uncertain') {const operation=store.create('worker',key,'fp',resource(id),action);store.update(operation.id,state,key);return store.get(operation.id)!;}
function appFixture(){
  const policy={resourceIds:['computer:visible']};
  const config:Config={origin,passwordHash:'unused',agentTokens:[{name:'reader',hash:tokenHash(token),scopes:['read','operate'],mcpTools:['get_pending_incidents','acknowledge_incident','get_incidents'],readPolicy:policy}],aws:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''}};
  const app=createApp(config,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});closers.push(()=>app.locals.close());
  const cookie='fixture-human-session';app.locals.store.addSession(tokenHash(cookie));return {app,policy,auth:{Authorization:`Bearer ${token}`},cookie:`__Host-infra=${cookie}`};
}
describe('revisión, identidad y ejecución',()=>{
  it('una decisión posterior de energía sustituye revisión sin reescribir uncertain; refresh no la sustituye',()=>{
    const store=database(),old=terminal(store,'old','computer:desktop','boot-cachyos');
    terminal(store,'refresh','computer:desktop','refresh','succeeded');expect(store.get(old.id)!.review!.disposition).toBe('pending');
    const newer=terminal(store,'windows','computer:desktop','boot-windows','succeeded');
    expect(store.get(old.id)).toMatchObject({state:'uncertain',review:{disposition:'superseded',supersededByOperationId:newer.id,reason:'later_confirmed_new_power_intention'}});
    store.update(old.id,'succeeded','late result');expect(store.get(old.id)!.state).toBe('uncertain');
  });
  it('une aliases solo al obtener evidencia de catálogo y conserva revisión humana tras reinicio',()=>{
    const directory=mkdtempSync(join(tmpdir(),'operational-review-')),path=join(directory,'infra.sqlite');
    const first=new Store(path),catalog=new CatalogRepository(first);
    const old=terminal(first,'old','legacy:first');const newer=terminal(first,'new','legacy:second','start','succeeded');
    expect(first.get(old.id)!.review!.disposition).toBe('pending');
    const connection=catalog.registerConnection({provider:'aws',providerAccountId:'123456789012',name:'one',credentialRef:'fixture'});
    catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[{providerId:'i-test',resourceType:'ec2-instance',region:'us-east-1',name:'Host',state:'running',detail:'fixture',observedAt:new Date().toISOString(),aliases:['legacy:first','legacy:second']}],{complete:true,observedAt:new Date().toISOString()});
    expect(first.get(old.id)!.review).toMatchObject({disposition:'superseded',supersededByOperationId:newer.id});
    const review=terminal(first,'human','computer:other');const version=review.review!.version;
    first.operational.markReviewed(review.id,version,'accepted_uncertainty');first.operational.markReviewed(review.id,version,'accepted_uncertainty');
    expect(first.db.prepare("SELECT COUNT(*) AS count FROM operation_review_audit WHERE operation_id=? AND kind='reviewed'").get(review.id)).toMatchObject({count:1});first.close();
    const second=new Store(path);expect(second.get(review.id)).toMatchObject({state:'uncertain',review:{disposition:'reviewed',reviewedBy:'Admin'}});second.close();rmSync(directory,{recursive:true,force:true});
  });
  it('una lectura atrasada no borra revisión nueva en LiveState',()=>{
    const store=database(),operation=terminal(store,'review','computer:desktop');const live=new LiveState();live.attach(operation);const started=live.begin();
    const reviewed=store.operational.markReviewed(operation.id,operation.review!.version,'checked_state');live.attach(reviewed,10);live.acceptOperations({operations:[operation]},started);live.acceptOperationRead(operation,started);
    expect(live.activity()!.operations[0]!.review!.disposition).toBe('reviewed');
  });
});
describe('páginas autorizadas y rutas reales',()=>{
  it('más de cien órdenes ajenas no ocultan actividad o revisión visible; filtra antes del límite',async()=>{
    vi.useRealTimers();const {app,auth}=appFixture(),store=app.locals.store as Store;
    const review=terminal(store,'visible-review','computer:visible');const active=store.create('worker','visible-active','fp',resource('computer:visible'),'refresh');
    for(let index=0;index<125;index++)terminal(store,`hidden-${index}`,'computer:hidden','stop','failed');
    expect((await request(app).get('/api/operations/review?limit=1').set(auth)).body.operations.map((value:any)=>value.id)).toEqual([review.id]);
    expect((await request(app).get('/api/operations/active').set(auth)).body.operations.map((value:any)=>value.id)).toEqual([active.id]);
    const health=(await request(app).get('/api/system/health').set(auth)).body;expect(health.operations).toMatchObject({visible:2,active:1,uncertain:1,failed:0});expect(health.cloud).toBeUndefined();expect(health.cloudEvents).toBeUndefined();
    const page=(await request(app).get('/api/operations?limit=1&actor=worker&state=uncertain&q=visible-review').set(auth)).body;expect(page.operations).toHaveLength(1);expect(page.hasMore).toBe(false);
  });
  it('mantiene claves estables con fechas iguales e inserciones nuevas y rechaza cursores ajenos o malformados',async()=>{
    vi.useRealTimers();const {app,auth,policy}=appFixture(),store=app.locals.store as Store;
    for(let index=0;index<7;index++)terminal(store,`row-${index}`,'computer:visible','refresh','succeeded');
    const first=(await request(app).get('/api/operations?limit=2').set(auth)).body;expect(first.hasMore).toBe(true);
    const inserted=terminal(store,'new-after-bound','computer:visible','refresh','succeeded');
    const ids=first.operations.map((value:any)=>value.id);let cursor=first.nextCursor;
    while(cursor){const page=(await request(app).get('/api/operations').query({limit:2,cursor}).set(auth)).body;ids.push(...page.operations.map((value:any)=>value.id));cursor=page.nextCursor;}
    expect(ids).toHaveLength(7);expect(new Set(ids).size).toBe(7);expect(ids).not.toContain(inserted.id);
    expect((await request(app).get('/api/operations?cursor=bad').set(auth)).status).toBe(400);
    expect((await request(app).get('/api/operations/review').query({cursor:first.nextCursor}).set(auth)).status).toBe(400);
    policy.resourceIds=[];expect((await request(app).get('/api/operations').query({cursor:first.nextCursor}).set(auth)).status).toBe(400);
  });
  it('solo la sesión humana puede revisar con Origin exacto',async()=>{
    vi.useRealTimers();const {app,auth,cookie}=appFixture(),store=app.locals.store as Store,operation=terminal(store,'review','computer:visible');
    const body={expectedVersion:operation.review!.version,reason:'checked_state'};
    expect((await request(app).post(`/api/operations/${operation.id}/review`).set(auth).set('Origin',origin).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/operations/${operation.id}/review`).set('Cookie',cookie).send(body)).status).toBe(403);
    const reviewed=await request(app).post(`/api/operations/${operation.id}/review`).set('Cookie',cookie).set('Origin',origin).send(body);expect(reviewed.status).toBe(200);expect(reviewed.body).toMatchObject({state:'uncertain',review:{disposition:'reviewed'}});
  });
});
describe('ciclo operacional y privacidad',()=>{
  it('persiste open→unknown→resolved; el ACK de entrega y el reconocimiento no fabrican recuperación',()=>{
    const store=database();let now=Date.now();
    store.leaseIncidentDeliveries('consumer',10,now);
    const sample=(state:'unhealthy'|'unknown'|'healthy')=>store.recordServiceProbe('computer:visible',{state,source:'https-probe',observedAt:new Date(now).toISOString(),freshUntil:new Date(now+120000).toISOString(),reasonCode:state==='healthy'?'probe_http_ok':state==='unhealthy'?'probe_unexpected_http_status':'probe_timeout'},now);
    sample('unhealthy');let incident=store.operational.incidentPage({view:'current'},'owner',allow).incidents[0]!;expect(incident.status).toBe('open');
    const delivery=store.leaseIncidentDeliveries('consumer',10,now).deliveries[0]!;store.acknowledgeIncidentDelivery('consumer',delivery.id,delivery.version,now);
    incident=store.operational.acknowledge(incident.id,incident.version);expect(incident.status).toBe('open');expect(incident.acknowledgement).toBeDefined();
    now+=1000;sample('unknown');expect(store.operational.getIncident(incident.id)!.status).toBe('unknown');now+=1000;sample('healthy');
    expect(store.operational.getIncident(incident.id)).toMatchObject({status:'resolved',recoveryEventId:expect.any(Number)});
  });
  it('un cambio cloud sin obligación es información; una obligación explícita es independiente de ACK',()=>{
    const store=database(),host={...resource('aws:one:i-test'),kind:'ec2' as const,state:'stopped'};
    store.appendEvent('incident',host.id,{category:'infrastructure',resourceId:host.id,from:'running',to:'stopped',transitionReason:'provider_state_changed'});
    expect(store.operational.summary(allow,allow).attentionGroups).toBe(0);
    store.operational.setExpectation(host.id,'always-on',0);store.operational.observeResources([host]);expect(store.operational.summary(allow,allow).attentionGroups).toBe(1);
    const stop=terminal(store,'intended',host.id,'stop','succeeded');expect(stop.state).toBe('succeeded');store.operational.observeResources([host]);expect(store.operational.summary(allow,allow).attentionGroups).toBe(0);
  });
  it('no cuenta entregas privadas, incluso después de reducir la política del mismo consumidor',()=>{
    const store=database();store.leaseIncidentDeliveries('consumer');store.appendEvent('incident','computer:hidden',{category:'service',resourceId:'computer:hidden'});store.appendEvent('incident','computer:visible',{category:'service',resourceId:'computer:visible'});
    const deliveries=store.leaseIncidentDeliveries('consumer').deliveries;store.db.prepare("UPDATE mcp_incident_deliveries SET status='dead' WHERE id=?").run(deliveries.find(value=>value.payload.resourceId==='computer:hidden')!.id);
    const visible=(payload:Record<string,unknown>)=>payload.resourceId==='computer:visible';expect(store.incidentDeliveryHealth('consumer',visible)).toMatchObject({leased:1,dead:0});expect(store.leaseIncidentDeliveries('consumer',10,Date.now(),120000,visible).deadLetterCount).toBe(0);
    const hidden=deliveries.find(value=>value.payload.resourceId==='computer:hidden')!;expect(store.acknowledgeIncidentDelivery('consumer',hidden.id,hidden.version,Date.now(),visible)).toBe('not_found');
  });
});
describe('secretos: historia y pendientes independientes',()=>{
  it('recorre más de doscientos eventos desde el más reciente sin duplicados y conserva pendientes fuera de historia',()=>{
    const store=database(),service=new SecretsService(store,new MemoryVault());
    const input={name:'KEY',project:'project',machine:'test',reason:'test',destination:{kind:'process' as const}};
    const pending=service.create('worker',{projects:['project']},input,'pending');
    for(let index=0;index<230;index++){const request=service.create('other',{projects:['project']},input,`request-${index}`);service.deny(request.id);}
    const first=service.auditPage({limit:100},'owner');const ids=first.events.map(value=>value.id);let cursor=first.nextCursor;
    expect(first.events[0]!.id).toBe(461);
    while(cursor){const page=service.auditPage({limit:100,cursor},'owner');ids.push(...page.events.map(value=>value.id));cursor=page.nextCursor;}
    expect(ids).toHaveLength(461);expect(new Set(ids).size).toBe(461);
    expect(service.requestPage({state:'pending',limit:25},'owner:pending')).toMatchObject({requests:[expect.objectContaining({id:pending.id})],pendingCount:1,hasMore:false});
    expect(JSON.stringify(service.requestPage({limit:25},'owner'))).not.toMatch(/item_ref|payload_hash|idem_key/);
  });
});
