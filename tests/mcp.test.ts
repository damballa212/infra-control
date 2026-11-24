import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { hashPassword, tokenHash } from '../server/auth.js';
import type { Adapter, Config, Resource } from '../server/types.js';

const origin = 'https://control.example.test';
const resource: Resource = { id: 'computer:mac', name: 'MacBook', kind: 'computer', state: 'running', location: 'macOS', account: 'Personal', detail: 'Apple Silicon', actions: [], observedAt: new Date().toISOString() };
let config: Config;
const apps: ReturnType<typeof createApp>[] = [];
beforeAll(async () => {
  config = {
    origin,
    passwordHash: await hashPassword('una-clave-de-prueba-larga'),
    agentTokens: [{ name: 'infra-reader', hash: tokenHash('infra-reader-secret'), scopes: ['read'] }],
    aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' }
  };
});
afterEach(() => { for (const app of apps.splice(0)) app.locals.close(); });
function setup(adapter?: Adapter) {
  const app = createApp(config, ':memory:', adapter ?? { inventory: async () => [resource], perform: async () => ({ message: 'ok' }) });
  apps.push(app);
  return app;
}
function setupWith(agentConfig: Config, adapter?: Adapter) {
  const app = createApp(agentConfig, ':memory:', adapter ?? { inventory: async () => [resource], perform: async () => ({ message: 'ok' }) });
  apps.push(app);
  return app;
}
function call(app: ReturnType<typeof createApp>, body: Record<string, unknown>, token = 'infra-reader-secret') {
  return request(app).post('/api/mcp').set('Host', new URL(origin).host).set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream').send(body);
}
function resultOf(response: { body: Record<string, unknown>; text: string }) {
  if (response.body.result) return response.body.result as Record<string, unknown>;
  const data = response.text.split(/\r?\n/).find(line => line.startsWith('data: '));
  return data ? JSON.parse(data.slice(6)).result as Record<string, unknown> : {};
}
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'infra-control-tests', version: '1.0.0' } } };

describe('MCP con transporte Streamable HTTP', () => {
  it('autentica con el token de agente y expone un catálogo pequeño de herramientas', async () => {
    const app = setup();
    expect((await request(app).post('/api/mcp').set('Host', new URL(origin).host).set('Origin', origin).send(initialize)).status).toBe(401);

    const initialized = await call(app, initialize);
    expect(initialized.status).toBe(200);
    expect((resultOf(initialized).serverInfo as { name: string }).name).toBe('infra-control');

    const tools = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(tools.status).toBe(200);
    expect((resultOf(tools).tools as { name: string }[]).map(tool => tool.name)).toEqual([
      'list_resources', 'get_resource', 'list_projects', 'get_incidents', 'get_cost_summary', 'get_operation'
    ]);
  });

  it('permite lectura con un token read-only y no hace polling de proveedores por cada cliente', async () => {
    const observedAt=new Date(Date.now()-2*60*60_000).toISOString(),oldResource={...resource,observedAt};
    const inventory = vi.fn(async () => [oldResource]);
    const localInventory = vi.fn(async () => [oldResource]);
    const app = setup({ inventory, localInventory, perform: async () => ({ message: 'ok' }) });
    await call(app, initialize);
    const result = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_resources', arguments: {} } });

    expect(result.status).toBe(200);
    const content=resultOf(result).structuredContent as {resources:{observedAt:string|null}[];fetchedAt:string;observedAt?:string};
    expect(content.resources).toHaveLength(1);
    expect(content.resources[0].observedAt).toBe(observedAt);
    expect(content.fetchedAt).toBeTruthy();
    expect(content).not.toHaveProperty('observedAt');
    expect(inventory).not.toHaveBeenCalled();
    expect(localInventory).toHaveBeenCalledTimes(1);
  });

  it('expone las lecturas de recurso, proyectos, incidentes, costes cacheados y operaciones', async () => {
    const token = 'infra-complete-reader';
    const agentConfig: Config = { ...config, aws: [{ name: 'demo', accountId: '444444444444', accessKeyId: 'fixture', secretAccessKey: 'fixture', instances:[{id:'i-project',region:'us-east-1',name:'Shop API',type:'t3.small'}] }], services:[{key:'shop-api',name:'Shop API',projectKey:'shop-service',projectName:'Shop platform',environment:'prod',criticality:'high',relations:[{resourceId:'aws:demo:i-project',relationType:'hosted_on',evidence:'provider_metadata'}]}], agentTokens: [{ name: 'catalog-reader', hash: tokenHash(token), scopes: ['read'] }] };
    const app = setupWith(agentConfig, { inventory: async () => [resource], localInventory: async () => [resource], perform: async () => ({ message: 'unused' }) });
    const connection = app.locals.catalog.connections()[0]!;
    app.locals.catalog.reconcileScope(connection.id, 'aws:ec2:us-east-1', [{ providerId: 'i-project', resourceType: 'ec2-instance', region: 'us-east-1', name: 'Shop API', state: 'running', detail: 't3.small', tags: { Project: 'Shop', Environment: 'prod' }, observedAt: new Date().toISOString() }], { complete: true, observedAt: new Date().toISOString() });
    app.locals.store.appendEvent('incident', resource.id, { category: 'service', resourceId: resource.id, resourceName: resource.name, secret: 'must-not-leak' });
    const operation = app.locals.store.create('catalog-reader', 'read-existing-operation', JSON.stringify({ resourceId: resource.id, action: 'stop' }), resource, 'stop');

    const getResource = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_resource', arguments: { resourceId: resource.id } } }, token);
    expect((resultOf(getResource).structuredContent as { resource: Resource }).resource.name).toBe(resource.name);

    const projects = await call(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: { limit: 10 } } }, token);
    const projectContent=(resultOf(projects).structuredContent as { projects: { name: string; environments: string[];services?:{key:string;relations:{resourceId:string|null}[]}[] }[] }).projects;
    expect(projectContent).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Shop', environments: ['prod'] })]));
    expect(projectContent.find(project=>project.name==='Shop platform')?.services).toMatchObject([{key:'shop-api',relations:[{resourceId:expect.any(String)}]}]);

    const incidents = await call(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_incidents', arguments: { category: 'service' } } }, token);
    const incidentContent = resultOf(incidents).structuredContent as { incidents: { incident: Record<string, unknown> }[] };
    expect(incidentContent.incidents[0]?.incident).toMatchObject({ category: 'service', resourceName: 'MacBook' });
    expect(incidentContent.incidents[0]?.incident).not.toHaveProperty('secret');

    const costs = await call(app, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_cost_summary', arguments: {} } }, token);
    expect(resultOf(costs).structuredContent).toMatchObject({ available: false, stale: true, report: null, reasonCode: 'cost_cache_empty' });

    const existingOperation = await call(app, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_operation', arguments: { operationId: operation.id } } }, token);
    expect((resultOf(existingOperation).structuredContent as { operation: { id: string } }).operation.id).toBe(operation.id);
  });

  it('no devuelve relaciones a recursos ocultos aunque el token pueda leer el proyecto',async()=>{
    const token='mcp-project-scoped-reader',projectIds:string[]=[];
    const agentConfig:Config={...config,aws:[{name:'restricted',accountId:'888888888888',accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
      {id:'i-hidden',region:'us-east-1',name:'hidden-host-secret',type:'t3.small'}
    ]}],services:[{key:'private-backend',name:'Private Backend',projectKey:'internal-project',projectName:'Internal Project',environment:'prod',criticality:'high',relations:[
      {resourceId:'aws:restricted:i-hidden',relationType:'hosted_on',evidence:'operator_confirmed'}
    ]}],agentTokens:[{name:'project-reader',hash:tokenHash(token),scopes:['read'],readPolicy:{projectIds}}]};
    const app=setupWith(agentConfig,{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});
    const project=app.locals.catalog.listProjects().find((item:{id:string;name:string})=>item.name==='Internal Project');
    expect(project).toBeDefined();projectIds.push(project!.id);
    const response=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_projects',arguments:{}}},token);
    expect(response.status).toBe(200);
    const projects=(resultOf(response).structuredContent as {projects:{name:string;services:{key:string;relations:unknown[]}[]}[]}).projects;
    expect(projects.find(item=>item.name==='Internal Project')?.services).toMatchObject([{key:'private-backend',relations:[]}]);
    expect(JSON.stringify(projects)).not.toContain('aws:restricted:i-hidden');
    expect(JSON.stringify(projects)).not.toContain('hidden-host-secret');
  });

  it('reclama y confirma la misma entrega de incidente sin resolver el incidente', async () => {
    const operatorToken = 'incident-consumer-token';
    const consumerConfig: Config = { ...config, agentTokens: [...config.agentTokens, { name: 'incident-consumer', hash: tokenHash(operatorToken), scopes: ['read', 'operate'], mcpTools: ['get_pending_incidents', 'acknowledge_incident'] }] };
    const app = setupWith(consumerConfig);
    const poll = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_pending_incidents', arguments: { limit: 5 } } };
    expect((resultOf(await call(app, poll, operatorToken)).structuredContent as { deliveries: unknown[] }).deliveries).toEqual([]);
    app.locals.store.appendEvent('incident', resource.id, { category: 'service', resourceId: resource.id, reasonCode: 'probe_unhealthy' });
    const pending = await call(app, { ...poll, id: 3 }, operatorToken);
    const delivery = (resultOf(pending).structuredContent as { deliveries: { deliveryId: string; version: string; incident: Record<string, unknown> }[] }).deliveries[0]!;
    expect(delivery.incident).toMatchObject({ category: 'service', reasonCode: 'probe_unhealthy' });

    const ack = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acknowledge_incident', arguments: { deliveryId: delivery.deliveryId, version: delivery.version } } };
    expect((resultOf(await call(app, ack, operatorToken)).structuredContent as { acknowledged: boolean; duplicate: boolean })).toMatchObject({ acknowledged: true, duplicate: false });
    expect((resultOf(await call(app, { ...ack, id: 5 }, operatorToken)).structuredContent as { acknowledged: boolean; duplicate: boolean })).toMatchObject({ acknowledged: true, duplicate: true });
    expect(app.locals.store.incidentEventsAfter(0, 10)).toHaveLength(1);
  });
  it('filtra los recursos MCP por cuentas autorizadas en readPolicy', async () => {
    const token='scoped-mcp-reader';
    const scopedConfig:Config={...config,aws:[
      {name:'one',accountId:'111111111111',accessKeyId:'fixture',secretAccessKey:'fixture'},
      {name:'two',accountId:'222222222222',accessKeyId:'fixture',secretAccessKey:'fixture'}
    ],agentTokens:[{name:'scoped-reader',hash:tokenHash(token),scopes:['read'],mcpTools:['list_resources'],readPolicy:{accountIds:['111111111111']}}]};
    const app=setupWith(scopedConfig,{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});
    for(const [index,connection] of app.locals.catalog.connections().entries())app.locals.catalog.reconcileScope(connection.id,`aws:ec2:us-east-${index+1}`,[{
      providerId:`i-${index+1}`,resourceType:'ec2-instance',region:`us-east-${index+1}`,name:`server-${index+1}`,state:'running',detail:'t3.small',observedAt:new Date().toISOString()
    }],{complete:true,observedAt:new Date().toISOString()});
    await call(app,initialize,token);
    const response=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_resources',arguments:{}}},token);
    const content=resultOf(response).structuredContent as {resources:{name:string}[];coverage:{connectionId:string}[]};
    const resources=content.resources;
    expect(resources.map(item=>item.name)).toEqual(['server-1']);
    expect(content.coverage).toHaveLength(1);
    expect(content.coverage[0].connectionId).toBe(app.locals.catalog.connections()[0].id);
  });
  it('limita MCP coverage a los recursos autorizados incluso dentro de una cuenta visible parcialmente', async () => {
    const token='resource-only-mcp-secret',accountId='333333333333';
    const scopedConfig:Config={...config,aws:[{name:'three',accountId,accessKeyId:'fixture',secretAccessKey:'fixture'}],agentTokens:[{name:'resource-reader',hash:tokenHash(token),scopes:['read'],mcpTools:['list_resources'],readPolicy:{resourceIds:['aws:three:i-visible']}}]};
    const app=setupWith(scopedConfig,{inventory:async()=>[],localInventory:async()=>[],perform:async()=>({message:'unused'})});
    const connection=app.locals.catalog.connections()[0];
    for(const [region,instanceId] of [['us-east-1','i-visible'],['us-east-2','i-hidden']])app.locals.catalog.reconcileScope(connection.id,`aws:ec2:${region}`,[{
      providerId:instanceId,resourceType:'ec2-instance',region,name:instanceId,state:'running',detail:'t3.small',observedAt:new Date().toISOString(),aliases:[`aws:three:${instanceId}`]
    }],{complete:true,observedAt:new Date().toISOString()});
    await call(app,initialize,token);
    const response=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_resources',arguments:{}}},token);
    const coverage=(resultOf(response).structuredContent as {coverage:{scopeKey:string;resourceCount:number}[]}).coverage;
    expect(coverage).toEqual([expect.objectContaining({scopeKey:'aws:ec2:us-east-1',resourceCount:1})]);
  });

  it('rechaza antes del proveedor las herramientas de escritura para un token read-only', async () => {
    let calls = 0;
    const app = setup({ inventory: async () => [resource], perform: async () => { calls++; return { message: 'ok' }; } });
    const response = await call(app, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_operation', arguments: { planId: '00000000-0000-4000-8000-000000000001' } } });

    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  it('planifica, revalida y ejecuta una vez mediante la misma cola durable de operaciones', async () => {
    const operatorToken = 'infra-operator-secret';
    const stoppable: Resource = { ...resource, id: 'aws:test:i-example123', name: 'Example EC2', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'test', detail: 't3.small', actions: ['stop'], observedAt: new Date().toISOString() };
    const operatorConfig = { ...config, agentTokens: [...config.agentTokens, { name: 'infra-operator', hash: tokenHash(operatorToken), scopes: ['read', 'operate'] as ('read'|'operate')[], mcpTools: ['plan_operation','execute_operation'] as ('plan_operation'|'execute_operation')[], operationPolicy: { actions: ['stop'] as ('stop')[], resourceIds: [stoppable.id] } }] };
    let executions = 0;
    const app = setupWith(operatorConfig, { inventory: async () => [stoppable], localInventory: async () => [stoppable], perform: async () => { executions++; return { message: 'Estado detenido confirmado.' }; } });
    const planResponse = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plan_operation', arguments: { idempotencyKey: 'stop-example-1', resourceId: stoppable.id, action: 'stop' } } }, operatorToken);
    const plan = (resultOf(planResponse).structuredContent as { plan: { id: string; state: string } }).plan;
    expect(plan.state).toBe('planned');
    expect(executions).toBe(0);

    const executeBody = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'execute_operation', arguments: { planId: plan.id } } };
    const first = await call(app, executeBody, operatorToken);
    const operation = (resultOf(first).structuredContent as { operation: { id: string } }).operation;
    const second = await call(app, { ...executeBody, id: 4 }, operatorToken);
    expect((resultOf(second).structuredContent as { operation: { id: string } }).operation.id).toBe(operation.id);
    expect(executions).toBe(1);
  });

  it('no autoriza recursos descubiertos read-only aunque el token tenga permiso operate', async () => {
    const operatorToken = 'infra-operator-secret';
    const discovered: Resource = { ...resource, id: 'catalog:read-only-resource', catalog: { catalogId: 'read-only-resource', provider: 'aws', accountId: '123456789012', region: 'us-east-1', resourceType: 'ec2-instance', providerId: 'i-example123', lifecycle: 'active' }, actions: [] };
    const operatorConfig = { ...config, agentTokens: [...config.agentTokens, { name: 'infra-operator', hash: tokenHash(operatorToken), scopes: ['read', 'operate'] as ('read'|'operate')[], mcpTools: ['plan_operation'] as ('plan_operation')[], operationPolicy: { actions: ['stop'] as ('stop')[], resourceIds: [discovered.id] } }] };
    const app = setupWith(operatorConfig, { inventory: async () => [discovered], localInventory: async () => [discovered], perform: async () => { throw new Error('Must not execute'); } });
    const result = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plan_operation', arguments: { idempotencyKey: 'new-resource', resourceId: discovered.id, action: 'stop' } } }, operatorToken);

    expect(result.status).toBe(200);
    expect((resultOf(result).isError)).toBe(true);
  });

  it('requiere una política explícita de acción y recurso incluso con scope operate', async () => {
    const operatorToken = 'infra-operator-secret';
    const stoppable: Resource = { ...resource, id: 'aws:test:i-example123', name: 'Example EC2', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'test', detail: 't3.small', actions: ['stop'], observedAt: new Date().toISOString() };
    const operatorConfig = { ...config, agentTokens: [...config.agentTokens, { name: 'infra-operator', hash: tokenHash(operatorToken), scopes: ['read', 'operate'] as ('read'|'operate')[], mcpTools: ['plan_operation'] as ('plan_operation')[] }] };
    const app = setupWith(operatorConfig, { inventory: async () => [stoppable], localInventory: async () => [stoppable], perform: async () => ({ message: 'Must not execute' }) });
    const result = await call(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plan_operation', arguments: { idempotencyKey: 'no-policy', resourceId: stoppable.id, action: 'stop' } } }, operatorToken);

    expect((resultOf(result).structuredContent as { error: { reason: string } }).error.reason).toBe('operation_not_permitted');
  });
  it('no deja operar un recurso oculto por readPolicy aunque operationPolicy lo nombre', async () => {
    const operatorToken='hidden-resource-secret';
    const hidden:Resource={...resource,id:'catalog:hidden-resource',state:'running',actions:['stop'],catalog:{catalogId:'hidden-resource',provider:'aws',accountId:'222222222222',region:'us-east-1',resourceType:'ec2-instance',providerId:'i-hidden',lifecycle:'active'}};
    const scopedConfig:Config={...config,agentTokens:[...config.agentTokens,{name:'scoped-operator',hash:tokenHash(operatorToken),scopes:['read','operate'],mcpTools:['plan_operation'],readPolicy:{accountIds:['111111111111']},operationPolicy:{actions:['stop'],catalogIds:['hidden-resource']}}]};
    const app=setupWith(scopedConfig,{inventory:async()=>[hidden],localInventory:async()=>[hidden],perform:async()=>({message:'must not run'})});
    const result=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'plan_operation',arguments:{idempotencyKey:'hidden-resource',resourceId:hidden.id,action:'stop'}}},operatorToken);
    expect((resultOf(result).structuredContent as {error:{reason:string}}).error.reason).toBe('operation_not_permitted');
  });
  it('invalida un plan si cambia la política después de prepararlo', async () => {
    const operatorToken='mutable-policy-secret';
    const stoppable:Resource={...resource,id:'aws:test:i-example123',state:'running',actions:['stop'],observedAt:new Date().toISOString()};
    const agent={name:'infra-operator',hash:tokenHash(operatorToken),scopes:['read','operate'] as ('read'|'operate')[],mcpTools:['plan_operation','execute_operation'] as ('plan_operation'|'execute_operation')[],operationPolicy:{actions:['stop'] as ('stop')[],resourceIds:[stoppable.id]}};
    const operatorConfig={...config,agentTokens:[...config.agentTokens,agent]};let executions=0;
    const app=setupWith(operatorConfig,{inventory:async()=>[stoppable],localInventory:async()=>[stoppable],perform:async()=>{executions++;return{message:'unused'};}});
    await call(app,initialize,operatorToken);
    const planResponse=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'plan_operation',arguments:{idempotencyKey:'policy-version',resourceId:stoppable.id,action:'stop'}}},operatorToken);
    const plan=(resultOf(planResponse).structuredContent as {plan:{id:string}}).plan;
    agent.operationPolicy.actions=[];
    const result=await call(app,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'execute_operation',arguments:{planId:plan.id}}},operatorToken);
    expect((resultOf(result).structuredContent as {error:{reason:string}}).error.reason).toBe('stale');
    expect(executions).toBe(0);
  });
  it('no revela una operación ya ejecutada al repetir el plan después de revocar la política', async () => {
    const operatorToken='revoked-after-execution-secret';
    const stoppable:Resource={...resource,id:'aws:test:i-revoked',state:'running',actions:['stop'],observedAt:new Date().toISOString()};
    const agent={name:'revocable-operator',hash:tokenHash(operatorToken),scopes:['read','operate'] as ('read'|'operate')[],mcpTools:['plan_operation','execute_operation'] as ('plan_operation'|'execute_operation')[],operationPolicy:{actions:['stop'] as ('stop')[],resourceIds:[stoppable.id]}};
    const operatorConfig={...config,agentTokens:[...config.agentTokens,agent]};
    const app=setupWith(operatorConfig,{inventory:async()=>[stoppable],localInventory:async()=>[stoppable],perform:async()=>({message:'Estado detenido confirmado.'})});
    const planned=await call(app,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'plan_operation',arguments:{idempotencyKey:'revoked-after-execution',resourceId:stoppable.id,action:'stop'}}},operatorToken);
    const plan=(resultOf(planned).structuredContent as {plan:{id:string}}).plan;
    const execute={jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'execute_operation',arguments:{planId:plan.id}}};
    expect((resultOf(await call(app,execute,operatorToken)).structuredContent as {operation:{state:string}}).operation.state).toBe('accepted');
    agent.operationPolicy.actions=[];
    const replay=await call(app,{...execute,id:4},operatorToken);
    expect((resultOf(replay).structuredContent as {error:{reason:string}}).error.reason).toBe('not_authorized');
  });

  it('valida Host y Origin en el endpoint remoto', async () => {
    const app = setup();
    const wrongHost = await request(app).post('/api/mcp').set('Host', 'evil.example').set('Authorization', 'Bearer infra-reader-secret').set('Accept', 'application/json, text/event-stream').send(initialize);
    const wrongOrigin = await request(app).post('/api/mcp').set('Host', new URL(origin).host).set('Origin', 'https://evil.example').set('Authorization', 'Bearer infra-reader-secret').set('Accept', 'application/json, text/event-stream').send(initialize);
    expect(wrongHost.status).toBe(421);
    expect(wrongOrigin.status).toBe(403);
  });
});
