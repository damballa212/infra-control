import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Costs, type CostReport } from '../server/costs.js';
import { Store } from '../server/store.js';
import type { AwsAccount, Config } from '../server/types.js';

const A='111111111111',B='222222222222',DAY=86400000;
const stores=new Set<Store>(),directories=new Set<string>();
function account(accountId=A):AwsAccount{return {name:accountId===A?'one':'two',accountId,accessKeyId:'fixture',secretAccessKey:'fixture',instances:[]};}
function config(aws:AwsAccount[]):Config{return {aws,origin:'https://control.example.test',passwordHash:'fixture',agentTokens:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''}};}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'infra-costs-reactivation-'));directories.add(directory);
  const path=join(directory,'test.sqlite');
  let store=new Store(path);stores.add(store);
  const ce=vi.fn((value:AwsAccount)=>({send:async()=>({ResultsByTime:[{Groups:[{Keys:['EC2','Usage'],Metrics:{UnblendedCost:{Amount:'10',Unit:'USD'}}}]}]})}));
  const budgets=vi.fn((_value:AwsAccount)=>({send:async()=>({Budgets:[]})}));
  return {ce,budgets,io:{ce,budgets},store:()=>store,reopen:()=>{store.close();stores.delete(store);store=new Store(path);stores.add(store);return store;}};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));});
afterEach(()=>{try{for(const store of stores)store.close();stores.clear();for(const directory of directories)rmSync(directory,{recursive:true,force:true});directories.clear();}finally{vi.useRealTimers();vi.restoreAllMocks();}});

describe('cuota individual después de suspender todas las cuentas',()=>{
  it('reabre SQLite y recupera una cuenta válida sin repetir CE ni presupuestos',async()=>{
    const f=fixture();
    const first=await new Costs(config([account()]),f.store(),f.io).get();
    const reservation=f.store().cache('cost-account-v1:'+A)!;
    vi.setSystemTime(new Date('2026-11-14T13:00:00Z'));
    const suspended={...account(),enabled:false,disabledReason:'account_suspended' as const};
    const empty=await new Costs(config([suspended]),f.store(),f.io).get();
    expect(empty.accounts).toEqual([]);
    expect(Date.parse(empty.nextRefreshAt)).toBeLessThanOrEqual(Date.now());
    expect(f.store().cache('cost-account-v1:'+A)?.expires).toBe(reservation.expires);
    const restarted=new Costs(config([account()]),f.reopen(),f.io);
    const restored=await restarted.get();
    expect(restored.accounts).toEqual(first.accounts);
    expect(restored.nextRefreshAt).toBe(new Date(reservation.expires).toISOString());
    expect(f.ce).toHaveBeenCalledTimes(1);
    expect(f.budgets).toHaveBeenCalledTimes(1);
    expect(restarted.getCached().report?.accounts).toEqual(first.accounts);
  });

  it('agrega una cuenta nunca consultada sin imponerle la reserva de las suspendidas',async()=>{
    const f=fixture();
    await new Costs(config([account()]),f.store(),f.io).get();
    const reservation=f.store().cache('cost-account-v1:'+A)!;
    vi.setSystemTime(new Date('2026-11-14T13:00:00Z'));
    const suspended={...account(),enabled:false,disabledReason:'account_suspended' as const};
    await new Costs(config([suspended]),f.store(),f.io).get();
    const added=await new Costs(config([suspended,account(B)]),f.reopen(),f.io).get();
    expect(added.accounts.map(row=>row.accountId)).toEqual([B]);
    expect(added.accounts[0]).toMatchObject({status:'available',net:10});
    expect(f.ce.mock.calls.map(([value])=>value.accountId)).toEqual([A,B]);
    expect(f.budgets.mock.calls.map(([value])=>value.accountId)).toEqual([A,B]);
    expect(f.store().cache('cost-account-v1:'+A)?.expires).toBe(reservation.expires);
    await new Costs(config([account(),account(B)]),f.reopen(),f.io).get();
    expect(f.ce).toHaveBeenCalledTimes(2);
    expect(f.budgets).toHaveBeenCalledTimes(2);
  });

  it('no renueva la reserva al suspender y permite el ciclo real cuando expira',async()=>{
    const f=fixture();
    await new Costs(config([account()]),f.store(),f.io).get();
    vi.setSystemTime(new Date('2026-11-15T13:00:00Z'));
    await new Costs(config([{...account(),enabled:false,disabledReason:'account_suspended'}]),f.store(),f.io).get();
    const restored=await new Costs(config([account()]),f.reopen(),f.io).get();
    expect(restored).toMatchObject({periodStart:'2026-11-01',periodEnd:'2026-11-15'});
    expect(restored.accounts[0]).toMatchObject({status:'available',net:10});
    expect(f.ce).toHaveBeenCalledTimes(2);
    expect(f.budgets).toHaveBeenCalledTimes(2);
  });

  it('una configuración inicialmente vacía no reserva cuota de cuentas futuras',async()=>{
    const f=fixture();
    expect((await new Costs(config([]),f.store(),f.io).get()).accounts).toEqual([]);
    const result=await new Costs(config([account(B)]),f.reopen(),f.io).get();
    expect(result.accounts[0]).toMatchObject({accountId:B,status:'available'});
    expect(f.ce.mock.calls.map(([value])=>value.accountId)).toEqual([B]);
  });

  it('conserva la reserva global legacy aunque exista metadata de otro informe',async()=>{
    const f=fixture();
    const previous=await new Costs(config([account()]),f.store(),f.io).get();
    const legacy:CostReport={...previous,accounts:[],policy:'legacy interrupted reservation'};
    f.store().putCache('costs-v1',legacy,DAY);
    const result=await new Costs(config([account(),account(B)]),f.reopen(),f.io).get();
    expect(result).toEqual(legacy);
    expect(f.ce).toHaveBeenCalledTimes(1);
    expect(f.budgets).toHaveBeenCalledTimes(1);
  });
});
