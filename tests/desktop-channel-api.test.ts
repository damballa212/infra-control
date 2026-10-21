import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { DesktopCommandChannel } from '../server/desktop-commands.js';
import type {Config} from '../server/types.js';
const apps:ReturnType<typeof createApp>[]=[];afterEach(()=>apps.splice(0).forEach(a=>a.locals.close()));
const config:Config={origin:'https://test.example',passwordHash:'not-used',agentTokens:[{name:'reader',hash:tokenHash('reader-token'),scopes:['read']}],aws:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},desktop:{socketPath:'/nonexistent',reportTokenHashes:{cachyos:tokenHash('linux-device-only'),windows:tokenHash('windows-device-only')}}};
function setup(){const a=createApp(config,':memory:');apps.push(a);return a;}
const channelOf=(app:ReturnType<typeof createApp>)=>app.locals.commandChannel as DesktopCommandChannel;
const windows='Bearer windows-device-only';
describe('API del canal de órdenes de la PC',()=>{
 it('exige el token específico del sistema: ni el lector ni un token ajeno pueden usarlo',async()=>{
  const app=setup();
  expect((await request(app).get('/api/desktop/commands?wait=0&caps=power')).status).toBe(401);
  expect((await request(app).get('/api/desktop/commands?wait=0&caps=power').set('Authorization','Bearer reader-token')).status).toBe(401);
  const ack='/api/desktop/commands/00000000-0000-0000-0000-000000000000/ack';
  expect((await request(app).post(ack).send({accepted:true,bootId:'x'})).status).toBe(403);
  expect((await request(app).post(ack).set('Authorization','Bearer reader-token').send({accepted:true,bootId:'x'})).status).toBe(401);
 });
 it('sin órdenes responde 204 y registra al agente con sus capacidades; ignora capacidades desconocidas',async()=>{
  const app=setup();
  const r=await request(app).get('/api/desktop/commands?wait=0&caps=power,rm-rf').set('Authorization',windows);
  expect(r.status).toBe(204);
  expect(channelOf(app).snapshot('windows').caps).toEqual(['power']);
  expect(channelOf(app).snapshot('cachyos').connected).toBe(false);
 });
 it('entrega una orden al agente conectado y acepta su confirmación; el ack de otro sistema no vale',async()=>{
  const app=setup();
  const polling=request(app).get('/api/desktop/commands?wait=5&caps=power').set('Authorization',windows).then(r=>r);
  await new Promise(resolve=>setTimeout(resolve,50));
  const sent=channelOf(app).send('windows','off','boot-1');
  const delivered=await polling;
  expect(delivered.status).toBe(200);
  expect(delivered.body).toMatchObject({command:'off',expectedBootId:'boot-1'});
  const id=delivered.body.id as string;
  expect((await request(app).post(`/api/desktop/commands/${id}/ack`).set('Authorization','Bearer linux-device-only').send({accepted:true,bootId:'boot-1'})).status).toBe(409);
  expect((await request(app).post(`/api/desktop/commands/${id}/ack`).set('Authorization',windows).send({accepted:true,bootId:'boot-1',extra:1})).status).toBe(400);
  expect((await request(app).post(`/api/desktop/commands/${id}/ack`).set('Authorization',windows).send({accepted:true,bootId:'boot-1'})).status).toBe(204);
  expect((await sent).ok).toBe(true);
 });
 it('al conectar el agente mide la latencia con un ping y la guarda para diagnóstico',async()=>{
  const app=setup();
  const polling=await request(app).get('/api/desktop/commands?wait=1&caps=ping').set('Authorization',windows);
  expect(polling.status).toBe(200);
  expect(polling.body).toMatchObject({command:'ping'});
  expect((await request(app).post(`/api/desktop/commands/${polling.body.id}/ack`).set('Authorization',windows).send({accepted:true,bootId:'boot-1'})).status).toBe(204);
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(channelOf(app).snapshot('windows').lastPingMs).toBeGreaterThanOrEqual(0);
 });
});
