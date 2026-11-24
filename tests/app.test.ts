import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { hashPassword, tokenHash } from '../server/auth.js';
import { Store } from '../server/store.js';
import type { Resource, Adapter, Config } from '../server/types.js';
import { DesktopOfflineError } from '../server/operation-error.js';

const origin = 'https://control.example.test';
const resource: Resource = { id: 'aws:test:server', name: 'Servidor', kind: 'ec2', state: 'running', location: 'us-east-1', detail: 't3.small', account: 'test', actions: ['stop', 'refresh'], observedAt: new Date().toISOString() };
let config: Config;
const apps: ReturnType<typeof createApp>[] = [];
beforeAll(async () => { config = { origin, passwordHash: await hashPassword('una-clave-de-prueba-larga'), agentTokens: [{ name: 'test-agent', hash: tokenHash('test-agent-secret'), scopes: ['read', 'operate'], operationPolicy: { actions: ['start', 'stop', 'refresh', 'boot-windows', 'boot-cachyos'], resourceIds: [resource.id, 'computer:desktop'] } }], aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' } }; });
afterEach(() => { for (const app of apps.splice(0)) app.locals.close(); });
function setup(adapter?: Adapter) {
  const app = createApp(config, ':memory:', adapter ?? { inventory: async () => [resource], perform: async () => ({ message: 'Estado confirmado.' }) });
  apps.push(app); return app;
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
const bearer = { Authorization: 'Bearer test-agent-secret' };
describe('acceso y sesiones', () => {
  it('protege datos, operaciones y documentación', async () => {
    const app = setup();
    for (const path of ['/api/resources', '/api/operations', '/api/openapi.json']) expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });
  it('rechaza credenciales incorrectas y origen ajeno', async () => {
    const app = setup();
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' })).status).toBe(403);
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'wrong' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'admin', password: 'una-clave-de-prueba-larga' })).status).toBe(403);
  });
  it('usa cookies seguras, no cachea API y revoca sesión al salir', async () => {
    const app = setup(); const cookie = await login(app);
    const response = await request(app).get('/api/resources').set('Cookie', cookie);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toContain('no-store');
    const auth = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-de-prueba-larga' });
    expect(auth.headers['set-cookie'][0]).toMatch(/HttpOnly/); expect(auth.headers['set-cookie'][0]).toMatch(/Secure/); expect(auth.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie).set('Origin', origin)).status).toBe(200);
    expect((await request(app).get('/api/resources').set('Cookie', cookie)).status).toBe(401);
  });
  it('expone el catálogo con cobertura y alias sin filtrar credenciales y conserva acciones legacy', async () => {
    const cloudConfig: Config = { ...config, aws: [{ name: 'test', accountId: '123456789012', accessKeyId: 'do-not-return-access-key', secretAccessKey: 'do-not-return-secret', instances: [{ id: 'server', region: 'us-east-1', name: 'Servidor', type: 't3.small' }] }] };
    const app = createApp(cloudConfig, ':memory:', { inventory: async () => [resource], perform: async () => ({ message: 'ok' }) });
    apps.push(app);
    expect((await request(app).get('/api/catalog/connections').set(bearer)).status).toBe(200);
    const connections = await request(app).get('/api/catalog/connections').set(bearer);
    expect(connections.body.connections).toHaveLength(1);
    expect(JSON.stringify(connections.body)).not.toContain('do-not-return');
    expect(JSON.stringify(connections.body)).not.toContain('credential');

    const snapshot = await request(app).get('/api/resources').set(bearer);
    expect(snapshot.body.resources[0]).toMatchObject({ id: resource.id, state: 'running', actions: ['stop', 'refresh'], catalog: { accountId: '123456789012', lifecycle: 'active' } });
    expect((await request(app).get('/api/catalog/scopes').set(bearer)).body.scopes).toEqual([]);
    expect((await request(app).get('/api/catalog/projects').set(bearer)).body.projects).toEqual([]);
  });
  it('arranca el descubrimiento Coolify con la conexión registrada y actualiza los aliases legacy sin duplicarlos',async()=>{
    const fetcher=vi.fn(async()=>Response.json([
      {uuid:'legacy-app',name:'Renamed App',type:'application',status:'running:healthy'},
      {uuid:'discovered-service',name:'New Service',type:'service',status:'running:healthy'}
    ]));
    vi.stubGlobal('fetch',fetcher);
    try{
      const app=createApp({...config,coolify:{url:'https://coolify.example',token:'fixture-token',resources:[{uuid:'legacy-app',name:'Old Name',type:'application'}]}},':memory:');apps.push(app);
      const legacyId=app.locals.catalog.resolveAlias('coolify:legacy-app').catalogId;
      await vi.waitFor(()=>expect(app.locals.catalog.listResources()).toHaveLength(2),{timeout:3000});
      expect(app.locals.catalog.resolveAlias('coolify:legacy-app')).toMatchObject({catalogId:legacyId,name:'Renamed App',state:'running:healthy'});
      expect(app.locals.catalog.listScopes()).toEqual([expect.objectContaining({scopeKey:'coolify:resources',state:'healthy',resourceCount:2})]);
      for(let i=0;i<2;i++)expect((await request(app).get('/api/resources').set(bearer)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith('https://coolify.example/api/v1/resources',expect.any(Object));
    }finally{vi.unstubAllGlobals();}
  });
  it('expone servicios y relaciones explícitas filtrando identidades fuera del readPolicy', async()=>{
    const secret='service-scoped-reader';
    const serviceConfig:Config={...config,aws:[{name:'services',accountId:'555555555555',accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
      {id:'i-visible',region:'us-east-1',name:'visible-host',type:'t3.small'},{id:'i-hidden',region:'us-east-1',name:'hidden-host',type:'t3.small'}
    ]}],agentTokens:[{name:'service-reader',hash:tokenHash(secret),scopes:['read'],readPolicy:{resourceIds:['aws:services:i-visible']}}],services:[
      {key:'visible-app',name:'Visible App',criticality:'high',relations:[{resourceId:'aws:services:i-visible',relationType:'hosted_on',evidence:'operator_confirmed'}]},
      {key:'private-app',name:'Private App',criticality:'critical',relations:[{resourceId:'aws:services:i-hidden',relationType:'hosted_on',evidence:'operator_confirmed'}]}
    ]};
    const app=createApp(serviceConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const response=await request(app).get('/api/catalog/services').set('Authorization',`Bearer ${secret}`);
    expect(response.status).toBe(200);
    expect(response.body.services).toHaveLength(1);
    expect(response.body.services[0]).toMatchObject({key:'visible-app',relations:[{resourceAlias:'aws:services:i-visible',resolved:true,evidence:'operator_confirmed'}]});
    expect(JSON.stringify(response.body)).not.toContain('private-app');
    expect(JSON.stringify(response.body)).not.toContain('i-hidden');
  });
  it('permite ver el proyecto sin revelar relaciones a recursos fuera del readPolicy',async()=>{
    const secret='service-project-scoped-reader',projectIds:string[]=[];
    const scopedConfig:Config={...config,aws:[{name:'restricted',accountId:'777777777777',accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
      {id:'i-private',region:'us-east-1',name:'private-host-secret',type:'t3.small'}
    ]}],agentTokens:[{name:'project-reader',hash:tokenHash(secret),scopes:['read'],readPolicy:{projectIds}}],services:[
      {key:'private-backend',name:'Private Backend',projectKey:'internal-project',projectName:'Internal Project',criticality:'high',relations:[
        {resourceId:'aws:restricted:i-private',relationType:'hosted_on',evidence:'operator_confirmed'}
      ]}
    ]};
    const app=createApp(scopedConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const project=app.locals.catalog.listProjects().find((item:{id:string;name:string})=>item.name==='Internal Project');
    expect(project).toBeDefined();projectIds.push(project!.id);
    const response=await request(app).get('/api/catalog/services').set('Authorization',`Bearer ${secret}`);
    expect(response.status).toBe(200);
    expect(response.body.services).toHaveLength(1);
    expect(response.body.services[0]).toMatchObject({key:'private-backend',relations:[]});
    expect(JSON.stringify(response.body)).not.toContain('aws:restricted:i-private');
    expect(JSON.stringify(response.body)).not.toContain('private-host-secret');
  });
  it('desactiva servicios persistidos cuando la configuración ya no declara services',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'infra-services-restart-'));
    const dbPath=join(directory,'catalog.sqlite'),adapter={inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})};
    const first=createApp({...config,services:[{key:'retired-config-service',name:'Retired Config Service',criticality:'normal',relations:[]}]},dbPath,adapter);apps.push(first);
    expect((await request(first).get('/api/catalog/services').set(bearer)).body.services).toHaveLength(1);
    first.locals.close();apps.splice(apps.indexOf(first),1);
    const second=createApp({...config,services:undefined},dbPath,adapter);apps.push(second);
    expect((await request(second).get('/api/catalog/services').set(bearer)).body.services).toEqual([]);
    second.locals.close();apps.splice(apps.indexOf(second),1);
    rmSync(directory,{recursive:true,force:true});
  });
  it('sirve el snapshot de inventario sin invocar el adaptador de proveedores por petición', async () => {
    const local: Resource = { id: 'computer:mac', name: 'MacBook', kind: 'computer', state: 'running', location: 'macOS', account: 'Personal', detail: 'Apple Silicon', actions: [], observedAt: new Date().toISOString() };
    const inventory = vi.fn(async () => [resource]);
    const localInventory = vi.fn(async () => [local]);
    const app = setup({ inventory, localInventory, perform: async () => ({ message: 'ok' }) });
    const response = await request(app).get('/api/resources').set(bearer);
    expect(response.status).toBe(200);
    expect(response.body.resources).toEqual([local]);
    expect(localInventory).toHaveBeenCalledTimes(1);
    expect(inventory).not.toHaveBeenCalled();
  });
  it('aplica readPolicy a recursos, conexiones, cobertura, proyectos y costes sin consultar AWS por petición', async () => {
    const firstId='111111111111',secondId='222222222222',secret='scoped-reader-secret';
    const scopedConfig:Config={...config,aws:[
      {name:'first',accountId:firstId,accessKeyId:'fixture',secretAccessKey:'fixture'},
      {name:'second',accountId:secondId,accessKeyId:'fixture',secretAccessKey:'fixture'}
    ],agentTokens:[{name:'scoped-reader',hash:tokenHash(secret),scopes:['read'],mcpTools:['list_resources','get_cost_summary'],readPolicy:{accountIds:[firstId],costs:true}}]};
    const app=createApp(scopedConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const connections=app.locals.catalog.connections();
    for(const [index,connection] of connections.entries())app.locals.catalog.reconcileScope(connection.id,`aws:ec2:us-east-${index+1}`,[{
      providerId:`i-${index+1}`,resourceType:'ec2-instance',region:`us-east-${index+1}`,name:`server-${index+1}`,state:'running',detail:'t3.small',observedAt:new Date().toISOString(),tags:{Project:`project-${index+1}`}
    }],{complete:true,observedAt:new Date().toISOString()});
    app.locals.store.putCache('costs-v1',{accounts:[{account:'first',accountId:firstId,status:'available',net:1},{account:'second',accountId:secondId,status:'available',net:2}],fetchedAt:'now',nextRefreshAt:'later',periodStart:'2026-10-01',periodEnd:'2026-10-23',policy:'cache'},86400000);

    const auth={Authorization:`Bearer ${secret}`};
    expect((await request(app).get('/api/resources').set(auth)).body.resources.map((item:{name:string})=>item.name)).toEqual(['server-1']);
    expect((await request(app).get('/api/catalog/resources?history=true').set(auth)).body.resources).toHaveLength(1);
    expect((await request(app).get('/api/catalog/connections').set(auth)).body.connections.map((item:{providerAccountId:string})=>item.providerAccountId)).toEqual([firstId]);
    expect((await request(app).get('/api/catalog/scopes').set(auth)).body.scopes).toHaveLength(1);
    expect((await request(app).get('/api/catalog/projects').set(auth)).body.projects.map((item:{name:string})=>item.name)).toEqual(['project-1']);
    expect((await request(app).get('/api/costs').set(auth)).body.accounts.map((item:{accountId:string})=>item.accountId)).toEqual([firstId]);
    const health=(await request(app).get('/api/system/health').set(auth)).body;
    expect(health.catalog).toMatchObject({resources:1,scopes:1,healthyScopes:1});
    expect(health.eventLog).toBeUndefined();
  });
  it('limita los conteos de cobertura al conjunto de recursos visible por readPolicy', async () => {
    const secret='resource-only-coverage-secret',accountId='333333333333';
    const scopedConfig:Config={...config,aws:[{name:'three',accountId,accessKeyId:'fixture',secretAccessKey:'fixture'}],agentTokens:[{name:'resource-reader',hash:tokenHash(secret),scopes:['read'],readPolicy:{resourceIds:['aws:three:i-visible']}}]};
    const app=createApp(scopedConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const connection=app.locals.catalog.connections()[0];
    for(const [region,instanceId] of [['us-east-1','i-visible'],['us-east-2','i-hidden']])app.locals.catalog.reconcileScope(connection.id,`aws:ec2:${region}`,[{
      providerId:instanceId,resourceType:'ec2-instance',region,name:instanceId,state:'running',detail:'t3.small',observedAt:new Date().toISOString(),aliases:[`aws:three:${instanceId}`]
    }],{complete:true,observedAt:new Date().toISOString()});
    const auth={Authorization:`Bearer ${secret}`};
    const scopes=(await request(app).get('/api/catalog/scopes').set(auth)).body.scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({scopeKey:'aws:ec2:us-east-1',resourceCount:1});
    expect((await request(app).get('/api/system/health').set(auth)).body.catalog.scopes).toBe(1);
  });
  it('recibe OTLP por identidad host, persiste la observación y la agrega al snapshot sin consultar AWS',async()=>{
    const secret='otel-host-private-token',hostId='host-home-vps',resourceId='aws:one:i-otel',accountId='444444444444';
    const otelConfig:Config={...config,aws:[{name:'one',accountId,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[{id:'i-otel',region:'us-east-1',name:'Telemetry host',type:'t3.small'}]}],otelCollectors:[{hostId,resourceId,tokenHash:tokenHash(secret).toUpperCase()}]};
    const inventory=vi.fn(async()=>{throw new Error('cloud inventory must not run');}),localInventory=vi.fn(async()=>[]);
    const app=createApp(otelConfig,':memory:',{inventory,localInventory,perform:async()=>({message:'unused'})});apps.push(app);
    const observedAt=Date.now()-1000,timeUnixNano=String(BigInt(observedAt)*1_000_000n);
    const sample=(identity:string)=>({resourceMetrics:[{resource:{attributes:[{key:'host.id',value:{stringValue:identity}}]},scopeMetrics:[{metrics:[{name:'system.cpu.utilization',gauge:{dataPoints:[{timeUnixNano,attributes:[],asDouble:0.25}]}}]}]}]});
    const send=(identity:string,token=secret)=>request(app).post('/api/telemetry/otlp/v1/metrics').set('Authorization',`Bearer ${token}`).send(sample(identity));
    expect((await request(app).post('/api/telemetry/otlp/v1/metrics').set('Origin',origin).send(sample(hostId))).status).toBe(401);
    expect((await send('host-copied-token')).status).toBe(403);
    const accepted=await send(hostId);
    expect(accepted.status).toBe(200);
    expect(app.locals.store.hostTelemetry(resourceId)?.sample.cpu).toMatchObject({percent:25,observedAt:new Date(observedAt).toISOString()});
    expect((await request(app).get('/api/resources').set(bearer)).body.resources[0].hostMetrics.cpu.percent).toBe(25);
    expect(inventory).not.toHaveBeenCalled();expect(localInventory).toHaveBeenCalledTimes(1);
    expect(app.locals.store.eventLogHealth().latestId).toBe(0);
  });
  it('agrega salud HTTPS explícita al recurso sin exponer el destino y vence a unknown',async()=>{
    const accountId='555555555555',targetUrl='https://health.private-config.example.com/ready';
    const probeConfig:Config={...config,aws:[{name:'probe',accountId,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[{id:'i-probe',region:'us-east-1',name:'Probe service',type:'t3.small'}]}],
      serviceProbes:[{resourceId:'aws:probe:i-probe',url:targetUrl,expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:1000}]};
    const app=createApp(probeConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const connection=app.locals.catalog.connections()[0],observedAt=new Date().toISOString();
    app.locals.catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[{providerId:'i-probe',resourceType:'ec2-instance',region:'us-east-1',name:'Probe service',state:'running',detail:'t3.small',observedAt}],{complete:true,observedAt});
    const record=app.locals.catalog.listResources()[0];
    const empty=await request(app).get('/api/resources').set(bearer);
    expect(empty.body.resources.find((item:{catalog:{catalogId:string}})=>item.catalog.catalogId===record.catalogId).health.service).toMatchObject({state:'unknown',source:'https-probe',reasonCode:'probe_not_run'});

    const baselineEvents=app.locals.store.eventLogHealth().retained;
    const timestamp=Date.now(),oldTimestamp=timestamp-180_000;
    const signal={state:'healthy' as const,source:'https-probe' as const,observedAt:new Date(oldTimestamp).toISOString(),freshUntil:new Date(oldTimestamp+120_000).toISOString(),reasonCode:'probe_http_ok',evidence:'HTTP 200'};
    app.locals.store.recordServiceProbe(`catalog:${record.catalogId}`,signal);
    const stale=await request(app).get('/api/resources').set(bearer);
    expect(stale.body.resources.find((item:{catalog:{catalogId:string}})=>item.catalog.catalogId===record.catalogId).health.service).toMatchObject({state:'unknown',reasonCode:'probe_result_stale'});
    expect((await request(app).get('/api/system/health').set(bearer)).body.serviceProbes).toMatchObject({registered:1,observed:1,healthy:0,stale:1});

    const freshAt=Date.now(),fresh={...signal,observedAt:new Date(freshAt).toISOString(),freshUntil:new Date(freshAt+120_000).toISOString()};
    app.locals.store.recordServiceProbe(`catalog:${record.catalogId}`,fresh);
    const healthy=await request(app).get('/api/resources').set(bearer);
    expect(healthy.body.resources.find((item:{catalog:{catalogId:string}})=>item.catalog.catalogId===record.catalogId).health.service).toMatchObject({state:'healthy',source:'https-probe',reasonCode:'probe_http_ok'});
    expect(JSON.stringify(healthy.body)).not.toContain(targetUrl);
    expect((await request(app).get('/api/system/health').set(bearer)).body.serviceProbes).toMatchObject({registered:1,observed:1,healthy:1,stale:0});
    expect(app.locals.store.eventLogHealth().retained).toBe(baselineEvents+2);
  });
  it('filtra salud y cobertura de sondas HTTPS por el readPolicy del agente',async()=>{
    const secret='service-probe-scoped-reader',accountId='666666666666';
    const visibleId='aws:probe:i-visible',hiddenId='aws:probe:i-hidden';
    const probeConfig:Config={...config,aws:[{name:'probe',accountId,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
      {id:'i-visible',region:'us-east-1',name:'Visible',type:'t3.small'},{id:'i-hidden',region:'us-east-1',name:'Hidden',type:'t3.small'}
    ]}],agentTokens:[{name:'probe-reader',hash:tokenHash(secret),scopes:['read'],readPolicy:{resourceIds:[visibleId]}}],serviceProbes:[
      {resourceId:visibleId,url:'https://visible.health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:1000},
      {resourceId:hiddenId,url:'https://hidden.health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:1000}
    ]};
    const app=createApp(probeConfig,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const connection=app.locals.catalog.connections()[0],observedAt=new Date().toISOString();
    app.locals.catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[
      {providerId:'i-visible',resourceType:'ec2-instance',region:'us-east-1',name:'Visible',state:'running',detail:'t3.small',observedAt},
      {providerId:'i-hidden',resourceType:'ec2-instance',region:'us-east-1',name:'Hidden',state:'running',detail:'t3.small',observedAt}
    ],{complete:true,observedAt});
    for(const resourceId of [visibleId,hiddenId]){
      const record=app.locals.catalog.resolveAlias(resourceId)!;
      app.locals.store.recordServiceProbe(`catalog:${record.catalogId}`,{state:'healthy',source:'https-probe',observedAt,freshUntil:new Date(Date.now()+120_000).toISOString(),reasonCode:'probe_http_ok'});
    }
    const auth={Authorization:`Bearer ${secret}`};
    const snapshot=await request(app).get('/api/resources').set(auth);
    expect(snapshot.body.resources).toHaveLength(1);
    expect(snapshot.body.resources[0]).toMatchObject({id:visibleId,health:{service:{state:'healthy'}}});
    expect(JSON.stringify(snapshot.body)).not.toContain('hidden.health.example.com');
    expect((await request(app).get('/api/system/health').set(auth)).body.serviceProbes).toMatchObject({registered:1,observed:1,healthy:1});
  });
  it('difunde hostmetrics en SSE sin cursor y respeta el alcance visible del agente',async()=>{
    const visibleToken='otel-visible-token',hiddenToken='otel-hidden-token',readerToken='otel-scoped-reader';
    const accountId='555555555555',visibleId='aws:one:i-visible',hiddenId='aws:one:i-hidden';
    const scoped:Config={...config,aws:[{name:'one',accountId,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
      {id:'i-visible',region:'us-east-1',name:'Visible host',type:'t3.small'},{id:'i-hidden',region:'us-east-1',name:'Hidden host',type:'t3.small'}
    ]}],agentTokens:[{name:'scoped-reader',hash:tokenHash(readerToken),scopes:['read'],readPolicy:{resourceIds:[visibleId]}}],otelCollectors:[
      {hostId:'host-visible-one',resourceId:visibleId,tokenHash:tokenHash(visibleToken)},
      {hostId:'host-hidden-two',resourceId:hiddenId,tokenHash:tokenHash(hiddenToken)}
    ]};
    const app=createApp(scoped,':memory:',{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});apps.push(app);
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind a TCP port');
    const controller=new AbortController();
    try{
      const response=await fetch(`http://127.0.0.1:${address.port}/api/events`,{headers:{Authorization:`Bearer ${readerToken}`},signal:controller.signal});
      expect(response.status).toBe(200);
      const reader=response.body?.getReader();if(!reader)throw new Error('SSE body missing');
      const decoder=new TextDecoder();let buffer='';
      let pendingRead:Promise<ReadableStreamReadResult<Uint8Array>>|undefined;
      const nextFrame=async(timeoutMs:number):Promise<string|null>=>{
        const deadline=Date.now()+timeoutMs;
        while(Date.now()<deadline){
          const split=buffer.indexOf('\n\n');
          if(split>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);return frame;}
          let timer:ReturnType<typeof setTimeout>|undefined;
          const result=await Promise.race([
            (pendingRead??=reader.read()).then(value=>({kind:'data' as const,value})),
            new Promise<{kind:'timeout'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),Math.max(1,deadline-Date.now()));})
          ]);
          if(timer)clearTimeout(timer);
          if(result.kind==='timeout')return null;
          pendingRead=undefined;
          if(result.value.done)return null;
          buffer+=decoder.decode(result.value.value,{stream:true});
        }
        return null;
      };
      const waitForEvent=async(name:string,timeoutMs:number):Promise<string|null>=>{
        const deadline=Date.now()+timeoutMs;
        while(Date.now()<deadline){const frame=await nextFrame(deadline-Date.now());if(frame===null)return null;if(frame.split('\n').includes(`event: ${name}`))return frame;}
        return null;
      };
      await new Promise(resolve=>setTimeout(resolve,20));
      const send=async(resourceId:string,hostId:string,token:string)=>{
        const now=Date.now()-1000,timeUnixNano=String(BigInt(now)*1_000_000n);
        const body={resourceMetrics:[{resource:{attributes:[{key:'host.id',value:{stringValue:hostId}}]},scopeMetrics:[{metrics:[{name:'system.cpu.utilization',gauge:{dataPoints:[{timeUnixNano,attributes:[],asDouble:0.25}]}}]}]}]};
        return request(app).post('/api/telemetry/otlp/v1/metrics').set('Authorization',`Bearer ${token}`).send(body);
      };
      expect((await send(hiddenId,'host-hidden-two',hiddenToken)).status).toBe(200);
      expect(await waitForEvent('resource',150)).toBeNull();
      expect((await send(visibleId,'host-visible-one',visibleToken)).status).toBe(200);
      const frame=await waitForEvent('resource',1500);
      expect(frame).not.toBeNull();expect(frame).not.toMatch(/(^|\n)id:/);
      const payload=JSON.parse(frame!.split('\n').find(line=>line.startsWith('data: '))!.slice(6));
      expect(payload).toMatchObject({catalog:{providerId:'i-visible'},hostMetrics:{cpu:{percent:25}},health:{telemetry:{state:'fresh',source:'otel-hostmetrics'}}});
      expect(app.locals.store.eventLogHealth().latestId).toBe(0);
      expect((await request(app).get('/api/system/health').set({Authorization:`Bearer ${readerToken}`})).body.hostTelemetry).toMatchObject({registeredHosts:1,hostsWithData:1,fresh:1});
    }finally{
      controller.abort();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
  it('acepta el destino de eventos AWS con token vinculado a la cuenta y queda fuera del token MCP/usuario', async () => {
    const eventToken='event-token-0123456789abcdef0123456789';
    const eventConfig:Config={...config,aws:[{name:'one',accountId:'123456789012',accessKeyId:'fixture',secretAccessKey:'fixture'}],awsEventTokenHashes:{'123456789012':tokenHash(eventToken)}};
    const app=createApp(eventConfig,':memory:',{inventory:async()=>[],perform:async()=>({message:'ok'})});apps.push(app);
    const catalog=app.locals.catalog;
    const connection=catalog.connections().find((item:{provider:string})=>item.provider==='aws');
    catalog.reconcileScope(connection.id,'aws:ec2:us-east-1',[],{complete:true,observedAt:new Date(Date.now()-1000).toISOString()});
    const event={version:'0',id:'event-http-1',source:'aws.ec2','detail-type':'EC2 Instance State-change Notification',account:'123456789012',region:'us-east-1',time:new Date().toISOString(),resources:[],detail:{'instance-id':'i-example1',state:'running'}};
    expect((await request(app).post('/api/aws/events').send(event)).status).toBe(401);
    const accepted=await request(app).post('/api/aws/events').set('x-infra-control-token',eventToken).send(event);
    expect(accepted.status).toBe(202);expect(accepted.body).toEqual({accepted:true,duplicate:false});
    const duplicate=await request(app).post('/api/aws/events').set('x-infra-control-token',eventToken).send(event);
    expect(duplicate.status).toBe(202);expect(duplicate.body.duplicate).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(catalog.listResources()[0]).toMatchObject({providerId:'i-example1',state:'running'});
    expect((await request(app).get('/api/system/health').set(bearer)).body.cloudEvents).toMatchObject({pending:0,processed:1});
  });
  it('no acepta tokens inválidos y limita intentos de login', async () => {
    const app = setup();
    expect((await request(app).get('/api/resources').set('Authorization', 'Bearer invalid')).status).toBe(401);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'wrong', password: 'wrong' });
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({})).status).toBe(429);
  });
});
describe('operaciones de infraestructura', () => {
  it('actualiza el catálogo al confirmar EC2 aunque el adaptador conserve su snapshot anterior', async () => {
    const awsConfig: Config = { ...config, aws: [{ name: 'test', accountId: '123456789012', accessKeyId: 'fixture', secretAccessKey: 'fixture', instances: [{ id: 'server', region: 'us-east-1', name: 'Servidor', type: 't3.small' }] }] };
    const stoppedAt = new Date().toISOString();
    const app = createApp(awsConfig, ':memory:', {
      inventory: async () => [{ ...resource, actions: ['stop', 'refresh'] }],
      perform: async () => ({ message: 'AWS confirmó la instancia detenida.', observation: { state: 'stopped', observedAt: stoppedAt } })
    });
    apps.push(app);
    const accepted = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'confirmed-ec2-stop').send({ resourceId: resource.id, action: 'stop', confirmed: true });
    expect(accepted.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await request(app).get(`/api/operations/${accepted.body.id}`).set(bearer)).body.state).toBe('succeeded');
    expect((await request(app).get('/api/resources').set(bearer)).body.resources.find((item: Resource) => item.id === resource.id)).toMatchObject({ state: 'stopped', observedAt: stoppedAt });
  });

  it('solo permite capacidades y recursos del inventario del servidor', async () => {
    const app = setup();
    for (const [resourceId, action] of [['unknown', 'stop'], [resource.id, 'shell'], [resource.id, 'start']]) {
      expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', crypto.randomUUID()).send({ resourceId, action, confirmed: true })).status).toBe(400);
    }
    expect((await request(app).post('/api/operations').set(bearer).send({ resourceId: resource.id, action: 'stop' })).status).toBe(400);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'a').send({ resourceId: resource.id, action: 'stop' })).status).toBe(400);
  });
  it('deduplica la misma orden y registra actor y verificación real', async () => {
    let calls = 0;
    const app = setup({ inventory: async () => [resource], perform: async () => { calls++; return { message: 'Estado detenido confirmado por AWS.' }; } });
    const body = { resourceId: resource.id, action: 'stop', confirmed: true };
    const first = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send(body);
    expect(first.status).toBe(202);
    const second = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send(body);
    expect(second.body.id).toBe(first.body.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    const op = await request(app).get(`/api/operations/${first.body.id}`).set(bearer);
    expect(calls).toBe(1); expect(op.body.state).toBe('succeeded'); expect(op.body.actor).toBe('test-agent');
    expect((await request(app).get('/api/operations').set(bearer)).body.operations).toHaveLength(1);
    const history=await request(app).get(`/api/operations/${first.body.id}/history`).set(bearer);
    expect(history.body.events.map((event:{payload:{state:string}})=>event.payload.state)).toEqual(['accepted','running','succeeded']);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'same-order').send({ ...body, action: 'refresh' })).status).toBe(409);
  });
  it('exige política de recurso a tokens REST con scope operate', async () => {
    let calls = 0;
    const restricted = createApp({ ...config, agentTokens: [{ name: 'unscoped', hash: tokenHash('unscoped-secret'), scopes: ['read', 'operate'] }] }, ':memory:', {
      inventory: async () => [resource], perform: async () => { calls++; return { message: 'No debe ejecutarse.' }; }
    });
    apps.push(restricted);
    const response = await request(restricted).post('/api/operations').set('Authorization', 'Bearer unscoped-secret').set('Idempotency-Key', 'no-policy')
      .send({ resourceId: resource.id, action: 'stop', confirmed: true });
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });
  it('no permite repetir una operación idempotente después de revocar su política', async () => {
    const secret='direct-replay-revocation-secret';
    const policy={actions:['stop'] as ('stop')[],resourceIds:[resource.id]};
    const securedConfig:Config={...config,agentTokens:[{name:'revocable-agent',hash:tokenHash(secret),scopes:['read','operate'],operationPolicy:policy}]};
    const app=createApp(securedConfig,':memory:',{inventory:async()=>[resource],perform:async()=>({message:'Estado detenido confirmado.'})});apps.push(app);
    const auth={Authorization:`Bearer ${secret}`},body={resourceId:resource.id,action:'stop',confirmed:true};
    const first=await request(app).post('/api/operations').set(auth).set('Idempotency-Key','revocable-order').send(body);
    expect(first.status).toBe(202);
    policy.actions=[];
    const replay=await request(app).post('/api/operations').set(auth).set('Idempotency-Key','revocable-order').send(body);
    expect(replay.status).toBe(403);
  });
  it.each(['admission', 'dispatch'] as const)('revalida el bearer de la orden REST durante %s', async phase => {
    const secured: Config = { ...config, agentTokens: config.agentTokens.map(agent => ({ ...agent })) };
    let enter!: () => void;
    let release!: (value: Resource[]) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<Resource[]>(resolve => { release = resolve; });
    const inventory = vi.fn(async () => [resource]);
    const perform = vi.fn(async () => ({ message: 'Confirmado por el adaptador simulado.' }));
    if (phase === 'dispatch') inventory.mockResolvedValueOnce([resource]);
    inventory.mockImplementationOnce(() => { enter(); return gate; });
    const app = createApp(secured, ':memory:', { inventory, perform });
    apps.push(app);
    const pending = request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'fixture-rotation')
      .send({ resourceId: resource.id, action: 'stop', confirmed: true }).then(response => response);
    const replacement = 'fixture-replacement-token';
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('La lectura simulada debía quedar pendiente'); })]);
      secured.agentTokens[0] = { ...secured.agentTokens[0]!, hash: tokenHash(replacement) };
    } finally { release([resource]); }
    const response = await pending;
    const auth = { Authorization: `Bearer ${replacement}` };
    if (phase === 'admission') {
      expect(response.status).toBe(403);
      expect((await request(app).get('/api/operations').set(auth)).body.operations).toEqual([]);
    } else {
      expect(response.status).toBe(202);
      const store = app.locals.store as Store;
      await vi.waitFor(() => expect(store.get(response.body.id)?.state).toBe('failed'));
    }
    expect(perform).not.toHaveBeenCalled();
  });
  it('redacta los IDs del historial REST según la credencial lectora', async () => {
    const scopedAuth = { Authorization: 'Bearer fixture-history-reader' };
    const scoped: Config = { ...config, agentTokens: [...config.agentTokens, {
      name: 'history-reader', hash: tokenHash('fixture-history-reader'), scopes: ['read'], readPolicy: { resourceIds: [resource.id] }
    }] };
    const app = createApp(scoped, ':memory:', { inventory: async () => [resource], perform: async () => ({ message: 'Confirmado por el adaptador simulado.' }) });
    apps.push(app);
    const created = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'fixture-history').send({ resourceId: resource.id, action: 'refresh' });
    expect(created.status).toBe(202);
    const store = app.locals.store as Store;
    await vi.waitFor(() => expect(store.get(created.body.id)?.state).toBe('succeeded'));
    const path = `/api/operations/${created.body.id}/history`;
    const owner = await request(app).get(path).set('Cookie', await login(app));
    const restricted = await request(app).get(path).set(scopedAuth);
    expect(owner.status).toBe(200);
    expect(restricted.status).toBe(200);
    expect(owner.body.events.map((event: { id: number }) => event.id)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(restricted.body.events.map((event: { id: number | null; payload: { state: string } }) => [event.id, event.payload.state])).toEqual([[null, 'accepted'], [null, 'running'], [null, 'succeeded']]);
  });
  it('revalida capacidad y estado inmediatamente antes de enviar la orden', async () => {
    let inventoryReads = 0, calls = 0;
    const app = setup({ inventory: async () => { inventoryReads++; return inventoryReads === 1 ? [resource] : []; }, perform: async () => { calls++; return { message: 'No debe ejecutarse.' }; } });
    const response = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'state-changed')
      .send({ resourceId: resource.id, action: 'stop', confirmed: true });
    expect(response.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 20));
    const operation = await request(app).get(`/api/operations/${response.body.id}`).set(bearer);
    expect(inventoryReads).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(0);
    expect(operation.body.state).toBe('failed');
    expect(operation.body.message).toContain('revalid');
  });
  it('persiste el progreso real de una operación de PC en el historial sin enviar otra orden', async () => {
    let calls = 0;
    const pc: Resource = { id: 'computer:desktop', name: 'PC de casa', kind: 'computer', state: 'unreachable', location: 'Casa', detail: 'Dual boot', account: 'Casa', actions: ['start'], observedAt: new Date().toISOString() };
    const app = setup({ inventory: async () => [pc], perform: async (_resource, _action, onProgress) => {
      calls++;
      onProgress?.('WOL enviado por el túnel FiberHome; esperando el aviso de la PC.');
      return { message: 'CachyOS comunicó su arranque al panel.' };
    } });
    const created = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'pc-progress').send({ resourceId: pc.id, action: 'start', confirmed: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const history = await request(app).get(`/api/operations/${created.body.id}/history`).set(bearer);
    expect(calls).toBe(1);
    expect(history.body.events.map((event: { payload: { state: string; message: string } }) => [event.payload.state, event.payload.message])).toContainEqual(['running', 'WOL enviado por el túnel FiberHome; esperando el aviso de la PC.']);
    expect(history.body.events.at(-1).payload.message).toBe('CachyOS comunicó su arranque al panel.');
  });
  it('registra fallo sin filtrar el error del proveedor y conserva el resto del panel', async () => {
    const app = setup({ inventory: async () => [resource], perform: async () => { throw new Error('secret-provider-credential'); } });
    const first = await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'fail').send({ resourceId: resource.id, action: 'refresh' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const op = await request(app).get(`/api/operations/${first.body.id}`).set(bearer);
    expect(op.body.state).toBe('failed'); expect(JSON.stringify(op.body)).not.toContain('secret-provider');
    expect((await request(app).get('/api/resources').set(bearer)).status).toBe(200);
  });
  it('bloquea operaciones simultáneas sobre el mismo equipo', async () => {
    let release!: () => void;
    const app = setup({ inventory: async () => [resource], perform: () => new Promise(resolve => { release = () => resolve({ message: 'Confirmado' }); }) });
    const body = { resourceId: resource.id, action: 'refresh' };
    await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'one').send(body);
    expect((await request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'two').send(body)).status).toBe(409);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
  });
  it('rechaza una orden con 503 durante el relevo de despliegue y comunica Retry-After', async () => {
    const directory=mkdtempSync(join(tmpdir(),'infra-deploy-gate-')),path=join(directory,'infra.sqlite');
    const gateStore=new Store(path);
    gateStore.db.prepare("INSERT INTO settings(key,value) VALUES ('deployment-gate',?)").run(JSON.stringify({owner:'test-deploy',expiresAt:new Date(Date.now()+60000).toISOString()}));
    gateStore.close();
    const app=createApp(config,path,{inventory:async()=>[resource],perform:async()=>({message:'never called'})});apps.push(app);
    try{
      const response=await request(app).post('/api/operations').set(bearer).set('Idempotency-Key','deployment-denied').send({resourceId:resource.id,action:'stop',confirmed:true});
      expect(response.status).toBe(503);expect(response.headers['retry-after']).toBe('15');expect(response.body.error).toContain('despliegue');
      expect((await request(app).get('/api/operations').set(bearer)).body.operations).toHaveLength(0);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('rechaza CSRF incluso con sesión válida y restringe agentes de solo lectura', async () => {
    const app = setup(); const cookie = await login(app);
    expect((await request(app).post('/api/operations').set('Cookie', cookie).set('Origin', 'https://evil.example').set('Idempotency-Key', 'csrf').send({ resourceId: resource.id, action: 'stop', confirmed: true })).status).toBe(403);
    expect((await request(app).get('/api/operations/missing').set(bearer)).status).toBe(404);
    const readonly = createApp({ ...config, agentTokens: [{ name: 'read-only', hash: tokenHash('reader'), scopes: ['read'] }] }, ':memory:', { inventory: async () => [resource], perform: async () => { throw new Error('Must not execute'); } });
    apps.push(readonly);
    expect((await request(readonly).get('/api/resources').set('Authorization', 'Bearer reader')).status).toBe(200);
    expect((await request(readonly).post('/api/operations').set('Authorization', 'Bearer reader').set('Idempotency-Key', 'read-only').send({ resourceId: resource.id, action: 'stop', confirmed: true })).status).toBe(403);
  });
  it('conserva idempotencia en solicitudes concurrentes', async () => {
    let calls = 0;
    const app = setup({ inventory: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return [resource]; }, perform: async () => { calls++; return { message: 'Confirmed' }; } });
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/operations').set(bearer).set('Idempotency-Key', 'concurrent').send({ resourceId: resource.id, action: 'refresh' })));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(responses.every(r => r.status === 202)).toBe(true); expect(new Set(responses.map(r => r.body.id)).size).toBe(1); expect(calls).toBe(1);
  });
  it('cambia contraseña desde sesión personal e invalida sesiones previas', async () => {
    const app = setup(); const cookie = await login(app);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set('Cookie', cookie).send({ current: 'wrong', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(401);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set('Cookie', cookie).send({ current: 'una-clave-de-prueba-larga', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(200);
    expect((await request(app).get('/api/resources').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'admin', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(200);
    expect((await request(app).post('/api/auth/password').set('Origin', origin).set(bearer).send({ current: 'x', password: 'una-clave-nueva-de-24-caracteres' })).status).toBe(403);
  });
  it('valida cuerpos malformados y sirve documentación sin filtrar configuración', async () => {
    const app = setup();
    expect(typeof (await request(app).get('/api/resources').set(bearer)).body.cursor).toBe('number');
    const docs = await request(app).get('/api/openapi.json').set(bearer);
    expect(docs.status).toBe(200); expect(docs.body.openapi).toBe('3.1.0'); expect(JSON.stringify(docs.body)).not.toContain('test-agent-secret');
    expect((await request(app).get('/api/not-found').set(bearer)).status).toBe(404);
    expect((await request(app).get('/')).body.frontend).toBe('pending-design-approval');
    expect((await request(app).post('/api/operations').set(bearer).set('Content-Type', 'application/json').send('{not-json')).status).toBe(400);
  });

  it('guarda el sistema predeterminado como pendiente al estar fuera de línea y permite cancelarlo', async () => {
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => { throw new DesktopOfflineError(); },
      readBootDefault: async () => { throw new DesktopOfflineError(); }
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-offline')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ desired: 'windows', effective: null, state: 'pending', version: 1 });
    const snapshot = await request(app).get('/api/desktop/boot-preference').set(bearer);
    expect(snapshot.body.operationKey).toBeUndefined();
    expect(snapshot.body.state).toBe('pending');
    const cancelled = await request(app).delete('/api/desktop/boot-preference/pending')
      .set(bearer).send({ expectedVersion: 1 });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ desired: null, effective: null, state: 'unknown', version: 2 });
  });
  it('no permite que un agente con operate sin alcance UEFI cambie el sistema predeterminado', async () => {
    let firmwareReads=0,firmwareWrites=0;
    const restricted=createApp({...config,agentTokens:[{name:'general-operator',hash:tokenHash('general-operator-secret'),scopes:['read','operate'],operationPolicy:{actions:['stop'],resourceIds:[resource.id]}}]},':memory:',{
      inventory:async()=>[],perform:async()=>({message:'unused'}),readBootDefault:async()=>{firmwareReads++;return{defaultSystem:'windows',observedAt:new Date().toISOString()};},
      setBootDefault:async(system)=>{firmwareWrites++;return{defaultSystem:system,verifiedAt:new Date().toISOString()};}
    });apps.push(restricted);
    const response=await request(restricted).post('/api/desktop/boot-preference').set('Authorization','Bearer general-operator-secret').set('Idempotency-Key','unauthorized-boot')
      .send({system:'windows',confirmed:true,expectedVersion:0});
    expect(response.status).toBe(403);expect(firmwareReads).toBe(0);expect(firmwareWrites).toBe(0);
  });

  it('conserva el último firmware leído si el cambio queda pendiente', async () => {
    const observedAt = '2026-10-21T10:44:00.000Z';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => { throw new DesktopOfflineError(); },
      readBootDefault: async () => ({ defaultSystem: 'windows', observedAt })
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-observed-pending')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ desired: 'cachyos', effective: 'windows', state: 'pending', observedAt });
  });

  it('rechaza cambiar el arranque si la PC no confirma que el helper UEFI está instalado', async () => {
    let writes = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => { writes++; return { defaultSystem: system, verifiedAt: new Date().toISOString() }; },
      readBootDefault: async () => { throw new Error('UEFI helper unavailable'); }
    };
    const app = setup(adapter);
    const response = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-unsupported')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/helper UEFI/i);
    expect(writes).toBe(0);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: null, effective: null, state: 'unknown', version: 0 });
  });

  it('reconcilia el default pendiente solo tras recibir un aviso nuevo de la PC', async () => {
    let reachable = false;
    let calls = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => {
        calls++;
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: system, verifiedAt: new Date().toISOString() };
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: 'windows', observedAt: new Date().toISOString() };
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    expect(pending.body.state).toBe('pending');
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-current', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    const snapshot = await request(app).get('/api/desktop/boot-preference').set(bearer);
    expect(snapshot.body).toMatchObject({ desired: 'cachyos', effective: 'cachyos', state: 'applied', version: 1 });
    expect(calls).toBe(2);
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-current', sequence: 2, event: 'heartbeat' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(2);
  });

  it('no aplica un default pendiente si la PC volvió pero no confirma capacidad UEFI', async () => {
    let reachable = false;
    let writes = 0;
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        writes++;
        throw new Error('Must not write without a verified UEFI helper');
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        throw new Error('UEFI helper unavailable');
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-unsupported')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    expect(pending.body.state).toBe('pending');
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-unsupported', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toBe(0);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: null, state: 'failed', version: 1 });
    const replay = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-unsupported')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(replay.status).toBe(409);
    expect(replay.body.state).toBe('failed');
  });

  it('conserva la lectura UEFI al reconciliar si la escritura vuelve a quedar fuera de línea', async () => {
    let reachable = false;
    let writes = 0;
    const observedAt = '2026-10-21T10:44:30.000Z';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        writes++;
        throw new DesktopOfflineError();
      },
      readBootDefault: async () => {
        if (!reachable) throw new DesktopOfflineError();
        return { defaultSystem: 'windows', observedAt };
      }
    };
    const app = createApp({ ...config, desktop: { socketPath: '/unused', reportTokenHashes: { cachyos: tokenHash('linux-device-only'), windows: tokenHash('windows-device-only') } } }, ':memory:', adapter);
    apps.push(app);
    const pending = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-reconcile-observation')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(pending.status).toBe(202);
    reachable = true;
    expect((await request(app).post('/api/desktop/events').set('Authorization', 'Bearer linux-device-only')
      .send({ bootId: 'linux-boot-observation', sequence: 1, event: 'online' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toBe(1);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: 'windows', state: 'pending', observedAt });
  });

  it('no repite la escritura UEFI ante dos solicitudes concurrentes con la misma clave', async () => {
    let writes = 0;
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { writeStarted = resolve; });
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => {
        writes++;
        if (writes === 1) {
          writeStarted?.();
          await writeGate;
        }
        return { defaultSystem: system, verifiedAt: new Date().toISOString() };
      },
      readBootDefault: async () => ({ defaultSystem: 'windows', observedAt: new Date().toISOString() })
    };
    const app = setup(adapter);
    const send = () => request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-concurrent')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    const firstPromise = new Promise<{ status: number }>((resolve, reject) => {
      send().end((error, response) => error ? reject(error) : resolve(response));
    });
    const firstOutcome = await Promise.race([
      started.then(() => 'started'),
      firstPromise.then(response => `response-${response.status}`),
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 1000))
    ]);
    expect(firstOutcome).toBe('started');
    const second = await send();
    expect(second.status).toBe(202);
    expect(second.body.state).toBe('applying');
    expect(writes).toBe(1);
    releaseWrite?.();
    expect((await firstPromise).status).toBe(200);
    expect(writes).toBe(1);
  });

  it('expone una comprobación UEFI explícita y convierte una divergencia en drift', async () => {
    let effective: 'windows' | 'cachyos' = 'windows';
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => ({ defaultSystem: system, verifiedAt: new Date().toISOString() }),
      readBootDefault: async () => ({ defaultSystem: effective, observedAt: new Date().toISOString() })
    };
    const app = setup(adapter);
    const requestPreference = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-verified')
      .send({ system: 'windows', confirmed: true, expectedVersion: 0 });
    expect(requestPreference.status).toBe(200);
    expect(requestPreference.body).toMatchObject({ desired: 'windows', effective: 'windows', state: 'applied' });
    effective = 'cachyos';
    const observed = await request(app).get('/api/desktop/boot-preference/verify').set(bearer);
    expect(observed.status).toBe(200);
    expect(observed.body).toMatchObject({ desired: 'windows', effective: 'cachyos', state: 'drift' });
  });

  it('descarta una lectura UEFI que termina después de iniciar un cambio de arranque', async () => {
    let reads = 0;
    let releaseVerification: (() => void) | undefined;
    let verificationStarted: (() => void) | undefined;
    const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
    const started = new Promise<void>(resolve => { verificationStarted = resolve; });
    const adapter: Adapter = {
      inventory: async () => [],
      perform: async () => ({ message: 'unused' }),
      setBootDefault: async system => ({ defaultSystem: system, verifiedAt: '2026-10-21T10:45:00.000Z' }),
      readBootDefault: async () => {
        reads++;
        if (reads === 1) {
          verificationStarted?.();
          await verificationGate;
        }
        return { defaultSystem: 'windows', observedAt: '2026-10-21T10:44:00.000Z' };
      }
    };
    const app = setup(adapter);
    const verification = new Promise<{ status: number }>((resolve, reject) => {
      request(app).get('/api/desktop/boot-preference/verify').set(bearer)
        .end((error, response) => error ? reject(error) : resolve(response));
    });
    await started;
    const applied = await request(app).post('/api/desktop/boot-preference')
      .set(bearer).set('Idempotency-Key', 'boot-pref-race')
      .send({ system: 'cachyos', confirmed: true, expectedVersion: 0 });
    expect(applied.status).toBe(200);
    releaseVerification?.();
    expect((await verification).status).toBe(409);
    expect((await request(app).get('/api/desktop/boot-preference').set(bearer)).body)
      .toMatchObject({ desired: 'cachyos', effective: 'cachyos', state: 'applied' });
  });
});
