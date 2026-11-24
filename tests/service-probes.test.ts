import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isPublicAddress, isSafeServiceProbeUrl, pinnedAddressLookup, pinnedHttpsStatus, probeTarget, ServiceProbeMonitor, type ProbeAddress, type ProbeTarget } from '../server/service-probes.js';
import { Store } from '../server/store.js';

const target:ProbeTarget={resourceId:'catalog:prod-service',url:'https://health.example.com/ready',expectedStatusCodes:[200,204],intervalSeconds:60,timeoutMs:3000};
const address={address:'93.184.216.34',family:4 as const};

describe('sondas HTTPS de destinos explícitos',()=>{
  it('acepta únicamente direcciones IP globales y rechaza rangos reservados',()=>{
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    for(const ip of ['0.1.2.3','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.2','198.18.0.1','203.0.113.10','224.0.0.1','240.0.0.1','::1','fc00::1','fe80::1','2001:db8::1','2002::1','::ffff:127.0.0.1']){
      expect(isPublicAddress(ip),ip).toBe(false);
    }
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('2001:100::1')).toBe(false);
    expect(isPublicAddress('2001:200::1')).toBe(true);
    expect(isPublicAddress('fe80::1%eth0')).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('rechaza sintaxis de URL local, ambigua o con controles antes de resolver DNS',()=>{
    for(const url of ['https://health.example.com\n/ready','https://health..example.com/ready','https://health.example.com./ready?x=1','https://user@health.example.com/ready']){
      expect(isSafeServiceProbeUrl(url)).toBe(false);
    }
  });

  it('fija la petición a una IP pública resuelta y acepta solo el estado esperado',async()=>{
    const request=vi.fn(async(_url:URL,_address:ProbeAddress,_timeoutMs:number)=>204),resolve=vi.fn(async(_hostname:string,_signal:AbortSignal)=>[address]);
    const now=1_800_000_000_000;
    const result=await probeTarget(target,{resolve,request},now);
    expect(resolve).toHaveBeenCalledWith('health.example.com',expect.any(AbortSignal));
    expect(resolve.mock.calls[0]?.[1]?.aborted).toBe(false);
    expect(request).toHaveBeenCalledWith(new URL(target.url),address,expect.any(Number));
    expect(request.mock.calls[0]?.[2]).toBeGreaterThan(0);
    expect(request.mock.calls[0]?.[2]).toBeLessThanOrEqual(target.timeoutMs);
    expect(result).toMatchObject({state:'healthy',source:'https-probe',observedAt:new Date(now).toISOString(),freshUntil:new Date(now+120_000).toISOString(),reasonCode:'probe_http_ok',evidence:'HTTP 204'});
  });

  it('ancla las dos formas de lookup de Node a la misma IP validada',()=>{
    const lookup=pinnedAddressLookup(address) as unknown as (hostname:string,options:unknown,callback:(...args:unknown[])=>void)=>void;
    const all=vi.fn(),one=vi.fn();
    lookup('untrusted.example.com',{all:true},all);
    lookup('health.example.com',{family:4},one);
    expect(all).toHaveBeenCalledWith(null,[address]);
    expect(one).toHaveBeenCalledWith(null,address.address,address.family);
  });

  it('conserva HTTPS, SNI y el hostname lógico mientras conecta a la IP anclada',async()=>{
    type FakeResponse=EventEmitter&{statusCode?:number;destroy:()=>void};
    type FakeRequest=EventEmitter&{end:()=>void;destroy:(error?:Error)=>void};
    const response=new EventEmitter() as FakeResponse;response.statusCode=204;response.destroy=vi.fn();
    let options:RequestOptions|undefined;
    const requester=vi.fn((value:RequestOptions,callback:(response:IncomingMessage)=>void)=>{
      options=value;
      const pending=new EventEmitter() as FakeRequest;
      pending.destroy=vi.fn(error=>{if(error)pending.emit('error',error);return pending;});
      pending.end=vi.fn(()=>callback(response as unknown as IncomingMessage));
      return pending as unknown as ClientRequest;
    });
    const status=await pinnedHttpsStatus(new URL(target.url),address,1000,requester as never);
    expect(status).toBe(204);
    expect(options).toMatchObject({hostname:'health.example.com',servername:'health.example.com',port:443,path:'/ready',method:'GET',rejectUnauthorized:true,agent:false});
    expect(options?.lookup).toEqual(expect.any(Function));
    expect(response.destroy).toHaveBeenCalledTimes(1);
  });

  it('rechaza errores de socket y destruye la conexión al vencer el timeout',async()=>{
    type FakeRequest=EventEmitter&{end:()=>void;destroy:(error?:Error)=>void};
    const makeRequester=(end:(request:FakeRequest)=>void)=>{
      let captured:FakeRequest|undefined;
      const requester=vi.fn((_options:RequestOptions,_callback:(response:IncomingMessage)=>void)=>{
        const pending=new EventEmitter() as FakeRequest;captured=pending;
        pending.destroy=vi.fn(error=>{if(error)pending.emit('error',error);return pending;});
        pending.end=vi.fn(()=>end(pending));
        return pending as unknown as ClientRequest;
      });
      return {requester,lastRequest:()=>captured};
    };
    const socketFailure=makeRequester(pending=>pending.emit('error',Object.assign(new Error('private socket details'),{code:'ECONNRESET'})));
    await expect(pinnedHttpsStatus(new URL(target.url),address,1000,socketFailure.requester as never)).rejects.toMatchObject({code:'ECONNRESET'});

    vi.useFakeTimers();
    try{
      const timeout=makeRequester(()=>{});
      const request=pinnedHttpsStatus(new URL(target.url),address,25,timeout.requester as never);
      const rejection=expect(request).rejects.toMatchObject({code:'ETIMEDOUT'});
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(timeout.requester).toHaveBeenCalledTimes(1);
      expect(timeout.lastRequest()?.destroy).toHaveBeenCalledWith(expect.objectContaining({code:'ETIMEDOUT'}));
    }finally{vi.useRealTimers();}
  });

  it('no conecta cuando DNS devuelve cualquier dirección privada o reservada',async()=>{
    const request=vi.fn(async()=>200),resolve=vi.fn(async()=>[address,{address:'169.254.169.254',family:4 as const}]);
    const result=await probeTarget(target,{resolve,request},1_800_000_000_000);
    expect(result).toMatchObject({state:'unknown',reasonCode:'probe_destination_blocked'});
    expect(request).not.toHaveBeenCalled();
  });

  it('no conecta ante DNS vacío o una familia discordante con la dirección',async()=>{
    const request=vi.fn(async()=>200);
    const empty=await probeTarget(target,{resolve:async()=>[],request},1_800_000_000_000);
    const mismatch=await probeTarget(target,{resolve:async()=>[{...address,family:6}],request},1_800_000_000_000);
    expect(empty.reasonCode).toBe('probe_destination_blocked');
    expect(mismatch.reasonCode).toBe('probe_destination_blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('clasifica timeout y fallo HTTPS sin revelar el mensaje interno',async()=>{
    const resolve=async()=>[address];
    const timeout=await probeTarget(target,{resolve,request:async()=>{throw Object.assign(new Error('socket private detail'),{code:'ETIMEDOUT'});}},1_800_000_000_000);
    const failure=await probeTarget(target,{resolve,request:async()=>{throw new Error('tls private detail');}},1_800_000_000_000);
    expect(timeout.reasonCode).toBe('probe_timeout');
    expect(failure.reasonCode).toBe('probe_request_failed');
    expect(JSON.stringify([timeout,failure])).not.toMatch(/socket private detail|tls private detail/);
  });

  it('convierte una configuración inválida a unknown sin consulta DNS',async()=>{
    const resolve=vi.fn(async()=>[address]),request=vi.fn(async()=>200);
    const result=await probeTarget({...target,url:'http://127.0.0.1/ready'},{resolve,request},1_800_000_000_000);
    expect(result).toMatchObject({state:'unknown',reasonCode:'probe_config_invalid'});
    expect(resolve).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  });

  it('marca un 3xx o un estado no aprobado como unhealthy sin seguirlo',async()=>{
    const request=vi.fn(async()=>302),resolve=vi.fn(async()=>[address]);
    const result=await probeTarget(target,{resolve,request},1_800_000_000_000);
    expect(result).toMatchObject({state:'unhealthy',reasonCode:'probe_unexpected_http_status',evidence:'HTTP 302'});
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('mantiene unknown ante fallos DNS o de conexión y no filtra mensajes del proveedor',async()=>{
    const resolve=vi.fn(async()=>{throw new Error('resolver-internal-detail');}),request=vi.fn(async()=>200);
    const result=await probeTarget(target,{resolve,request},1_800_000_000_000);
    expect(result).toMatchObject({state:'unknown',reasonCode:'probe_dns_failed'});
    expect(JSON.stringify(result)).not.toContain('resolver-internal-detail');
    expect(request).not.toHaveBeenCalled();
  });

  it('aplica el timeout total a DNS y descarta una respuesta tardía sin iniciar HTTPS',async()=>{
    vi.useFakeTimers();
    try{
      let finishDns!:(addresses:typeof address[])=>void;
      let resolverSignal:AbortSignal|undefined;
      const resolve=vi.fn((_hostname:string,signal?:AbortSignal)=>{resolverSignal=signal;return new Promise<typeof address[]>(done=>{finishDns=done;});}),request=vi.fn(async()=>200);
      let result:Awaited<ReturnType<typeof probeTarget>>|undefined;
      const pending=probeTarget({...target,timeoutMs:250},{resolve,request},1_800_000_000_000).then(value=>{result=value;});
      await vi.advanceTimersByTimeAsync(250);await pending;
      expect(result).toMatchObject({state:'unknown',reasonCode:'probe_timeout'});
      expect(resolverSignal?.aborted).toBe(true);
      finishDns([address]);await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });

  it('reconcilia únicamente recursos existentes y no sondea más rápido que su intervalo',async()=>{
    const store=new Store(':memory:'),changed=vi.fn(),resolve=vi.fn(()=> 'catalog:prod-service');let now=1_800_000_000_000;
    let state:'healthy'|'unhealthy'='healthy';
    const run=vi.fn(async(_target:ProbeTarget,timestamp:number)=>({state,source:'https-probe' as const,observedAt:new Date(timestamp).toISOString(),freshUntil:new Date(timestamp+120_000).toISOString(),reasonCode:state==='healthy'?'probe_http_ok':'probe_unexpected_http_status'}));
    const monitor=new ServiceProbeMonitor([target],store,resolve,changed,run,()=>now);
    await monitor.tick();await monitor.tick();
    expect(run).toHaveBeenCalledTimes(1);
    state='unhealthy';
    now+=60_000;await monitor.tick();
    expect(run).toHaveBeenCalledTimes(2);expect(changed).toHaveBeenCalledTimes(2);
    monitor.close();store.close();
  });

  it('no realiza llamadas si el recurso configurado aún no aparece en el catálogo',async()=>{
    const store=new Store(':memory:'),run=vi.fn(async()=>({state:'healthy' as const,source:'https-probe' as const,observedAt:new Date().toISOString(),freshUntil:new Date(Date.now()+60_000).toISOString(),reasonCode:'probe_http_ok'}));
    const monitor=new ServiceProbeMonitor([target],store,()=>undefined,()=>{},run);
    await monitor.tick();expect(run).not.toHaveBeenCalled();
    monitor.close();store.close();
  });

  it('deduplica aliases distintos que resuelven al mismo recurso canónico',async()=>{
    const store=new Store(':memory:'),aliasTarget={...target,resourceId:'aws:prod:service',url:'https://other.example.com/health'};
    const run=vi.fn(async(_target:ProbeTarget,timestamp:number)=>({state:'healthy' as const,source:'https-probe' as const,observedAt:new Date(timestamp).toISOString(),freshUntil:new Date(timestamp+120_000).toISOString(),reasonCode:'probe_http_ok'}));
    const monitor=new ServiceProbeMonitor([target,aliasTarget],store,()=> 'catalog:prod-service',()=>{},run,()=>1_800_000_000_000);
    await monitor.tick();
    expect(run).toHaveBeenCalledTimes(1);
    monitor.close();store.close();
  });

  it('no persiste una respuesta si el monitor se cierra mientras la petición sigue activa',async()=>{
    const store=new Store(':memory:'),now=1_800_000_000_000;
    const result={state:'healthy' as const,source:'https-probe' as const,observedAt:new Date(now).toISOString(),freshUntil:new Date(now+120_000).toISOString(),reasonCode:'probe_http_ok'};
    let finish!:(value:typeof result)=>void;
    const run=vi.fn(()=>new Promise<typeof result>(resolve=>{finish=resolve;}));
    const changed=vi.fn(),monitor=new ServiceProbeMonitor([target],store,()=> 'catalog:prod-service',changed,run,()=>now);
    const pending=monitor.tick();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    monitor.close();finish(result);await pending;
    expect(store.serviceProbe('catalog:prod-service')).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();store.close();
  });
});
