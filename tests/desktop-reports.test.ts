import { afterEach, describe, it, expect, vi } from 'vitest';
import { Store } from '../server/store.js';
import { DesktopReports } from '../server/desktop-reports.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
function setup(){let now=100000;const store=new Store(':memory:');stores.push(store);const reports=new DesktopReports(store,()=>now);return{reports,store,tick:(ms:number)=>{now+=ms;}};}
describe('avisos PC persistentes, sin sondeos al equipo',()=>{
 it('actualiza sistema al recibir aviso y lo conserva tras recrear el servicio',()=>{
  const {reports,store}=setup();expect(reports.status()).toMatchObject({online:false,phase:'unknown'});
  expect(reports.accept('cachyos',{bootId:'linux-boot-1',sequence:1,event:'online'})).toBe(true);
  expect(reports.status()).toMatchObject({online:true,controlled:true,os:'cachyos',bootId:'linux-boot-1'});
  expect(new DesktopReports(store,()=>100000).status()).toMatchObject({os:'cachyos',online:true});
 });
 it('no acepta secuencias antiguas ni el arranque anterior después de cambiar SO',()=>{
  const {reports}=setup();reports.accept('cachyos',{bootId:'linux-boot-1',sequence:3,event:'online'});
  expect(reports.accept('cachyos',{bootId:'linux-boot-1',sequence:2,event:'heartbeat'})).toBe(false);
  reports.accept('windows',{bootId:'windows-boot-1',sequence:1,event:'online'});
  expect(reports.accept('cachyos',{bootId:'linux-boot-1',sequence:4,event:'heartbeat'})).toBe(false);
  expect(reports.status().os).toBe('windows');
 });
 it('la pérdida de heartbeat es sin señal, nunca apagado confirmado',()=>{
  const {reports,tick}=setup();reports.accept('windows',{bootId:'windows-boot-1',sequence:1,event:'online'});tick(91000);
  expect(reports.status()).toMatchObject({online:false,controlled:false,phase:'unreachable'});
 });
 it('expira presencia en45s (cuatro ciclos y medio de heartbeat), sin declarar apagado',async()=>{
  vi.useFakeTimers();vi.setSystemTime(100000);
  const store=new Store(':memory:');stores.push(store);const reports=new DesktopReports(store,()=>Date.now());
  reports.accept('windows',{bootId:'windows-boot-1',sequence:1,event:'online'});
  await vi.advanceTimersByTimeAsync(44999);expect(reports.status().phase).toBe('running');
  await vi.advanceTimersByTimeAsync(1);expect(reports.status().phase).toBe('unreachable');
  expect(store.eventsAfter(0).map(event=>event.payload.state)).toEqual(['running','unreachable']);
  reports.close();vi.useRealTimers();
 });
 it('un duplicado idempotente no renueva la frescura ni publica un cambio',()=>{
  const {reports,store,tick}=setup();let updates=0;reports.subscribe(()=>updates++);
  const online={bootId:'windows-boot-1',sequence:1,event:'online' as const};
  reports.accept('windows',online);tick(30000);expect(reports.accept('windows',online)).toBe(true);
  expect(reports.status().observedAt).toBe(new Date(100000).toISOString());
  expect(updates).toBe(1);expect(store.eventsAfter(0)).toHaveLength(1);
 });
 it('emite una sola transición durable al vencer presencia y al pasar de apagado anunciado a detenido',async()=>{
  vi.useFakeTimers();vi.setSystemTime(100000);
  const store=new Store(':memory:');stores.push(store);const reports=new DesktopReports(store,()=>Date.now());
  let updates=0;reports.subscribe(()=>updates++);
  reports.accept('cachyos',{bootId:'linux-boot-1',sequence:1,event:'online'});
  await vi.advanceTimersByTimeAsync(45000);
  expect(reports.status().phase).toBe('unreachable');expect(updates).toBe(2);
  await vi.advanceTimersByTimeAsync(30000);expect(updates).toBe(2);
  reports.accept('windows',{bootId:'windows-boot-1',sequence:1,event:'online'});
  reports.accept('windows',{bootId:'windows-boot-1',sequence:2,event:'poweroff'});
  await vi.advanceTimersByTimeAsync(12000);
  expect(reports.status().phase).toBe('stopped');
  expect(store.eventsAfter(0).filter(event=>event.type==='desktop').map(event=>event.payload.state)).toEqual(['running','unreachable','running','stopping','stopped']);
  reports.close();vi.useRealTimers();
 });
 it('distingue apagado anunciado y reinicio; ignora parada posterior sin perder intención',()=>{
  const {reports,tick}=setup();reports.accept('cachyos',{bootId:'linux-boot-1',sequence:1,event:'poweroff'});
  reports.accept('cachyos',{bootId:'linux-boot-1',sequence:2,event:'stopping'});
  expect(reports.status().phase).toBe('stopping');tick(13000);expect(reports.status().phase).toBe('stopped');
  reports.accept('cachyos',{bootId:'linux-boot-2',sequence:1,event:'online'});
  reports.accept('cachyos',{bootId:'linux-boot-2',sequence:2,event:'reboot'});expect(reports.status().phase).toBe('pending');
 });
});
