import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { PushService, type PushTransport } from '../server/push.js';
import { DesktopClient, type DesktopStatus } from '../server/desktop.js';
import { DesktopReports } from '../server/desktop-reports.js';
import { MacReports } from '../server/mac-reports.js';
import { ServiceProbeMonitor, type ProbeTarget } from '../server/service-probes.js';
import type { HostObservationConfig, Resource, ServiceProbeSignal } from '../server/types.js';
import { CatalogRepository } from '../server/catalog.js';
import { HostObservationCoordinator } from '../server/host-observation.js';
import { NativeHostMonitor } from '../server/host-monitor.js';
import { HOST_PIN, ROOT_DIRECTORY, nativeSample } from './fixtures/native-host.js';

const base=Date.parse('2026-11-12T12:00:00Z'),closers:Array<()=>void>=[];
const curve=createECDH('prime256v1');curve.setPrivateKey(Buffer.alloc(32,1));
const peer=createECDH('prime256v1');peer.generateKeys();
const configuration={vapidPublicKey:curve.getPublicKey('base64url'),vapidPrivateKey:curve.getPrivateKey('base64url'),vapidSubject:'mailto:test@example.test',encryptionKeyHex:'3'.repeat(64)};
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:peer.getPublicKey('base64url'),auth:randomBytes(16).toString('base64url')}};
const resource:Resource={id:'computer:desktop',name:'PC de casa',kind:'computer',state:'running',actions:['stop','boot-cachyos'],observedAt:new Date(base).toISOString(),account:'Casa',location:'Casa',detail:'test'};
const iso=()=>new Date().toISOString();
function setup(optIn=true){
  const store=new Store(':memory:');const send=vi.fn<PushTransport['send']>(async()=>({statusCode:201}));
  const config=optIn?{...configuration,signalLoss:{desktop:true,mac:true}}:configuration;
  const service=new PushService(store,config,{send});const id=service.register(subscription).id;
  closers.push(()=>{service.close();store.close();});
  const titles=()=>send.mock.calls.map(call=>(JSON.parse(call[1]) as {title:string}).title);
  return {store,service,send,id,titles,config};
}
function router(store:Store,reason:string){return store.appendEvent('resource','router:fiberhome',{transitionReason:reason});}
function probe(store:Store,state:ServiceProbeSignal['state'],id='catalog:probe',ttl=300_000){return store.recordServiceProbe(id,{state,source:'https-probe',observedAt:iso(),freshUntil:new Date(Date.now()+ttl).toISOString(),reasonCode:state==='healthy'?'probe_http_ok':state==='unhealthy'?'probe_unexpected_http_status':'probe_dns_failed'});}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(base);});
afterEach(()=>{closers.splice(0).reverse().forEach(close=>close());vi.useRealTimers();});

describe('ciclos Push durables',()=>{
  it('conserva ciclos del VPS en disco y no llama recuperación a una nueva línea base',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'infra-host-push-')), file=join(dir,'infra.sqlite');
    closers.push(()=>rmSync(dir,{recursive:true,force:true}));
    const send=vi.fn<PushTransport['send']>(async()=>({statusCode:201}));
    const id='catalog:fixture-host';
    let store=new Store(file), push=new PushService(store,configuration,{send});
    const close=()=>{push.close();store.close();};closers.push(close);
    push.register(subscription);
    const emit=(status:string,component='host-disk',from='bad')=>store.appendEvent('incident',id,{
      source:'host-native-monitor',category:'infrastructure',resourceId:id,resourceName:'VPS de prueba',
      component,status,from,actionable:status==='open',
    });
    const titles=()=>send.mock.calls.map(call=>JSON.parse(call[1]).title);
    emit('open');await push.flush();expect(titles()).toEqual(['Uso de disco · alerta']);
    close();store=new Store(file);push=new PushService(store,configuration,{send});
    emit('resolved');await push.flush();expect(titles()).toEqual(['Uso de disco · alerta','Uso de disco · normal']);
    emit('open','host-memory');await push.flush();
    emit('unknown','host-memory');emit('information','host-memory','unknown');await push.flush();
    expect(titles()).toEqual(['Uso de disco · alerta','Uso de disco · normal','Uso de memoria · alerta']);
    emit('open','host-memory');await push.flush();
    expect(titles().at(-1)).toBe('Uso de memoria · alerta');expect(send).toHaveBeenCalledTimes(4);
  });
  it('entrega alerta y recuperación del monitor VPS con el alias real y conserva el ciclo al reiniciar Push', async () => {
    const { store, service, send, id, titles, config } = setup();
    const hosts: HostObservationConfig[] = [{ key: 'vps', displayName: 'VPS', enabled: true, snapshotDirectory: ROOT_DIRECTORY, expectedFingerprint: HOST_PIN, monitoring: { enabled: true } }];
    let sample = nativeSample(base), sequence = 0;
    const catalog = new CatalogRepository(store, Date.now);
    const source = new HostObservationCoordinator(() => hosts, store, catalog, { now: Date.now, read: async () => Buffer.from(JSON.stringify(sample)) });
    const monitor = new NativeHostMonitor(store, () => hosts, (samples, includeRetiredDocker, completeDocker) => source.snapshot({ samples, includeRetiredDocker, completeDocker }));
    closers.push(() => { monitor.close(); source.close(); });
    const observe = async (cpu: number) => {
      vi.setSystemTime(Date.now() + 60_000);
      sample = nativeSample(Date.now(), ++sequence, cpu);
      expect((await source.poll())[0]?.status).toBe('accepted');
      monitor.tick();
    };
    const cycle = () => store.db.prepare('SELECT signal_key AS key,cycle_id AS id,state,mode FROM push_signal_cycles_v2 WHERE subscription_id=? AND signal_key LIKE ?').get(id, 'native-host-%');
    await observe(95); await observe(95); await service.flush();
    expect(titles()).toEqual([]);
    await observe(95); await service.flush();
    const root = catalog.listResources().find(record => record.resourceType === 'linux-host')!;
    const opened = store.eventsAfter(0, 250).find(event => event.payload.source === 'host-native-monitor')!;
    expect(opened.aggregateId).toBe(root.aliases[0]);
    expect(opened.payload).toMatchObject({ catalogId: root.catalogId, resourceId: root.aliases[0], status: 'open' });
    expect(titles()).toEqual(['Uso de CPU · alerta']);
    const loss = cycle(); expect(loss).toMatchObject({ state: 'loss', id: String(opened.id) });
    service.close();
    const restarted = new PushService(store, config, { send }); closers.push(() => restarted.close());
    await observe(20); await observe(20); await observe(20); await restarted.flush();
    expect(titles()).toEqual(['Uso de CPU · alerta', 'Uso de CPU · normal']);
    expect(cycle()).toMatchObject({ ...loss, state: 'recovery', mode: 'recovered' });
    await observe(95); await observe(95); await observe(95); await restarted.flush();
    vi.setSystemTime(Date.now() + 180_000); monitor.tick(); await restarted.flush();
    expect(cycle()).toMatchObject({ mode: 'unknown' });
    await observe(20); await observe(20); await observe(20); await restarted.flush();
    expect(cycle()).toMatchObject({ state: 'explained' });
    expect(titles()).toEqual(['Uso de CPU · alerta', 'Uso de CPU · normal', 'Uso de CPU · alerta']);
  });
  it.each(['independent','operation'] as const)('conserva el hecho de un nuevo arranque %s después de pérdida y recuperación ya entregadas',async kind=>{
    const {store,service,send,id,titles,config}=setup();
    service.updatePreferences(id,{operations:false,devices:true,router:false,infrastructure:false,budgets:false,secrets:false,secretDeliveries:false});
    const reports=new DesktopReports(store);closers.push(()=>reports.close());
    expect(reports.accept('windows',{bootId:'windows-boot-one',sequence:1,event:'online'})).toBe(true);
    await service.flush();send.mockClear();
    await vi.advanceTimersByTimeAsync(45_000);await service.flush();
    await vi.advanceTimersByTimeAsync(180_000);await service.flush();
    expect(titles()).toEqual(['PC de casa sin señal']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reports.accept('windows',{bootId:'windows-boot-one',sequence:2,event:'heartbeat'})).toBe(true);
    await service.flush();expect(titles()).toEqual(['PC de casa sin señal','PC de casa en línea']);
    const before=store.db.prepare("SELECT cycle_id AS cycleId,recovery_sent AS recoverySent FROM push_signal_cycles_v2 WHERE subscription_id=? AND signal_key='desktop-signal'").get(id) as {cycleId:string;recoverySent:number};
    expect(before.recoverySent).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    let operationId:string|undefined;
    if(kind==='operation'){
      const operation=store.create('Admin','second-real-boot','fixture',resource,'boot-cachyos');operationId=operation.id;
      store.recordOperationVerification(operation.id,{phase:'verify',deadlineAt:new Date(Date.now()+240_000).toISOString(),bootId:'windows-boot-one'});
    }
    expect(reports.accept('windows',{bootId:'windows-boot-one',sequence:3,event:'reboot'})).toBe(true);
    await service.flush();
    await vi.advanceTimersByTimeAsync(1000);
    const system=kind==='operation'?'cachyos':'windows',bootId=kind==='operation'?'linux-boot-two':'windows-boot-two';
    expect(reports.accept(system,{bootId,sequence:1,event:'online'})).toBe(true);
    if(operationId)store.update(operationId,'succeeded','Nuevo arranque confirmado.');
    await service.flush();
    expect(titles()).toEqual(['PC de casa sin señal','PC de casa en línea','PC de casa en línea']);
    const payload=JSON.parse(send.mock.calls[2]![1]) as {factKey:string;cycleId?:string;independentPower?:boolean};
    expect(payload.factKey).toBe(operationId?`operation:${operationId}`:`desktop:${bootId}:running`);
    expect(payload.independentPower).toBe(true);expect(payload.cycleId).toBeUndefined();
    expect(store.db.prepare("SELECT cycle_id AS cycleId,recovery_sent AS recoverySent FROM push_signal_cycles_v2 WHERE subscription_id=? AND signal_key='desktop-signal'").get(id)).toMatchObject(before);
    expect(reports.accept(system,{bootId,sequence:2,event:'online'})).toBe(true);
    store.appendEvent('desktop','computer:desktop',{state:'running',system,bootId,reportEvent:'online'});
    await service.flush();expect(send).toHaveBeenCalledTimes(3);
    service.close();const restarted=new PushService(store,config,{send});closers.push(()=>restarted.close());
    store.appendEvent('desktop','computer:desktop',{state:'running',system,bootId,reportEvent:'online'});
    await restarted.flush();expect(send).toHaveBeenCalledTimes(3);
  });
  it('entrega la prueba pedida explícitamente aunque las categorías automáticas estén desactivadas',async()=>{
    const {service,id,titles}=setup(false);
    service.updatePreferences(id,{operations:false,devices:false,router:false,infrastructure:false,budgets:false,secrets:false,secretDeliveries:false});
    expect(service.testDevice(id)).toBe(true);
    await service.flush();
    expect(titles()).toEqual(['Infra Control · prueba de avisos']);
  });
  it.each([179_999,180_000])('cancela una pérdida no enviada incluso en la frontera debida %i',async elapsed=>{
    const {store,service,send}=setup();router(store,'telemetry_timeout');await service.flush();
    vi.setSystemTime(base+elapsed);router(store,'telemetry_recovered');await service.flush();
    vi.setSystemTime(base+400_000);await service.flush();expect(send).not.toHaveBeenCalled();expect(store.pushOutboxCount()).toBe(0);
  });
  it('cancela un reintento fallido al recuperarse y no entrega la pérdida después',async()=>{
    const {store,service,send}=setup();send.mockResolvedValueOnce({statusCode:503,headers:{'retry-after':'60'}});
    router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+180_000);await service.flush();
    expect(send).toHaveBeenCalledTimes(1);vi.setSystemTime(base+181_000);router(store,'telemetry_recovered');await service.flush();
    vi.setSystemTime(base+300_000);await service.flush();expect(send).toHaveBeenCalledTimes(1);expect(store.pushOutboxCount()).toBe(0);
  });
  it('avisa recuperación dentro de noventa segundos sin coalescerla con la pérdida',async()=>{
    const {store,service,titles}=setup();probe(store,'unhealthy');await service.flush();
    vi.setSystemTime(base+120_000);await service.flush();vi.setSystemTime(base+121_000);probe(store,'healthy');await service.flush();
    expect(titles()).toEqual(['Servicio sin respuesta','Servicio recuperado']);
  });
  it('no vincula una recuperación posterior a un hueco con una pérdida enviada antigua',async()=>{
    const {store,service,send}=setup();const loss=router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+180_000);await service.flush();
    store.appendEvent('resource','other-one',{});const latest=store.appendEvent('resource','other-two',{});
    store.db.prepare('DELETE FROM event_log WHERE id<?').run(latest);store.setPushCursor(loss);await service.flush();
    router(store,'telemetry_recovered');await service.flush();expect(send).toHaveBeenCalledTimes(1);
    router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+360_000);await service.flush();expect(send).toHaveBeenCalledTimes(2);
  });
  it('invalida una pérdida pendiente al saltar historia',async()=>{
    const {store,service,send}=setup();const loss=router(store,'telemetry_timeout');await service.flush();
    store.appendEvent('resource','gap-one',{});const latest=store.appendEvent('resource','gap-two',{});store.db.prepare('DELETE FROM event_log WHERE id<?').run(latest);store.setPushCursor(loss);
    await service.flush();vi.setSystemTime(base+500_000);await service.flush();expect(send).not.toHaveBeenCalled();expect(store.pushOutboxCount()).toBe(0);
  });
  it('usa la fecha del evento para la retención de un backlog lento',async()=>{
    const {store,service,send}=setup();router(store,'telemetry_timeout');vi.setSystemTime(base+200_000);await service.flush();expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![2].TTL).toBeLessThanOrEqual(880);
  });
  it('conserva dos estados reales de energía dentro de noventa segundos',async()=>{
    const {store,service,titles,send}=setup();const reports=new DesktopReports(store);closers.push(()=>reports.close());
    reports.accept('windows',{bootId:'windows-boot-one',sequence:1,event:'online'});await service.flush();
    vi.setSystemTime(base+1000);reports.accept('windows',{bootId:'windows-boot-one',sequence:2,event:'poweroff'});
    vi.setSystemTime(base+13_000);expect(reports.status().phase).toBe('stopped');
    // El reloj no ejecutó el temporizador: una muestra posterior publica la frontera real pendiente.
    reports.close();const restored=new DesktopReports(store);closers.push(()=>restored.close());await service.flush();
    expect(titles()).toEqual(['PC de casa en línea','PC de casa apagada']);expect(JSON.parse(send.mock.calls[0]![1]).tag).not.toBe(JSON.parse(send.mock.calls[1]![1]).tag);
  });
  it('funde solo una confirmación de estado ligada a la ventana de la misma operación',async()=>{
    const {store,service,titles}=setup();const operation=store.create('Admin','stop','fp',resource,'stop');
    store.recordOperationVerification(operation.id,{phase:'verify',deadlineAt:new Date(base+240_000).toISOString(),bootId:'windows-boot-one'});
    vi.setSystemTime(base+1000);store.appendEvent('desktop','computer:desktop',{state:'stopped',bootId:'windows-boot-one',system:'windows',reportEvent:'poweroff'});store.update(operation.id,'succeeded','Parada verificada.');
    await service.flush();expect(titles()).toHaveLength(1);
  });
  it('una explicación de poweroff cancela la pérdida retenida sin inventar un regreso running',async()=>{
    const {store,service,titles}=setup();store.appendEvent('desktop','computer:desktop',{state:'unreachable'});await service.flush();
    vi.setSystemTime(base+180_000);store.appendEvent('resource','computer:desktop',{transitionReason:'device_poweroff_announced',bootId:'windows-boot-one'});await service.flush();
    vi.setSystemTime(base+200_000);store.appendEvent('desktop','computer:desktop',{state:'stopped',bootId:'windows-boot-one'});await service.flush();expect(titles()).toEqual(['PC de casa apagada']);
  });
  it('el reposo explica una pérdida Mac retenida y las ausencias personales no avisan por defecto',async()=>{
    const enabled=setup();enabled.store.appendEvent('resource','computer:mac',{transitionReason:'telemetry_timeout'});await enabled.service.flush();
    enabled.store.appendEvent('resource','computer:mac',{transitionReason:'mac_sleep_announced'});await enabled.service.flush();vi.setSystemTime(base+2_500_000);await enabled.service.flush();expect(enabled.send).not.toHaveBeenCalled();
    const normal=setup(false);normal.store.appendEvent('resource','computer:mac',{transitionReason:'telemetry_timeout'});normal.store.appendEvent('desktop','computer:desktop',{state:'unreachable'});await normal.service.flush();
    vi.setSystemTime(base+6_000_000);await normal.service.flush();expect(normal.send).not.toHaveBeenCalled();
  });
  it('difiere una pérdida solo por la operación activa que empezó antes de ella',async()=>{
    const {store,service,titles}=setup();const operation=store.create('Admin','boot','fp',resource,'boot-cachyos');
    store.recordOperationVerification(operation.id,{phase:'wake',deadlineAt:new Date(base+120_000).toISOString()});
    vi.setSystemTime(base+45_000);store.appendEvent('desktop','computer:desktop',{state:'unreachable'});await service.flush();
    vi.setSystemTime(base+100_000);store.recordOperationVerification(operation.id,{phase:'verify',deadlineAt:new Date(base+340_000).toISOString(),bootId:'windows-boot-one'});
    vi.setSystemTime(base+225_000);await service.flush();expect(titles()).toEqual([]);
    vi.setSystemTime(base+226_000);store.update(operation.id,'uncertain','Verificación inconclusa.');store.appendEvent('desktop','computer:desktop',{state:'running',system:'cachyos',bootId:'linux-boot-one',reportEvent:'online'});await service.flush();
    vi.setSystemTime(base+230_000);store.appendEvent('desktop','computer:desktop',{state:'unreachable'});await service.flush();vi.setSystemTime(base+410_000);await service.flush();
    expect(titles().filter(title=>title==='PC de casa sin señal')).toHaveLength(1);expect(store.get(operation.id)?.state).toBe('uncertain');
  });
  it('conserva una aceptación en vuelo y después notifica la recuperación, sin fingir que pudo des-enviarla',async()=>{
    const {store,service,send,titles}=setup();let finish!:(value:{statusCode:number})=>void;let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});send.mockImplementationOnce(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
    router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+180_000);const pending=service.flush();await started;
    router(store,'telemetry_recovered');finish({statusCode:201});await pending;await service.flush();expect(titles()).toEqual(['FiberHome sin telemetría','FiberHome de vuelta']);
  });
  it('no reintenta una entrega en vuelo fallida si entretanto llegó recuperación',async()=>{
    const {store,service,send}=setup();let finish!:(value:{statusCode:number})=>void;let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});send.mockImplementationOnce(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
    router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+180_000);const pending=service.flush();await started;router(store,'telemetry_recovered');finish({statusCode:503});await pending;
    vi.setSystemTime(base+300_000);await service.flush();expect(send).toHaveBeenCalledTimes(1);expect(store.pushOutboxCount()).toBe(0);
  });
  it('conserva el ciclo y su pérdida enviada al recrear PushService',async()=>{
    const {store,service,send,config}=setup();router(store,'telemetry_timeout');await service.flush();vi.setSystemTime(base+180_000);await service.flush();service.close();
    const restarted=new PushService(store,config,{send});closers.push(()=>restarted.close());router(store,'telemetry_recovered');await restarted.flush();expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('obligación HTTPS y verificación PC reales',()=>{
  it('mantiene unknown transitorio, abre observabilidad sostenida y recupera con evidencia',async()=>{
    const {store,service,titles}=setup();const target:ProbeTarget={resourceId:'catalog:probe',url:'https://health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:1000};
    let state:ServiceProbeSignal['state']='unknown';
    const monitor=new ServiceProbeMonitor([target],store,()=>target.resourceId,()=>{},async(_target,now)=>({state,source:'https-probe',observedAt:new Date(now).toISOString(),freshUntil:new Date(now+120_000).toISOString(),reasonCode:state==='healthy'?'probe_http_ok':'probe_timeout'}));closers.push(()=>monitor.close());
    await monitor.tick();await service.flush();expect(titles()).toEqual([]);
    vi.setSystemTime(base+60_000);state='healthy';await monitor.tick();await service.flush();expect(titles()).toEqual([]);
    vi.setSystemTime(base+120_000);state='unknown';await monitor.tick();vi.setSystemTime(base+240_000);await monitor.tick();await service.flush();expect(titles()).toEqual(['Salud del servicio sin comprobar']);
    expect(store.serviceProbe(target.resourceId)?.state).toBe('unknown');vi.setSystemTime(base+300_000);state='healthy';await monitor.tick();await service.flush();expect(titles()).toEqual(['Salud del servicio sin comprobar','Comprobación restablecida']);
  });
  it('unhealthy→unknown cancela la afirmación pendiente de caída y healthy cierra el mismo ciclo',async()=>{
    const {store,service,titles}=setup();probe(store,'unhealthy');await service.flush();vi.setSystemTime(base+30_000);probe(store,'unknown','catalog:probe',120_000);await service.flush();
    vi.setSystemTime(base+120_000);await service.flush();expect(titles()).toEqual([]);
    vi.setSystemTime(base+150_000);store.probeLifecycle.evaluate('catalog:probe','catalog:probe','catalog:probe',Date.now(),120_000);await service.flush();expect(titles()).toEqual(['Salud del servicio sin comprobar']);
    vi.setSystemTime(base+151_000);probe(store,'healthy');await service.flush();expect(titles()).toEqual(['Salud del servicio sin comprobar','Servicio recuperado']);
  });
  it('una parada confirmada suspende solo el host explícito, incluso después de diez minutos',async()=>{
    const {store,service,send}=setup();const host={...resource,id:'aws:one:i-host',kind:'ec2' as const};
    const operation=store.create('Admin','host-stop','fp',host,'stop');store.update(operation.id,'succeeded','Parada verificada.');await service.flush();send.mockClear();
    const target:ProbeTarget={resourceId:'catalog:probe',hostResourceId:host.id,url:'https://health.example.com/ready',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:1000};
    const run=vi.fn(async(_target:ProbeTarget,now:number)=>({state:'unknown' as const,source:'https-probe' as const,observedAt:new Date(now).toISOString(),freshUntil:new Date(now+120_000).toISOString(),reasonCode:'probe_timeout'}));
    const monitor=new ServiceProbeMonitor([target],store,()=>target.resourceId,()=>{},run);closers.push(()=>monitor.close());await monitor.tick();vi.setSystemTime(base+3_600_000);await monitor.tick();await service.flush();expect(run).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
    const publicProbeEvents=store.eventsAfter(0).filter(event=>event.aggregateId===target.resourceId);
    expect(publicProbeEvents.some(event=>event.payload.transitionReason==='service_probe_suspended'&&event.payload.expectedTransition===true)).toBe(true);
    expect(JSON.stringify(publicProbeEvents)).not.toContain(host.id);
    store.expectations.observe(host.id,'running',iso());await monitor.tick();expect(run).toHaveBeenCalledTimes(1);vi.setSystemTime(base+3_720_000);await monitor.tick();await service.flush();expect(send).toHaveBeenCalledTimes(1);
  });
  it('DesktopClient publica las ventanas reales de WOL, cooldown y verificación del segundo arranque',async()=>{
    let status:DesktopStatus={ready:true,online:false,controlled:false,source:'push',phase:'unreachable',observedAt:iso()};
    let powered=false;const phases:Array<{phase:string;deadlineAt:string}>=[];const writes:string[]=[];
    const client=new DesktopClient('/unused',async(method,path)=>{
      if(method==='POST')writes.push(path);
      if(path==='/wake')return {sent:true};
      powered=true;return {accepted:true,before:{...status,bootId:'windows-boot-one'}};
    },async ms=>{
      vi.setSystemTime(Date.now()+ms);
      status={ready:true,online:true,controlled:true,source:'push',phase:'running',os:powered?'cachyos':'windows',bootId:powered?'linux-boot-one':'windows-boot-one',observedAt:iso()};
    },()=>status);
    const result=await client.power('boot-cachyos',(_message,window)=>{if(window)phases.push(window);});
    expect(result.message).toContain('CachyOS');expect(writes).toHaveLength(2);expect(phases.map(value=>value.phase)).toEqual(['dispatch','wake','cooldown','dispatch','verify']);
    expect(Date.parse(phases.find(value=>value.phase==='cooldown')!.deadlineAt)).toBe(base+31_000);
    expect(Date.parse(phases[phases.length-1]!.deadlineAt)).toBe(base+271_000);
  });
});
