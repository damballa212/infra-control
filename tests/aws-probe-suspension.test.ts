import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogRepository } from '../server/catalog.js';
import { Store } from '../server/store.js';
import { ServiceProbeMonitor, probeTarget, resolveConfiguredProbeResource, type ProbeAddress, type ProbeRunner } from '../server/service-probes.js';
import type { ServiceProbeSignal, ServiceProbeTarget } from '../server/types.js';

const stores:Store[]=[],monitors:ServiceProbeMonitor[]=[];
function fixture(){
  const store=new Store(':memory:');stores.push(store);
  const catalog=new CatalogRepository(store),configured=new Set<string>();
  const connection=(accountId:string,name:string)=>{const value=catalog.registerConnection({provider:'aws',providerAccountId:accountId,name,credentialRef:'fixture'});configured.add(value.id);return value;};
  const destination=connection('111111111111','destination'),host=connection('222222222222','host');
  const observe=(connectionId:string,alias:string,id:string)=>catalog.reconcileScope(connectionId,'aws:ec2:us-east-1',[{providerId:id,resourceType:'ec2-instance',region:'us-east-1',name:id,state:'running',detail:'fixture',observedAt:new Date().toISOString(),aliases:[alias]}],{complete:true,observedAt:new Date().toISOString()});
  observe(destination.id,'aws:destination:i-service','i-service');observe(host.id,'aws:host:i-host','i-host');
  const target:ServiceProbeTarget={resourceId:'aws:destination:i-service',hostResourceId:'aws:host:i-host',url:'https://health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:3000};
  const resolve=(id:string,value?:ServiceProbeTarget)=>resolveConfiguredProbeResource(catalog,configured,id,value);
  const resourceId=resolve(target.resourceId,target)!;
  return {store,catalog,configured,destination,host,target,resolve,resourceId};
}
function observation(state:ServiceProbeSignal['state']='healthy',at=Date.now()):ServiceProbeSignal{return {state,source:'https-probe',observedAt:new Date(at).toISOString(),freshUntil:new Date(at+120000).toISOString(),reasonCode:state==='healthy'?'probe_http_ok':'probe_unexpected_http_status'};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));});
afterEach(()=>{try{for(const monitor of monitors.splice(0))monitor.close();for(const store of stores.splice(0))store.close();}finally{vi.useRealTimers();vi.restoreAllMocks();}});

describe('elegibilidad de sondas durante la suspensión',()=>{
  it.each(['destination','host'] as const)('no ejecuta una sonda con %s suspendido',async key=>{
    const f=fixture();
    f.catalog.setConnectionState(f[key].id,'suspended');
    const run=vi.fn(async()=>{throw new Error('Probe must not run');});
    const write=vi.spyOn(f.store,'recordServiceProbe');
    const monitor=new ServiceProbeMonitor([f.target],f.store,f.resolve,vi.fn(),run);monitors.push(monitor);
    expect(f.resolve(f.target.resourceId,f.target)).toBeUndefined();
    await monitor.tick();
    expect(run).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  });

  it('excluye conexiones no configuradas y hosts suspendidos sin fila de recurso',async()=>{
    const f=fixture();
    f.configured.delete(f.destination.id);
    expect(f.resolve(f.target.resourceId,f.target)).toBeUndefined();
    f.configured.add(f.destination.id);
    f.catalog.setConnectionState(f.host.id,'suspended');
    expect(f.resolve(f.target.resourceId,{...f.target,hostResourceId:'aws:host:i-never-discovered'})).toBeUndefined();
    const run=vi.fn(async()=>observation());
    const monitor=new ServiceProbeMonitor([{...f.target,hostResourceId:'aws:host:i-never-discovered'}],f.store,f.resolve,vi.fn(),run);monitors.push(monitor);
    await monitor.tick();expect(run).not.toHaveBeenCalled();
  });

  it.each(['destination','host'] as const)('descarta el resultado en vuelo al suspender %s y conserva el último estado',async key=>{
    const f=fixture();
    f.store.recordServiceProbe(f.resourceId,observation('healthy',Date.now()-180000),Date.now()-180000,f.target.resourceId,f.target.hostResourceId!);
    const previous=f.store.serviceProbe(f.resourceId);
    let release!:(value:ServiceProbeSignal)=>void;
    const delayed=new Promise<ServiceProbeSignal>(resolve=>{release=resolve;});
    const run=vi.fn(async()=>delayed),changed=vi.fn(),write=vi.spyOn(f.store,'recordServiceProbe');
    const monitor=new ServiceProbeMonitor([f.target],f.store,f.resolve,changed,run);monitors.push(monitor);
    const pending=monitor.tick();
    try{
      expect(run).toHaveBeenCalledTimes(1);
      const changesBeforeSuspension=changed.mock.calls.length;
      f.catalog.setConnectionState(f[key].id,'suspended');
      release(observation('unhealthy'));
      await pending;
      expect(write).not.toHaveBeenCalled();
      expect(f.store.serviceProbe(f.resourceId)).toEqual(previous);
      expect(changed).toHaveBeenCalledTimes(changesBeforeSuspension);
    }finally{release(observation());await pending;}
  });

  it('revalida antes de despachar un destino que esperaba al siguiente batch',async()=>{
    const f=fixture();
    const extra=['second','third'].map(name=>{
      f.catalog.reconcileScope(f.destination.id,`fixture:${name}`,[{providerId:`i-${name}`,resourceType:'ec2-instance',region:'us-east-1',name,state:'running',detail:'fixture',observedAt:new Date().toISOString(),aliases:[`aws:destination:i-${name}`]}],{complete:true,observedAt:new Date().toISOString()});
      return {...f.target,resourceId:`aws:destination:i-${name}`};
    });
    let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const run=vi.fn(async()=>{await blocked;return observation();});
    const monitor=new ServiceProbeMonitor([f.target,...extra],f.store,f.resolve,vi.fn(),run);monitors.push(monitor);
    const pending=monitor.tick();
    try{
      expect(run).toHaveBeenCalledTimes(2);
      f.catalog.setConnectionState(f.host.id,'suspended');
      release();await pending;
      expect(run).toHaveBeenCalledTimes(2);
    }finally{release();await pending;}
  });

  it('no inicia HTTPS si la suspensión ocurre mientras resuelve DNS',async()=>{
    let eligible=true,release!:(addresses:ProbeAddress[])=>void;
    const dns=new Promise<ProbeAddress[]>(resolve=>{release=resolve;});
    const resolve=vi.fn(async()=>dns),request=vi.fn(async()=>200);
    const target:ServiceProbeTarget={resourceId:'fixture',url:'https://health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:3000};
    const pending=probeTarget(target,{resolve,request},Date.now(),()=>eligible);
    eligible=false;release([{address:'8.8.8.8',family:4}]);
    expect(await pending).toMatchObject({state:'unknown',reasonCode:'probe_ineligible'});
    expect(request).not.toHaveBeenCalled();
  });

  it('conserva runners y resolvers anteriores que reciben solo sus argumentos originales',async()=>{
    const f=fixture(),run:ProbeRunner=async(_target,_now)=>observation();
    const monitor=new ServiceProbeMonitor([f.target],f.store,id=>f.resolve(id,f.target),vi.fn(),run);monitors.push(monitor);
    await monitor.tick();expect(f.store.serviceProbe(f.resourceId)).toMatchObject({state:'healthy'});
  });
});
