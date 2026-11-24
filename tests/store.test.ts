import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../server/store.js';
import type { Resource } from '../server/types.js';
import { DeploymentBlockedError } from '../server/store.js';
import type { HostMetricsSnapshot, ServiceProbeSignal } from '../server/types.js';
it('persiste idempotencia y marca incierta una orden interrumpida sin volver a ejecutarla', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-store-')), path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const resource = { id: 'aws:test:instance', name: 'Test' } as Resource;
  const op = store.create('actor', 'same-order', 'payload', resource, 'stop');
  store.addSession('test-hash'); store.putCache('test-cache', { useful: true }, 10000); store.close();
  store = new Store(path);
  expect(store.get(op.id)?.state).toBe('uncertain'); expect(store.existing('actor', 'same-order')?.id).toBe(op.id);
  expect(store.operationHistory(op.id).map(event => event.payload.state)).toEqual(['accepted', 'uncertain']);
  expect(store.session('test-hash')).toBe(true); expect(store.cache('test-cache')?.value).toEqual({ useful: true });
  const next = store.create('actor', 'next-order', 'payload2', resource, 'refresh');
  expect(() => store.create('other-actor', 'parallel', 'payload3', resource, 'stop')).toThrow();
  store.update(next.id, 'succeeded', 'done'); store.close(); rmSync(dir, { recursive: true });
});

it('guarda transiciones de operaciones como historial durable y no duplica estados idénticos', () => {
  const store = new Store(':memory:');
  const resource = { id: 'aws:test:instance', name: 'Test' } as Resource;
  const op = store.create('actor', 'history-key', 'payload', resource, 'stop');
  store.update(op.id, 'running', 'Ejecutando');
  store.update(op.id, 'running', 'Ejecutando');
  store.update(op.id, 'succeeded', 'Confirmado');
  const history = store.operationHistory(op.id);
  expect(history.map(event => event.payload.state)).toEqual(['accepted', 'running', 'succeeded']);
  expect(history.map(event => event.id)).toEqual([...history.map(event => event.id)].sort((a, b) => a - b));
  store.close();
});

it('reproduce eventos desde un cursor monotónico y detecta cursores fuera de ventana', () => {
  const store = new Store(':memory:');
  const first = store.appendEvent('resource', 'router:fiberhome', { state: 'reporting' });
  const second = store.appendEvent('incident', 'home-link', { state: 'open' });
  expect(second).toBeGreaterThan(first);
  expect(store.eventsAfter(first).map(event => event.id)).toEqual([second]);
  expect(store.eventBounds()).toMatchObject({ first, latest: second });
  store.close();
});

it('migra el log de eventos legacy para aceptar cobertura sin perder historial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-event-coverage-migration-')), path = join(dir, 'test.sqlite'), db = new DatabaseSync(path);
  db.exec("CREATE TABLE event_log(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL CHECK(type IN ('desktop','resource','operation','incident')),aggregate_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX event_log_aggregate ON event_log(aggregate_id,id);");
  db.prepare('INSERT INTO event_log(type,aggregate_id,payload,created_at) VALUES (?,?,?,?)').run('resource', 'legacy:resource', JSON.stringify({ state: 'running' }), new Date().toISOString());
  db.close();
  const store = new Store(path);
  store.appendEvent('coverage', 'coverage:connection:scope', { state: 'partial' });
  expect(store.eventsAfter(0).map(event => event.type)).toEqual(['resource', 'coverage']);
  expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_log'").get()).toMatchObject({ sql: expect.stringContaining('coverage') });
  store.close(); rmSync(dir, { recursive: true });
});

it('cierra la carrera entre despliegue y alta de órdenes mediante una compuerta atómica', () => {
  const store = new Store(':memory:');
  const resource = { id: 'router:fiberhome', name: 'Router' } as Resource;
  const now = Date.now();
  store.db.prepare("INSERT INTO settings(key,value) VALUES ('deployment-gate',?)").run(JSON.stringify({ owner: 'deploy-fixture', expiresAt: new Date(now + 60000).toISOString() }));
  expect(store.deploymentBlocked(now)).toBe(true);
  expect(() => store.create('actor', 'during-deploy', 'payload', resource, 'refresh')).toThrow(DeploymentBlockedError);
  expect(store.list()).toHaveLength(0);
  store.db.prepare("UPDATE settings SET value=? WHERE key='deployment-gate'").run(JSON.stringify({ owner: 'expired', expiresAt: new Date(now - 1).toISOString() }));
  expect(store.deploymentBlocked(now)).toBe(false);
  expect(store.create('actor', 'after-deploy', 'payload', resource, 'refresh').state).toBe('accepted');
  store.close();
});

it('guarda una preferencia de arranque offline cancelable y no bloquea WOL', () => {
  const store = new Store(':memory:');
  const applying = store.beginDesktopBootPreference('boot-default-1', 'windows', 0);
  expect(applying).toMatchObject({ desired: 'windows', effective: null, state: 'applying', version: 1 });
  const pending = store.finishDesktopBootPreference('boot-default-1', 'pending', 'La PC aplicará el cambio al reconectarse.');
  expect(pending).toMatchObject({ desired: 'windows', effective: null, state: 'pending', version: 1 });

  const resource = { id: 'computer:desktop', name: 'PC de casa' } as Resource;
  expect(store.create('actor', 'wake-1', 'wake', resource, 'start').state).toBe('accepted');
  expect(() => store.beginDesktopBootPreference('boot-default-2', 'cachyos', 0)).toThrow('version');
  expect(store.cancelPendingDesktopBootPreference(1)).toMatchObject({ desired: null, effective: null, state: 'unknown', version: 2 });
  store.close();
});

it('una lectura nueva de UEFI resuelve una intención y detecta cambios externos sin corregirlos', () => {
  const store = new Store(':memory:');
  store.beginDesktopBootPreference('boot-default-1', 'windows', 0);
  store.finishDesktopBootPreference('boot-default-1', 'pending', 'pending');
  const matched = store.observeDesktopBootDefault('windows', new Date().toISOString());
  expect(matched).toMatchObject({ desired: 'windows', effective: 'windows', state: 'applied', version: 1 });
  const drift = store.observeDesktopBootDefault('cachyos', new Date().toISOString());
  expect(drift).toMatchObject({ desired: 'windows', effective: 'cachyos', state: 'drift', version: 1 });
  store.close();
});

it('consume el efecto verificado al confirmar la orden y no reutiliza su expectativa quince minutos después', () => {
  const store = new Store(':memory:');
  const resource = { id: 'aws:account:us-east-1:i-test', name: 'Servidor' } as Resource;
  const operation = store.create('agent', 'expected-stop', 'fp', resource, 'stop');
  store.update(operation.id, 'succeeded', 'AWS confirmó el apagado.');
  const observedAt = new Date(Date.now() + 15 * 60_000).toISOString();

  expect(store.db.prepare('SELECT consumed_at FROM expected_transitions WHERE operation_id=?').get(operation.id)?.consumed_at).toBeTruthy();
  expect(store.consumeExpectedTransition(resource.id, 'stopped', observedAt)).toBe(false);
  expect(store.consumeExpectedTransition(resource.id, 'stopped', observedAt)).toBe(false);
  store.close();
});

it('no conserva una expectativa fallida ni la usa para ocultar una transición posterior', () => {
  const store = new Store(':memory:');
  const resource = { id: 'aws:account:us-east-1:i-failed', name: 'Servidor' } as Resource;
  const operation = store.create('agent', 'failed-stop', 'fp', resource, 'stop');
  store.update(operation.id, 'failed', 'El proveedor rechazó la orden.');
  expect(store.consumeExpectedTransition(resource.id, 'stopped', new Date().toISOString())).toBe(false);
  store.close();
});

it('persiste muestras host por 24 h, conserva timestamps observados y descarta métricas reordenadas',()=>{
  const store=new Store(':memory:'),now=Date.now(),resourceId='catalog:host-metrics';
  const firstAt=new Date(now-30_000).toISOString();
  const first:HostMetricsSnapshot={cpu:{percent:22.5,observedAt:firstAt},memory:{usedBytes:225,totalBytes:1000,utilizationPercent:22.5,observedAt:firstAt}};
  expect(store.recordHostTelemetry(resourceId,first,new Date(now).toISOString(),now).accepted).toBe(true);
  const older:HostMetricsSnapshot={cpu:{percent:5,observedAt:new Date(now-60_000).toISOString()}};
  expect(store.recordHostTelemetry(resourceId,older,new Date(now+1000).toISOString(),now+1000).accepted).toBe(false);
  expect(store.hostTelemetry(resourceId)?.sample.cpu).toEqual(first.cpu);
  expect(store.hostTelemetryHealth([resourceId],now)).toMatchObject({registeredHosts:1,hostsWithData:1,fresh:1,stale:0,samples24h:1});
  store.recordHostTelemetry(resourceId,{cpu:{percent:8,observedAt:new Date(now-25*60*60_000).toISOString()}},new Date(now-25*60*60_000).toISOString(),now);
  expect(store.hostTelemetryHealth([resourceId],now).samples24h).toBe(1);
  store.close();
});

it('retiene el ciclo de muestras de 30 s y 60 s durante 24 h con límite acotado por host',()=>{
  const store=new Store(':memory:'),now=Date.now(),resourceId='catalog:host-metrics-cap';
  const insert=store.db.prepare('INSERT INTO host_telemetry_samples(resource_id,observed_at,received_at,payload) VALUES (?,?,?,?)');
  const receivedAt=new Date(now-60_000).toISOString();
  store.db.exec('BEGIN');
  for(let index=0;index<5001;index++){
    const observedAt=new Date(now-(5001-index)*5000).toISOString();
    insert.run(resourceId,observedAt,receivedAt,'{}');
  }
  store.db.exec('COMMIT');
  store.recordHostTelemetry(resourceId,{cpu:{percent:40,observedAt:new Date(now).toISOString()}},new Date(now).toISOString(),now);
  expect(store.hostTelemetryHealth([resourceId],now).samples24h).toBe(5000);
  store.close();
});

it('persiste la última sonda de servicio y registra solo transiciones de estado',()=>{
  const store=new Store(':memory:'),resourceId='catalog:service-1',firstAt=new Date().toISOString();
  const healthy:ServiceProbeSignal={state:'healthy',source:'https-probe',observedAt:firstAt,freshUntil:new Date(Date.now()+60_000).toISOString(),reasonCode:'probe_http_ok',evidence:'HTTP 200'};
  expect(store.recordServiceProbe(resourceId,healthy)).toBe(true);
  expect(store.recordServiceProbe(resourceId,{...healthy,observedAt:new Date(Date.now()+1000).toISOString()})).toBe(false);
  expect(store.serviceProbe(resourceId)?.state).toBe('healthy');
  expect(store.eventLogHealth().retained).toBe(1);
  const unhealthy:ServiceProbeSignal={...healthy,state:'unhealthy',observedAt:new Date(Date.now()+2000).toISOString(),reasonCode:'probe_unexpected_http_status',evidence:'HTTP 503'};
  expect(store.recordServiceProbe(resourceId,unhealthy)).toBe(true);
  expect(store.eventLogHealth().retained).toBe(3);
  expect(store.incidentEventsAfter(0).map(event=>event.payload)).toMatchObject([{category:'infrastructure',source:'https-probe',from:'healthy',to:'unhealthy',transitionReason:'service_probe_unhealthy'}]);
  expect(store.serviceProbeHealth([resourceId],Date.now())).toMatchObject({registered:1,observed:1,healthy:0,unhealthy:1,stale:0});
  const recovered:ServiceProbeSignal={...healthy,observedAt:new Date(Date.now()+3000).toISOString(),freshUntil:new Date(Date.now()+63000).toISOString()};
  expect(store.recordServiceProbe(resourceId,recovered)).toBe(true);
  expect(store.incidentEventsAfter(0).map(event=>event.payload)).toMatchObject([
    {from:'healthy',to:'unhealthy',transitionReason:'service_probe_unhealthy'},
    {from:'unhealthy',to:'healthy',transitionReason:'service_probe_recovered'}
  ]);
  expect(store.eventLogHealth().retained).toBe(5);
  store.close();
});

it('conserva una caída abierta durante unknown y emite una sola recuperación al volver sano',()=>{
  const store=new Store(':memory:'),resourceId='catalog:service-outage',base=Date.now();
  const sample=(state:ServiceProbeSignal['state'],offset:number):ServiceProbeSignal=>({
    state,source:'https-probe',observedAt:new Date(base+offset).toISOString(),freshUntil:new Date(base+offset+120_000).toISOString(),
    reasonCode:state==='unhealthy'?'probe_unexpected_http_status':state==='healthy'?'probe_http_ok':'probe_dns_failed',
    ...(state==='healthy'?{evidence:'HTTP 200'}:{})
  });
  store.recordServiceProbe(resourceId,sample('unhealthy',0),base);
  store.recordServiceProbe(resourceId,sample('unknown',1000),base+1000);
  store.recordServiceProbe(resourceId,sample('unhealthy',2000),base+2000);
  store.recordServiceProbe(resourceId,sample('healthy',3000),base+3000);
  expect(store.incidentEventsAfter(0).map(event=>event.payload)).toMatchObject([
    {from:'unknown',to:'unhealthy',transitionReason:'service_probe_unhealthy'},
    {from:'unknown',to:'unhealthy',transitionReason:'service_probe_unhealthy'},
    {from:'unhealthy',to:'healthy',transitionReason:'service_probe_recovered'}
  ]);
  expect(store.incidentEventsAfter(0).filter(event=>event.payload.transitionReason==='service_probe_recovered')).toHaveLength(1);
  expect(store.eventLogHealth().retained).toBe(8);
  store.close();
});

it('migra sondas antiguas conservando su caída abierta',()=>{
  const dir=mkdtempSync(join(tmpdir(),'infra-probe-migration-')),path=join(dir,'test.sqlite'),db=new DatabaseSync(path),base=Date.now();
  db.exec('CREATE TABLE service_probe_latest(resource_id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,payload TEXT NOT NULL)');
  const unhealthy:ServiceProbeSignal={state:'unhealthy',source:'https-probe',observedAt:new Date(base).toISOString(),freshUntil:new Date(base+120_000).toISOString(),reasonCode:'probe_unexpected_http_status'};
  db.prepare('INSERT INTO service_probe_latest(resource_id,observed_at,payload) VALUES (?,?,?)').run('catalog:old-service',unhealthy.observedAt,JSON.stringify(unhealthy));
  db.close();
  const store=new Store(path),healthy:ServiceProbeSignal={...unhealthy,state:'healthy',observedAt:new Date(base+1000).toISOString(),freshUntil:new Date(base+121_000).toISOString(),reasonCode:'probe_http_ok',evidence:'HTTP 200'};
  store.recordServiceProbe('catalog:old-service',healthy,base+1000);
  expect(store.incidentEventsAfter(0).map(event=>event.payload)).toMatchObject([{from:'unhealthy',to:'healthy',transitionReason:'service_probe_recovered'}]);
  store.close();rmSync(dir,{recursive:true});
});

it('recupera el latch desde un incidente abierto cuando la muestra legacy quedó unknown',()=>{
  const dir=mkdtempSync(join(tmpdir(),'infra-probe-unknown-migration-')),path=join(dir,'test.sqlite'),db=new DatabaseSync(path),base=Date.now();
  db.exec(`CREATE TABLE service_probe_latest(resource_id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,payload TEXT NOT NULL,outage_open INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE event_log(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,aggregate_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const resourceId='catalog:unknown-legacy',unknown:ServiceProbeSignal={state:'unknown',source:'https-probe',observedAt:new Date(base).toISOString(),freshUntil:new Date(base+120_000).toISOString(),reasonCode:'probe_dns_failed'};
  db.prepare('INSERT INTO service_probe_latest(resource_id,observed_at,payload) VALUES (?,?,?)').run(resourceId,unknown.observedAt,JSON.stringify(unknown));
  db.prepare('INSERT INTO event_log(type,aggregate_id,payload,created_at) VALUES (?,?,?,?)').run('incident',resourceId,JSON.stringify({category:'infrastructure',source:'https-probe',resourceId,from:'healthy',to:'unhealthy',transitionReason:'service_probe_unhealthy'}),new Date(base-1000).toISOString());
  db.close();
  const store=new Store(path),healthy:ServiceProbeSignal={...unknown,state:'healthy',observedAt:new Date(base+1000).toISOString(),freshUntil:new Date(base+121_000).toISOString(),reasonCode:'probe_http_ok',evidence:'HTTP 200'};
  store.recordServiceProbe(resourceId,healthy,base+1000);
  expect(store.incidentEventsAfter(0).map(event=>event.payload)).toMatchObject([
    {source:'https-probe',to:'unhealthy',transitionReason:'service_probe_unhealthy'},
    {from:'unhealthy',to:'healthy',transitionReason:'service_probe_recovered'}
  ]);
  store.close();rmSync(dir,{recursive:true});
});

it('normaliza la sonda antes de guardarla y rechaza IDs o ventanas de frescura fuera de contrato',()=>{
  const store=new Store(':memory:'),now=Date.now();
  const signal={state:'healthy' as const,source:'https-probe' as const,observedAt:new Date(now).toISOString(),freshUntil:new Date(now+60_000).toISOString(),reasonCode:'probe_http_ok',destination:'https://private.example/secret'} as ServiceProbeSignal;
  store.recordServiceProbe('catalog:service-safe',signal,now);
  expect(store.serviceProbe('catalog:service-safe')).not.toHaveProperty('destination');
  expect(()=>store.recordServiceProbe('catalog:bad id',signal,now)).toThrow('Invalid service probe result');
  expect(()=>store.recordServiceProbe('catalog:too-fresh',{...signal,freshUntil:new Date(now+21*60_000).toISOString()},now)).toThrow('Invalid service probe result');
  store.close();
});
