import { afterEach, describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type {Config} from '../server/types.js';
const apps:ReturnType<typeof createApp>[]=[];afterEach(()=>apps.splice(0).forEach(a=>a.locals.close()));
const config:Config={origin:'https://test.example',passwordHash:'not-used',agentTokens:[{name:'reader',hash:tokenHash('reader-token'),scopes:['read']}],aws:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},desktop:{socketPath:'/nonexistent',reportTokenHashes:{cachyos:tokenHash('linux-device-only'),windows:tokenHash('windows-device-only')}}};
function setup(appConfig:Config=config){const a=createApp(appConfig,':memory:');apps.push(a);return a;}
const event={bootId:'linux-boot-123',sequence:1,event:'online'};
describe('ingreso PC solo con credencial específica, sin acceso administrativo',()=>{
 it('autoriza solo su SO, no permite al dispositivo leer/operar API ni usar token humano como aviso',async()=>{
  const app=setup();
  expect((await request(app).post('/api/desktop/events').set('Authorization','Bearer reader-token').send(event)).status).toBe(401);
  expect((await request(app).post('/api/desktop/events').set('Authorization','Bearer linux-device-only').send(event)).status).toBe(204);
  const r=await request(app).get('/api/resources').set('Authorization','Bearer reader-token');
  expect(r.body.resources.find((x:{id:string})=>x.id==='computer:desktop')).toMatchObject({
   state:'running',system:'cachyos',actions:['stop','boot-windows','boot-cachyos','refresh'],
   health:{presence:{state:'fresh',source:'pc-reporter'},control:{state:'degraded',reasonCode:'command_path_not_probed'},service:{state:'unknown',reasonCode:'application_health_not_probed'}},
   actionAvailability:{start:{allowed:false,reasonCode:'already_running'},'boot-windows':{allowed:true,reasonCode:'available'},'boot-cachyos':{allowed:true,reasonCode:'available'}}
  });
  expect((await request(app).get('/api/resources').set('Authorization','Bearer linux-device-only')).status).toBe(401);
  expect((await request(app).post('/api/desktop/events').set('Authorization','Bearer linux-device-only').send({...event,os:'windows'})).status).toBe(400);
 });
 it('no renueva avisos antiguos ni acepta parámetros adicionales',async()=>{
  const app=setup();const post=(body:object)=>request(app).post('/api/desktop/events').set('Authorization','Bearer windows-device-only').send(body);
  expect((await post({...event,sequence:3})).status).toBe(204);
  expect((await post({...event,sequence:2})).status).toBe(409);
  expect((await post({...event,sequence:4,shell:'whoami'})).status).toBe(400);
 });
 it('reproduce los cambios desktop tras Last-Event-ID sin consultar la PC',async()=>{
  const app=setup();
  expect((await request(app).post('/api/desktop/events').set('Authorization','Bearer linux-device-only').send(event)).status).toBe(204);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const controller=new AbortController();
   const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`,{headers:{Authorization:'Bearer reader-token','Last-Event-ID':'0'},signal:controller.signal});
   expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');
   const reader=response.body!.getReader();let content='';
   for(let count=0;count<4&&!content.includes('event: desktop');count++){
    const chunk=await reader.read();if(chunk.done)break;content+=new TextDecoder().decode(chunk.value);
   }
   expect(content).toContain('id: 1');expect(content).toContain('event: desktop');expect(content).toContain('"system":"cachyos"');
   await reader.cancel();controller.abort();
  }finally{app.locals.closeStreams();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('filtra el replay SSE por el readPolicy del agente sin filtrar IDs ocultos',async()=>{
  const scoped=setup({...config,agentTokens:[{name:'reader',hash:tokenHash('reader-token'),scopes:['read'],readPolicy:{resourceIds:['computer:desktop']}}]});
  const {body:{cursor}}=await request(scoped).get('/api/resources').set('Authorization','Bearer reader-token').expect(200);
  scoped.locals.store.appendEvent('resource','computer:mac',{state:'running',marker:'mac-private'});
  scoped.locals.store.appendEvent('resource','computer:desktop',{state:'running',system:'cachyos'});
  const server=scoped.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const controller=new AbortController();
   const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`,{headers:{Authorization:'Bearer reader-token','Last-Event-ID':cursor},signal:controller.signal});
   expect(response.status).toBe(200);
   const reader=response.body!.getReader();let content='';
   for(let count=0;count<4&&!content.includes('event: resource');count++){const chunk=await reader.read();if(chunk.done)break;content+=new TextDecoder().decode(chunk.value);}
   expect(content).toMatch(/id: [^\n]*[a-zA-Z_-][^\n]*/);expect(content).toContain('"system":"cachyos"');expect(content).not.toContain('mac-private');
   await reader.cancel();controller.abort();
  }finally{scoped.locals.closeStreams();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('filtra eventos de cobertura SSE por el scope autorizado',async()=>{
  const scoped=setup({...config,aws:[{name:'visible',accountId:'111111111111',accessKeyId:'fixture',secretAccessKey:'fixture',instances:[
   {id:'i-visible',region:'us-east-1',name:'Visible',type:'t3.small'},{id:'i-hidden',region:'us-east-2',name:'Hidden',type:'t3.small'}
  ]}],agentTokens:[{name:'reader',hash:tokenHash('reader-token'),scopes:['read'],readPolicy:{resourceIds:['aws:visible:i-visible']}}]});
  const {body:{cursor}}=await request(scoped).get('/api/resources').set('Authorization','Bearer reader-token').expect(200);
  const visible=scoped.locals.catalog.connections()[0]!;
  const observedAt=new Date().toISOString();
  scoped.locals.catalog.reconcileScope(visible.id,'aws:ec2:us-east-1',[{providerId:'i-visible',resourceType:'ec2-instance',region:'us-east-1',name:'Visible',state:'running',detail:'t3.small',observedAt,aliases:['aws:visible:i-visible']}],{complete:true,observedAt});
  scoped.locals.catalog.reconcileScope(visible.id,'aws:ec2:us-east-2',[{providerId:'i-hidden',resourceType:'ec2-instance',region:'us-east-2',name:'Hidden',state:'running',detail:'t3.small',observedAt,aliases:['aws:visible:i-hidden']}],{complete:true,observedAt});
  scoped.locals.store.appendEvent('coverage',`coverage:${visible.id}:aws:ec2:us-east-1`,{connectionId:visible.id,scopeKey:'aws:ec2:us-east-1',state:'partial',resourceCount:2});
  scoped.locals.store.appendEvent('coverage',`coverage:${visible.id}:aws:ec2:us-east-2`,{connectionId:visible.id,scopeKey:'aws:ec2:us-east-2',state:'failed'});
  const server=scoped.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const controller=new AbortController();
   const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events?cursor=${encodeURIComponent(cursor)}`,{headers:{Authorization:'Bearer reader-token'},signal:controller.signal});
   expect(response.status).toBe(200);
   const reader=response.body!.getReader();let content='';
   while(true){
    const result=await Promise.race([reader.read(),new Promise<null>(resolve=>setTimeout(()=>resolve(null),200))]);
    if(!result||result.done)break;
    content+=new TextDecoder().decode(result.value);
   }
   expect(content).toContain('"scopeKey":"aws:ec2:us-east-1"');
   expect(content).toContain('"resourceCount":1');
   expect(content).not.toContain('"resourceCount":2');
   expect(content).not.toContain('aws:ec2:us-east-2');
   await reader.cancel();controller.abort();
  }finally{scoped.locals.closeStreams();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('rechaza cursores malformados y pide resync si el cliente llega desde el futuro',async()=>{
  const app=setup();
  expect((await request(app).get('/api/events').set('Authorization','Bearer reader-token').set('Last-Event-ID','-1')).status).toBe(400);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const controller=new AbortController();
   const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`,{headers:{Authorization:'Bearer reader-token','Last-Event-ID':'999'},signal:controller.signal});
   const reader=response.body!.getReader();let content='';
   for(let count=0;count<4&&!content.includes('event: resync');count++){
    const chunk=await reader.read();if(chunk.done)break;content+=new TextDecoder().decode(chunk.value);
   }
   expect(content).toContain('event: resync');expect(content).toContain('"snapshotRequired":true');
   await reader.cancel();controller.abort();
  }finally{app.locals.closeStreams();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
