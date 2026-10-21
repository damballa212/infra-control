import { describe, it, expect, vi } from 'vitest';
import { DesktopClient, type DesktopStatus } from '../server/desktop.js';
import { DesktopOfflineError } from '../server/operation-error.js';
const status = (online: boolean, ready = true): DesktopStatus => ({ ready, online, observedAt: new Date().toISOString() });
describe('WOL sin repetir escrituras ni confundir SSH ausente con apagado', () => {
 it('espera SSH con verificaciones acotadas y un solo envío', async () => {
  let checks = 0;
  const call = vi.fn(async (method: string) => method === 'POST' ? { sent: true } : status(++checks >= 3));
  const client = new DesktopClient('/unused', call, async () => {});
  expect((await client.wake()).message).toContain('SSH');
  expect(call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(1);
 });
 it('publica que WOL fue enviado y espera una señal del PC antes de confirmar', async () => {
  let checks = 0;
  const call = vi.fn(async (method: string) => method === 'POST' ? { sent: true } : status(++checks >= 2));
  const progress: string[] = [];
  await new DesktopClient('/unused', call, async () => {}).wake(message => progress.push(message));
  expect(progress[0]).toContain('WOL');
  expect(progress[0]?.toLowerCase()).toContain('esperando');
  expect(progress.at(-1)).toContain('no se han comprobado');
  expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
 });
 it('un envío ambiguo no se repite', async () => {
  const call = vi.fn(async () => { throw new Error('private detail'); });
  await expect(new DesktopClient('/unused', call).wake()).rejects.toThrow('recepción'); expect(call).toHaveBeenCalledTimes(1);
 });
 it('no declara apagado si SSH no responde ni éxito si WOL no arranca', async () => {
  const call = vi.fn(async (m: string) => m === 'POST' ? { sent: true } : status(false));
  const client = new DesktopClient('/unused', call, async () => {});
  expect(await client.resource()).toMatchObject({ state: 'unreachable', actions: ['start', 'refresh'] });
  await expect(client.wake()).rejects.toThrow('no respondió');
  expect(call.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(26);
 });
 it('sin túnel no habilita WOL; SSH accesible no implica salud de aplicaciones', async () => {
  expect(await new DesktopClient('/unused', async () => status(false, false)).resource()).toMatchObject({ state: 'unknown', actions: ['refresh'] });
  expect(await new DesktopClient('/unused', async () => status(true)).resource()).toMatchObject({ state: 'running', actions: ['refresh'] });
 });
});
describe('apagado y dual boot con identidad de sistema', () => {
 it('ofrece apagar y cambiar solo cuando el SO está autenticado', async () => {
  const client = new DesktopClient('/unused', async () => ({ ...status(true), controlled:true, os:'cachyos', bootId:'linux-boot-one' }));
  expect(await client.resource()).toMatchObject({system:'cachyos',actions:['stop','boot-windows','boot-cachyos','refresh']});
 });
 it('no confirma cambio con el mismo bootId ni con otro SO; nunca repite la orden', async () => {
  let reads=0;
  const call=vi.fn(async (method:string) => method==='POST' ? {accepted:true,before:{bootId:'old'}} : {...status(true),controlled:true,os:++reads<3?'cachyos':'windows',bootId:reads<3?'old':'new'});
  const client=new DesktopClient('/unused',call,async()=>{});
  expect((await client.power('boot-windows')).message).toContain('Windows inició');
  expect(call.mock.calls.filter(([m])=>m==='POST')).toHaveLength(1);
 });
 it('un envío ambiguo de apagado no se repite', async () => {
  const call=vi.fn(async()=>{throw new Error('private');});
  await expect(new DesktopClient('/unused',call).power('stop')).rejects.toThrow('recepción');
  expect(call).toHaveBeenCalledTimes(1);
 });
 it('apagado necesita recepción confirmada y dos ausencias SSH con túnel sano', async () => {
  const call=vi.fn(async(m:string)=>m==='POST'?{accepted:true,before:{bootId:'old'}}:{...status(false),controlled:false});
  expect((await new DesktopClient('/unused',call,async()=>{}).power('stop')).message).toContain('orden de apagado');
  expect(call).toHaveBeenCalledTimes(3);
 });
});

describe('estado comunicado sin sondeos al PC',()=>{
 it('inventario y verificación leen avisos locales; solo envía una mutación al broker',async()=>{
  let current:DesktopStatus={ready:true,online:true,controlled:true,os:'cachyos',bootId:'boot-one',observedAt:new Date().toISOString(),source:'push',phase:'running'};
  const call=vi.fn(async()=>({accepted:true,before:{...current}}));
  const client=new DesktopClient('/unused',call,async()=>{current={...current,os:'windows',bootId:'boot-two'};},()=>current);
  expect(await client.resource()).toMatchObject({state:'running',system:'cachyos'});
  expect(call).not.toHaveBeenCalled();
  expect((await client.power('boot-windows')).message).toContain('comunicó al panel');
  expect(call.mock.calls).toEqual([['POST','/power/windows?os=cachyos']]);
 });
});

describe('ritmo de verificación',()=>{
 it('con avisos locales de la PC revisa cada segundo; sin ellos conserva los 5 s de las llamadas SSH',async()=>{
  const pushedPauses:number[]=[];
  let current:DesktopStatus={ready:true,online:true,controlled:true,os:'cachyos',bootId:'boot-one',observedAt:new Date().toISOString(),source:'push',phase:'running'};
  const call=vi.fn(async()=>({accepted:true,before:{...current}}));
  const pushed=new DesktopClient('/unused',call,async ms=>{pushedPauses.push(ms);current={...current,os:'windows',bootId:'boot-two'};},()=>current);
  await pushed.power('boot-windows');
  expect(pushedPauses).toEqual([1000]);
  const sshPauses:number[]=[];
  const sshCall=vi.fn(async(method:string)=>method==='POST'?{accepted:true,before:{bootId:'old'}}:{...status(false),controlled:false});
  await new DesktopClient('/unused',sshCall,async ms=>{sshPauses.push(ms);}).power('stop');
  expect(sshPauses.every(ms=>ms===5000)).toBe(true);
 });
});

it('encender con SO distinto respeta cooldown WOL antes de cambiar, sin repetir comandos',async()=>{
 let current:DesktopStatus={ready:true,online:false,observedAt:new Date().toISOString(),source:'push',phase:'stopped'};
 const call=vi.fn(async(_method:string,path:string)=>path==='/wake'?{sent:true}:{accepted:true,before:{bootId:'default-boot'}});
 const pauses:number[]=[];
 const client=new DesktopClient('/unused',call,async ms=>{
  pauses.push(ms);
  current={...current,online:true,controlled:true,os:call.mock.calls.length>1?'windows':'cachyos',bootId:call.mock.calls.length>1?'windows-boot':'default-boot',phase:'running'};
 },()=>current);
 expect((await client.power('boot-windows')).message).toContain('Windows inició');
 expect(call.mock.calls).toEqual([['POST','/wake'],['POST','/power/windows?os=cachyos']]);
 expect(pauses.some(ms=>ms>30000)).toBe(true);
});

describe('preferencia UEFI persistente',()=>{
 it('verifica identidad privada antes de pedir el cambio y acepta solo lectura de vuelta coincidente',async()=>{
  const call=vi.fn(async(_method:string,path:string)=>path==='/status'
   ?{ready:true,online:true,controlled:true,os:'windows',bootId:'windows-boot',defaultSystem:'cachyos',observedAt:new Date().toISOString()}
   :{accepted:true,applied:true,verified:true,defaultSystem:'windows',verifiedAt:new Date().toISOString()});
  const client=new DesktopClient('/unused',call);
  expect(await client.setBootDefault('windows')).toMatchObject({defaultSystem:'windows'});
  expect(call.mock.calls.map(([method,path])=>[method,path])).toEqual([['GET','/status'],['POST','/boot-default/windows']]);
 });
 it('deja la intención pendiente si el preflight no autentica la PC y no intenta escribir',async()=>{
  const call=vi.fn(async()=>({ready:true,online:false,controlled:false}));
  await expect(new DesktopClient('/unused',call).setBootDefault('windows')).rejects.toBeInstanceOf(DesktopOfflineError);
  expect(call).toHaveBeenCalledTimes(1);
 });
 it('reutiliza el último SO activo comunicado para fijar el orden UEFI sin sondear primero el banner',async()=>{
  const observedAt=new Date().toISOString();
  const pushed:DesktopStatus={ready:true,online:true,controlled:true,os:'windows',bootId:'windows-current',observedAt,source:'push',phase:'running'};
  const call=vi.fn(async(_method:string,path:string)=>path==='/status?os=windows'
   ?{ready:true,online:true,controlled:true,os:'windows',bootId:'windows-current',defaultSystem:'cachyos',observedAt}
   :{accepted:true,applied:true,verified:true,defaultSystem:'cachyos',verifiedAt:observedAt});
  const client=new DesktopClient('/unused',call,undefined,()=>pushed);
  await expect(client.setBootDefault('cachyos')).resolves.toMatchObject({defaultSystem:'cachyos'});
  expect(call.mock.calls).toEqual([['GET','/status?os=windows'],['POST','/boot-default/cachyos?os=windows']]);
 });
 it('no reutiliza como pista un SO reportado hace más de 45 segundos',async()=>{
  const current= new Date().toISOString(),stale=new Date(Date.now()-90000).toISOString();
  const pushed:DesktopStatus={ready:true,online:true,controlled:true,os:'windows',bootId:'old-windows',observedAt:stale,source:'push',phase:'running'};
  const call=vi.fn(async(_method:string,path:string)=>path==='/status'
   ?{ready:true,online:true,controlled:true,os:'cachyos',bootId:'linux-current',defaultSystem:'windows',observedAt:current}
   :{accepted:true,applied:true,verified:true,defaultSystem:'windows',verifiedAt:current});
  const client=new DesktopClient('/unused',call,undefined,()=>pushed);
  await expect(client.setBootDefault('windows')).resolves.toMatchObject({defaultSystem:'windows'});
  expect(call.mock.calls).toEqual([['GET','/status'],['POST','/boot-default/windows']]);
 });
 it('marca incierto un ACK ambiguo después del preflight y no reenvía la escritura',async()=>{
  let calls=0;
  const call=vi.fn(async(_method:string,path:string)=>{
   if(path==='/status')return{ready:true,online:true,controlled:true,os:'cachyos',bootId:'linux-boot',defaultSystem:'cachyos',observedAt:new Date().toISOString()};
   calls++;throw new Error('socket closed');
  });
  await expect(new DesktopClient('/unused',call).setBootDefault('windows')).rejects.toThrow('No se confirmó');
  expect(calls).toBe(1);
 });
});

describe('sondeo privado del router',()=>{
 it('usa el endpoint solo-router y conserva un ACK negativo explícito',async()=>{
  const call=vi.fn(async(_method:string,path:string)=>{
   if(path!=='/router/status')throw new Error('wrong route');
   return {ready:true};
  });
  const client=new DesktopClient('/unused',call);
  await expect(client.checkRouter()).resolves.toEqual({ready:true});
  call.mockResolvedValueOnce({ready:false});
  await expect(client.checkRouter()).resolves.toEqual({ready:false});
  expect(call.mock.calls.map(([method,path])=>[method,path])).toEqual([['GET','/router/status'],['GET','/router/status']]);
 });

 it('propaga fallo o respuesta inválida del broker sin convertirlos en túnel caído',async()=>{
  const call=vi.fn(async()=>{throw new Error('private socket detail');});
  const unavailable=new DesktopClient('/unused',call);
  await expect(unavailable.checkRouter()).rejects.toThrow('private socket detail');
  const malformed=new DesktopClient('/unused',async()=>({ready:'false'}));
  await expect(malformed.checkRouter()).rejects.toThrow('Invalid router status');
 });
});

describe('canal directo con respaldo SSH',()=>{
 const running=():DesktopStatus=>({ready:true,online:true,controlled:true,os:'cachyos',bootId:'boot-one',observedAt:new Date().toISOString(),source:'push',phase:'running'});
 const make=(sendResult:{ok:true;deliveryMs:number;ackMs:number}|{ok:false;reason:'unavailable'|'not-delivered'|'refused'|'uncertain'})=>{
  let current=running();
  const call=vi.fn(async()=>({accepted:true,before:{...current}}));
  const send=vi.fn(async()=>sendResult);
  const channel={available:()=>true,send};
  const client=new DesktopClient('/unused',call,async()=>{current={...current,os:'windows',bootId:'boot-two'};},()=>current,channel);
  return {call,send,client};
 };
 it('con el agente conectado la orden va por el canal y no toca el broker SSH',async()=>{
  const {call,send,client}=make({ok:true,deliveryMs:20,ackMs:80});
  const progress:string[]=[];
  const result=await client.power('boot-windows',message=>progress.push(message));
  expect(send).toHaveBeenCalledWith('cachyos','windows','boot-one');
  expect(call).not.toHaveBeenCalled();
  expect(progress.join(' ')).toContain('canal directo');
  expect(result.message).toContain('Windows');
 });
 it('reiniciar en el mismo sistema también usa el canal, y se confirma con un bootId nuevo',async()=>{
  let current=running();
  const call=vi.fn(async()=>({accepted:true,before:{...current}}));
  const send=vi.fn(async()=>({ok:true as const,deliveryMs:20,ackMs:80}));
  const client=new DesktopClient('/unused',call,async()=>{current={...current,bootId:'boot-two'};},()=>current,{available:()=>true,send});
  const result=await client.power('boot-cachyos');
  expect(send).toHaveBeenCalledWith('cachyos','cachyos','boot-one');
  expect(call).not.toHaveBeenCalled();
  expect(result.message).toContain('CachyOS');
 });
 it.each(['unavailable','not-delivered','refused'] as const)('si el canal no ejecutó la orden (%s) usa el camino SSH de siempre',async reason=>{
  const {call,send,client}=make({ok:false,reason});
  await client.power('boot-windows');
  expect(send).toHaveBeenCalledTimes(1);
  expect(call.mock.calls).toEqual([['POST','/power/windows?os=cachyos']]);
 });
 it('entregada sin confirmación queda incierta y NUNCA se reenvía por SSH',async()=>{
  const {call,client}=make({ok:false,reason:'uncertain'});
  await expect(client.power('boot-windows')).rejects.toThrow('recepción');
  expect(call).not.toHaveBeenCalled();
 });
 it('sin avisos locales de la PC no hay canal: se conserva el camino SSH',async()=>{
  const send=vi.fn();
  const call=vi.fn(async(method:string)=>method==='POST'?{accepted:true,before:{bootId:'old'}}:{...status(false),controlled:false});
  await new DesktopClient('/unused',call,async()=>{},undefined,{available:()=>true,send}).power('stop');
  expect(send).not.toHaveBeenCalled();
 });
});

