import { EventEmitter } from 'node:events';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createBroker, pcOnline, routerCommand } from '../server/wol-broker.js';

class FakeSocket extends EventEmitter {
 timeoutHandler?: () => void;
 readonly destroy=vi.fn();
 setTimeout(_ms:number,handler:()=>void){this.timeoutHandler=handler;return this;}
}

describe('sondeo y comandos fijados del broker',()=>{
 it('verifica las respuestas del FiberHome y nunca crea un shell remoto',async()=>{
  const execute=vi.fn(async(_file:string,_args:string[],_options:unknown)=>({stdout:'{"ready":true}',stderr:''}));
  await expect(routerCommand('check',execute as never)).resolves.toEqual({ready:true});
  const [file,args,options]=execute.mock.calls[0]!;
  expect(file).toBe('/usr/bin/ssh');expect(args.slice(-2)).toEqual(['root@127.0.0.1','check']);expect(args).toContain('StrictHostKeyChecking=yes');expect(options).toMatchObject({timeout:9000,maxBuffer:4096});
  execute.mockResolvedValueOnce({stdout:'{"mac":"02:00:00:00:00:01","sent":true,"packets":3}',stderr:''});
  await expect(routerCommand('wake',execute as never)).resolves.toMatchObject({sent:true,packets:3});
  execute.mockResolvedValueOnce({stdout:'{"ready":true}',stderr:''});
  await expect(routerCommand('wake',execute as never)).rejects.toThrow('acknowledgement');
 });

 it('detecta solo un banner SSH válido y resuelve silencio o error como fuera de línea',async()=>{
  const valid=new FakeSocket();const connect=vi.fn(()=>valid as never);const online=pcOnline(connect as never);
  expect(connect).toHaveBeenCalledWith({host:'127.0.0.1',port:17723});
  valid.emit('data',Buffer.from('SSH-2.0-OpenSSH\n'));
  await expect(online).resolves.toBe(true);expect(valid.destroy).toHaveBeenCalledOnce();
  const invalid=new FakeSocket(),invalidOnline=pcOnline(vi.fn(()=>invalid as never));invalid.emit('data',Buffer.from('bad\n'));
  await expect(invalidOnline).resolves.toBe(false);
  const failed=new FakeSocket(),failedOnline=pcOnline(vi.fn(()=>failed as never));failed.emit('error',new Error('refused'));
  await expect(failedOnline).resolves.toBe(false);
  const timeout=new FakeSocket(),timeoutOnline=pcOnline(vi.fn(()=>timeout as never));timeout.timeoutHandler?.();
  await expect(timeoutOnline).resolves.toBe(false);
 });
});

describe('broker privado WOL', () => {
 it('comprueba solo el FiberHome sin consultar el estado de la PC', async () => {
  const routerCommand=vi.fn(async()=>({ready:true})),pcStatus=vi.fn(async()=>({online:true,controlled:true,os:'windows' as const,bootId:'boot-id'}));
  const app=createBroker({routerCommand,pcOnline:async()=>true,now:()=>100000,pcStatus});
  expect((await request(app).get('/router/status')).body).toMatchObject({ready:true,observedAt:new Date(100000).toISOString()});
  expect(routerCommand.mock.calls).toEqual([['check']]);
  expect(pcStatus).not.toHaveBeenCalled();
 });

 it('expone solo estado y una orden fija; rechaza destinos y comandos arbitrarios', async () => {
  const routerCommand = vi.fn(async () => ({ sent: true }));
  const app = createBroker({ routerCommand, pcOnline: async () => false, now: () => 100000 });
  expect((await request(app).get('/status')).body).toMatchObject({ ready: true, online: false });
  expect((await request(app).post('/wake?target=other')).status).toBe(404);
  expect((await request(app).post('/wake')).body).toEqual({ sent: true });
  expect((await request(app).post('/wake')).status).toBe(429);
  expect(routerCommand.mock.calls).toEqual([['check'], ['wake']]);
 });
 it('suprime datos privados al fallar y conserva enfriamiento tras una recepción ambigua', async () => {
  const routerCommand = vi.fn(async () => { throw new Error('private key path and debug'); });
  const app = createBroker({ routerCommand, pcOnline: async () => false, now: () => 100000 });
  const status = await request(app).get('/status'); expect(status.body).toMatchObject({ ready: false, online: false });
  const result = await request(app).post('/wake'); expect(result.status).toBe(502); expect(result.text).not.toContain('private');
  expect((await request(app).post('/wake')).status).toBe(429);
 });
});
describe('frontera privilegiada de apagado/dualboot', () => {
 const before={online:true,controlled:true,os:'cachyos' as const,bootId:'old-linux'};
 it('rechaza identidad no autenticada sin enviar ningún comando',async()=>{
  const pcCommand=vi.fn(async()=>({accepted:true}));
  const base={routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcCommand};
  const denied=createBroker({...base,pcStatus:async()=>({online:true,controlled:false})});
  expect((await request(denied).post('/power/windows')).status).toBe(409);
  expect(pcCommand).not.toHaveBeenCalled();
 });
 it('reiniciar en el mismo sistema envía el mismo comando fijo y confirma con la identidad autenticada',async()=>{
  const pcCommand=vi.fn(async()=>({accepted:true}));
  const same=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>before,pcCommand});
  expect((await request(same).post('/power/cachyos')).body).toMatchObject({accepted:true,before,target:'cachyos'});
  expect(pcCommand.mock.calls).toEqual([['cachyos','cachyos']]);
 });
 it.each([['off','off'],['windows','windows']])('mapea /power/%s a un único comando fijo',async(path,command)=>{
  const pcCommand=vi.fn(async()=>({accepted:true}));
  const app=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>before,pcCommand});
  expect((await request(app).post('/power/'+path)).body).toMatchObject({accepted:true,before,target:command});
  expect(pcCommand.mock.calls).toEqual([['cachyos',command]]);
  expect((await request(app).post('/power/'+path)).status).toBe(429);
 });
 it('Windows puede solicitar CachyOS y un fallo ambiguo conserva enfriamiento',async()=>{
  const pcCommand=vi.fn(async()=>{throw new Error('secret');});
  const app=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>({...before,os:'windows'}),pcCommand});
  const r=await request(app).post('/power/cachyos');expect(r.status).toBe(502);expect(r.text).not.toContain('secret');
  expect(pcCommand.mock.calls).toEqual([['windows','cachyos']]);
  expect((await request(app).post('/power/cachyos')).status).toBe(429);
 });
 it('cambia el default persistente sin gastar el enfriamiento de energía y preserva el ACK verificado',async()=>{
  const pcCommand=vi.fn(async(_os:string,command:string)=>command.startsWith('default-')
   ?{accepted:true,applied:true,verified:true,defaultSystem:'windows'}
   :{accepted:true});
  const app=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>before,pcCommand});
  const preference=await request(app).post('/boot-default/windows');
  expect(preference.status).toBe(200);
  expect(preference.body).toMatchObject({accepted:true,applied:true,verified:true,defaultSystem:'windows'});
  expect((await request(app).post('/power/windows')).status).toBe(200);
  expect(pcCommand.mock.calls.map(([,command])=>command)).toEqual(['default-windows','windows']);
 });

 it('falla cerrado cuando no hay control de PC o no se puede probar su identidad',async()=>{
  const unavailable=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>false,now:()=>100000});
  expect((await request(unavailable).post('/power/off')).status).toBe(503);
  expect((await request(unavailable).post('/boot-default/cachyos')).status).toBe(503);

  const noIdentity=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>false,now:()=>100000,pcStatus:async()=>({online:true,controlled:false}),pcCommand:vi.fn(async()=>({accepted:true}))});
  expect((await request(noIdentity).post('/power/windows')).status).toBe(409);
  expect((await request(noIdentity).post('/boot-default/cachyos')).status).toBe(409);
 });

 it('no afirma que el arranque predeterminado quedó guardado sin ACK completo y oculta fallos de estado',async()=>{
  const unverified=createBroker({routerCommand:vi.fn(async()=>({})),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>before,pcCommand:vi.fn(async()=>({accepted:true,applied:true,verified:false,defaultSystem:'windows'}))});
  const failed=await request(unverified).post('/boot-default/windows');expect(failed.status).toBe(502);expect(failed.text).not.toContain('private');

  const brokenStatus=createBroker({routerCommand:vi.fn(async()=>{throw new Error('router credential');}),pcOnline:async()=>true,now:()=>100000,pcStatus:async()=>{throw new Error('PC credential');}});
  const status=await request(brokenStatus).get('/status');
  expect(status.status).toBe(200);expect(status.body).toMatchObject({ready:false,online:false,controlled:false});
  expect(status.text).not.toContain('credential');
  expect((await request(brokenStatus).get('/wake')).status).toBe(404);
 });
 it('acepta únicamente la pista de SO cerrada y la usa en el preflight SSH', async()=>{
  const pcStatus=vi.fn(async(os?:'windows'|'cachyos')=>({online:true,controlled:true,os:os??'windows',bootId:'current-boot'}));
  const pcCommand=vi.fn(async()=>({accepted:true}));
  const app=createBroker({routerCommand:vi.fn(async()=>({ready:true})),pcOnline:async()=>true,now:()=>100000,pcStatus,pcCommand});
  expect((await request(app).get('/status?os=windows')).body).toMatchObject({controlled:true,os:'windows'});
  expect(pcStatus).toHaveBeenLastCalledWith('windows');
  expect((await request(app).post('/power/cachyos?os=windows')).status).toBe(200);
  expect(pcStatus).toHaveBeenLastCalledWith('windows');
  expect(pcCommand).toHaveBeenCalledWith('windows','cachyos');
  expect((await request(app).get('/status?os=windows&os=cachyos')).status).toBe(404);
  expect((await request(app).post('/power/cachyos?os=127.0.0.1')).status).toBe(404);
 });
});
