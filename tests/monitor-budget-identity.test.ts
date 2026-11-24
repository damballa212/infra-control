import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureMonitor } from '../server/monitor.js';
import { Store } from '../server/store.js';
import type { CostAccount, CostReport } from '../server/costs.js';

const A='111111111111',B='222222222222',DAY=86400000;
const stores=new Set<Store>(),directories=new Set<string>(),monitors=new Set<InfrastructureMonitor>();
function account(accountId:string|undefined=A,label='Shared label',actual:number|null=85,name='Monthly',forecast:number|null=null):CostAccount {
  return {account:label,...(accountId===undefined?{}:{accountId}),status:'available',net:actual,usage:actual,adjustments:0,currency:'USD',estimated:true,services:[],daily:[],budgetsStatus:'available',fetchedAt:new Date().toISOString(),budgets:[{name,limit:100,actual,forecast,currency:'USD',updatedAt:new Date().toISOString()}]};
}
function report(accounts:CostAccount[],month='2026-11',day='14'):CostReport {
  return {accounts,fetchedAt:new Date().toISOString(),nextRefreshAt:new Date(Date.now()+DAY).toISOString(),periodStart:`${month}-01`,periodEnd:`${month}-${day}`,policy:'fixture'};
}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'infra-budget-dedup-'));directories.add(directory);
  const path=join(directory,'test.sqlite');let store=new Store(path);stores.add(store);
  const alerts=()=>store.eventsAfter(0,250).filter(event=>event.type==='incident'&&event.payload.category==='budget');
  const physicalKeys=()=>store.db.prepare("SELECT dedup_key FROM event_dedup WHERE dedup_key LIKE 'budget-v2-%' ORDER BY dedup_key").all();
  const run=async(value:CostReport)=>{
    const monitor=new InfrastructureMonitor(store,{inventory:async()=>[],perform:async()=>{throw new Error('No power operations');}},{get:async()=>value});
    monitors.add(monitor);
    try{await monitor.tick();}finally{monitor.close();monitors.delete(monitor);}
  };
  return {store:()=>store,alerts,physicalKeys,run,reopen:()=>{store.close();stores.delete(store);store=new Store(path);stores.add(store);return store;}};
}
type LegacyOptions={accountId?:string|null;label?:string;month?:string;name?:string;threshold?:80|100;recordKey?:boolean;asOf?:string};
function seedLegacy(store:Store,options:LegacyOptions={}){
  const identity=options.accountId===null?undefined:options.accountId??A;
  const label=options.label??'Shared label',month=options.month??'2026-11',name=options.name??'Monthly',threshold=options.threshold??80;
  const key=(value:80|100)=>`budget-${createHash('sha256').update(`${label}:${month}:${name}:${value}`).digest('hex')}`;
  const aggregateId=`budget:${label}:${name}`;
  const payload={category:'budget',account:label,...(identity===undefined?{}:{accountId:identity}),budgetName:name,threshold,percent:threshold===100?110:85,amount:threshold===100?110:85,limit:100,currency:'USD',source:'actual',asOf:options.asOf??new Date().toISOString()};
  if(options.recordKey===false)store.appendEvent('incident',aggregateId,payload);
  else store.appendEventOnce(key(threshold),'incident',aggregateId,payload,threshold===100?[key(80)]:[]);
  const id=store.latestEventId();
  return {id,key,aggregateId,payload};
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));});
afterEach(()=>{
  try{for(const monitor of monitors)monitor.close();monitors.clear();for(const store of stores)store.close();stores.clear();}
  finally{for(const directory of directories)rmSync(directory,{recursive:true,force:true});directories.clear();vi.useRealTimers();vi.restoreAllMocks();}
});

describe('avisos presupuestarios por identidad física',()=>{
  it('dos cuentas con la misma etiqueta producen dos eventos físicos independientes',async()=>{
    const f=fixture();
    await f.run(report([account(A),account(B)]));
    expect(f.alerts()).toHaveLength(2);
    expect(f.alerts().map(event=>event.payload.accountId).sort()).toEqual([A,B]);
    expect(f.alerts().map(event=>event.aggregateId).sort()).toEqual([`budget:${A}:2026-11:Monthly`,`budget:${B}:2026-11:Monthly`]);
    expect(f.physicalKeys()).toHaveLength(2);
  });

  it('renombrar la etiqueta o avanzar el día no repite el aviso, incluso tras reabrir SQLite',async()=>{
    const f=fixture();await f.run(report([account(A,'Original')]));
    const original=f.alerts()[0];
    await f.run(report([account(A,'Renamed')],'2026-11','15'));
    f.reopen();await f.run(report([account(A,'Renamed again')],'2026-11','16'));
    expect(f.alerts()).toEqual([original]);expect(f.physicalKeys()).toHaveLength(1);
  });

  it('separa nombres de presupuesto y meses sin usar fetchedAt como período',async()=>{
    const f=fixture();
    await f.run(report([account(A,'Same',85,'First'),account(A,'Same',85,'Second')]));
    await f.run(report([account(A,'Same',85,'First')],'2026-12'));
    expect(f.alerts()).toHaveLength(3);
    expect(f.alerts().map(event=>event.aggregateId)).toEqual([`budget:${A}:2026-11:First`,`budget:${A}:2026-11:Second`,`budget:${A}:2026-12:First`]);
  });

  it('100 suprime 80 en el mismo mes y conserva esa decisión tras reiniciar',async()=>{
    const f=fixture();await f.run(report([account(A,'Original',110)]));
    expect(f.alerts()).toHaveLength(1);expect(f.alerts()[0].payload.threshold).toBe(100);
    expect(f.physicalKeys()).toHaveLength(2);
    await f.run(report([account(A,'Renamed',85)]));
    f.reopen();await f.run(report([account(A,'Another label',85)]));
    expect(f.alerts()).toHaveLength(1);
    await f.run(report([account(A,'Another label',85)],'2026-12'));
    expect(f.alerts()).toHaveLength(2);expect(f.alerts()[1].payload.threshold).toBe(80);
  });

  it('un legacy sin vínculo durable permite un aviso fresco y conserva eventos, claves y reservas CE',async()=>{
    const f=fixture(),store=f.store(),legacy=seedLegacy(store,{label:'Old label'});
    store.putCache('cost-account-v1:'+A,{reservation:'unchanged'},DAY);
    store.putCache('costs-v1',{snapshot:'unchanged'},DAY);
    const reservation=store.cache('cost-account-v1:'+A),snapshot=store.cache('costs-v1');
    const originalEvents=f.alerts();
    const originalKey=store.db.prepare('SELECT * FROM event_dedup WHERE dedup_key=?').get(legacy.key(80));
    await f.run(report([account(A,'New label')]));
    expect(f.alerts()).toHaveLength(2);expect(f.alerts().slice(0,1)).toEqual(originalEvents);
    expect(f.alerts()[1]).toMatchObject({aggregateId:`budget:${A}:2026-11:Monthly`,payload:{accountId:A,account:'New label',threshold:80}});
    expect(f.physicalKeys()).toHaveLength(1);
    expect(store.db.prepare('SELECT * FROM event_dedup WHERE dedup_key=?').get(legacy.key(80))).toEqual(originalKey);
    expect(store.cache('cost-account-v1:'+A)).toEqual(reservation);expect(store.cache('costs-v1')).toEqual(snapshot);
    const after=f.alerts();
    f.reopen();await f.run(report([account(A,'Third label')]));
    expect(f.alerts()).toEqual(after);expect(f.physicalKeys()).toHaveLength(1);
  });

  it('un legacy de otra cuenta con igual etiqueta nunca silencia la cuenta nueva',async()=>{
    const f=fixture();seedLegacy(f.store(),{accountId:A});
    await f.run(report([account(B)]));
    expect(f.alerts()).toHaveLength(2);
    expect(f.alerts()[1]).toMatchObject({aggregateId:`budget:${B}:2026-11:Monthly`,payload:{accountId:B,threshold:80}});
    await f.run(report([account(A),account(B)]));
    expect(f.alerts()).toHaveLength(3);expect(f.physicalKeys()).toHaveLength(2);
    expect(f.alerts()[2]).toMatchObject({aggregateId:`budget:${A}:2026-11:Monthly`,payload:{accountId:A}});
  });

  it('el hash de otro mes no se liga por createdAt, fetchedAt o asOf',async()=>{
    const f=fixture();seedLegacy(f.store(),{month:'2026-10',asOf:'2026-11-14T12:00:00Z'});
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(2);
    expect(f.alerts()[1].aggregateId).toBe(`budget:${A}:2026-11:Monthly`);
    await f.run(report([account(A)],'2026-10'));
    expect(f.alerts()).toHaveLength(3);expect(f.physicalKeys()).toHaveLength(2);
    expect(f.alerts()[2].aggregateId).toBe(`budget:${A}:2026-10:Monthly`);
  });

  it('legacy 100 no prueba supresión física; un nuevo 100 sí impide avisos posteriores de 80',async()=>{
    const f=fixture();seedLegacy(f.store(),{threshold:100,label:'Old label'});
    const original=f.alerts();
    const legacyKeys=f.store().db.prepare('SELECT * FROM event_dedup ORDER BY dedup_key').all();
    await f.run(report([account(A,'New label',85)]));
    expect(f.alerts()).toHaveLength(2);expect(f.alerts().slice(0,1)).toEqual(original);
    expect(f.alerts()[1].payload.threshold).toBe(80);expect(f.physicalKeys()).toHaveLength(1);
    f.reopen();await f.run(report([account(A,'Another label',85)]));
    expect(f.alerts()).toHaveLength(2);
    await f.run(report([account(A,'Another label',110)]));
    expect(f.alerts()).toHaveLength(3);expect(f.alerts()[2].payload.threshold).toBe(100);
    const after=f.alerts();
    await f.run(report([account(A,'Again',85)]));
    expect(f.alerts()).toEqual(after);expect(f.physicalKeys()).toHaveLength(2);
    expect(f.store().db.prepare("SELECT * FROM event_dedup WHERE dedup_key NOT LIKE 'budget-v2-%' ORDER BY dedup_key").all()).toEqual(legacyKeys);
  });

  it('una clave legacy 100 sin evento físico correspondiente no se interpreta como entregada',async()=>{
    const f=fixture(),legacy=seedLegacy(f.store(),{threshold:80});
    f.store().db.prepare('INSERT INTO event_dedup(dedup_key,created_at) VALUES (?,?)').run(legacy.key(100),new Date().toISOString());
    await f.run(report([account(A,'Renamed',110)]));
    expect(f.alerts()).toHaveLength(2);expect(f.alerts()[1].payload.threshold).toBe(100);
    await f.run(report([account(A,'Renamed',85)]));
    expect(f.alerts()).toHaveLength(2);
  });

  it.each(['event_log','operational_source_events'] as const)('un evento retenido en %s no vincula por sí solo la clave legacy con el período',async retained=>{
    const f=fixture(),legacy=seedLegacy(f.store());
    // Simulate retention only in this disposable SQLite fixture.
    if(retained==='event_log')f.store().db.prepare('DELETE FROM operational_source_events WHERE event_id=?').run(legacy.id);
    else f.store().db.prepare('DELETE FROM event_log WHERE id=?').run(legacy.id);
    const before=f.alerts();
    const legacyKey=f.store().db.prepare('SELECT * FROM event_dedup WHERE dedup_key=?').get(legacy.key(80));
    await f.run(report([account(A,'Renamed')]));
    expect(f.alerts()).toHaveLength(before.length+1);expect(f.alerts().slice(0,before.length)).toEqual(before);
    expect(f.alerts().at(-1)?.aggregateId).toBe(`budget:${A}:2026-11:Monthly`);
    expect(f.physicalKeys()).toHaveLength(1);
    expect(f.store().db.prepare('SELECT * FROM event_dedup WHERE dedup_key=?').get(legacy.key(80))).toEqual(legacyKey);
    const after=f.alerts();
    f.reopen();await f.run(report([account(A,'Renamed again')]));
    expect(f.alerts()).toEqual(after);
  });

  it('no migra una clave sin evento retenido aunque sobreviva la proyección operativa',async()=>{
    const f=fixture(),legacy=seedLegacy(f.store());
    f.store().db.prepare('DELETE FROM event_log WHERE id=?').run(legacy.id);
    f.store().db.prepare('DELETE FROM operational_source_events WHERE event_id=?').run(legacy.id);
    expect(f.store().db.prepare('SELECT 1 FROM operational_incidents LIMIT 1').get()).toBeDefined();
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(1);
    expect(f.alerts()[0].aggregateId).toBe(`budget:${A}:2026-11:Monthly`);
    expect(f.physicalKeys()).toHaveLength(1);
  });

  it('un evento sin hash legacy verificable no acredita el período',async()=>{
    const f=fixture();seedLegacy(f.store(),{recordKey:false});
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(2);expect(f.physicalKeys()).toHaveLength(1);
  });

  it('un evento legacy sin accountId no atribuye entrega por coincidencia de etiqueta',async()=>{
    const f=fixture();seedLegacy(f.store(),{accountId:null});
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(2);expect(f.physicalKeys()).toHaveLength(1);
  });

  it('no aplica evidencia de otro budgetName',async()=>{
    const f=fixture();seedLegacy(f.store(),{name:'Other budget'});
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(2);
    expect(f.alerts()[1].payload.budgetName).toBe('Monthly');
  });

  it('no combina un evento de A en octubre con la clave de B en noviembre aunque compartan etiqueta',async()=>{
    const f=fixture();
    const october=seedLegacy(f.store(),{accountId:A,month:'2026-10',label:'Shared label'});
    const november=seedLegacy(f.store(),{accountId:B,month:'2026-11',label:'Shared label'});
    expect(october.id).not.toBe(november.id);
    const originalEvents=f.alerts();
    const originalKeys=f.store().db.prepare('SELECT * FROM event_dedup ORDER BY dedup_key').all();
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(3);
    expect(f.alerts().slice(0,2)).toEqual(originalEvents);
    expect(f.alerts()[2]).toMatchObject({aggregateId:`budget:${A}:2026-11:Monthly`,payload:{accountId:A,threshold:80}});
    await f.run(report([account(B)]));
    expect(f.alerts()).toHaveLength(4);expect(f.physicalKeys()).toHaveLength(2);
    const after=f.alerts();
    f.reopen();await f.run(report([account(A,'Renamed'),account(B,'Renamed')]));
    expect(f.alerts()).toEqual(after);
    expect(f.store().db.prepare("SELECT * FROM event_dedup WHERE dedup_key NOT LIKE 'budget-v2-%' ORDER BY dedup_key").all()).toEqual(originalKeys);
  });

  it('sin identidad física no emite, no reserva una entrega y no convierte desconocidos en cero',async()=>{
    const f=fixture(),unknown=account(undefined,'Shared label',85);
    delete unknown.accountId;
    expect(unknown).not.toHaveProperty('accountId');
    unknown.status='unavailable';unknown.net=null;unknown.usage=null;unknown.adjustments=null;
    const value=report([unknown]),before=JSON.stringify(value);
    await f.run(value);
    expect(f.alerts()).toEqual([]);expect(f.physicalKeys()).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
    unknown.budgets[0].actual=null;unknown.budgets[0].forecast=null;
    await f.run(value);
    expect(unknown.budgets[0]).toMatchObject({actual:null,forecast:null});
    expect(f.alerts()).toEqual([]);
    await f.run(report([account(A)]));
    expect(f.alerts()).toHaveLength(1);
  });
});
