import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { RouterReports, type RouterSample } from '../server/router-reports.js';

const stores: Store[] = [];
const reporters: RouterReports[] = [];
afterEach(() => {
  reporters.splice(0).forEach(reporter => reporter.close());
  stores.splice(0).forEach(store => store.close());
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  const store=new Store(':memory:');stores.push(store);
  const reports=new RouterReports(store,()=>Date.now());reporters.push(reports);
  return {store,reports};
}
function sample(sequence:number,overrides:Partial<RouterSample>={}):RouterSample{
  return {version:1,bootId:'router-boot-0001',streamId:'collector-stream-0001',sequence,uptimeSeconds:1000+sequence,cpuPercent:8,memTotalBytes:128*1024*1024,memAvailableBytes:64*1024*1024,...overrides};
}

describe('telemetría FiberHome autenticada y acotada',()=>{
  it('actualiza presencia desde el túnel, pero no convierte cada muestra en un evento durable',()=>{
    const {store,reports}=setup();
    expect(reports.accept(sample(1))).toBe(true);
    const firstAt=reports.status()?.observedAt;
    vi.advanceTimersByTime(10000);
    expect(reports.accept(sample(2))).toBe(true);
    expect(reports.status()).toMatchObject({state:'reporting',sequence:2,cpuPercent:8,memAvailableBytes:64*1024*1024});
    expect(reports.status()?.observedAt).not.toBe(firstAt);
    expect(store.eventsAfter(0).map(event=>event.payload.state)).toEqual(['reporting']);
  });

  it('guarda el snapshot inicial y su evento dentro de una sola transacción',()=>{
    const {store,reports}=setup();
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(()=>reports.accept(sample(1))).toThrow();
    expect(reports.status()).toBeUndefined();
    expect(store.eventsAfter(0)).toHaveLength(0);
    store.db.exec('DROP TRIGGER fail_event');
    expect(reports.accept(sample(1))).toBe(true);
    expect(store.eventsAfter(0)).toHaveLength(1);
  });

  it('no rejuvenece duplicados y expira sin sondeo por cliente',async()=>{
    const {store,reports}=setup();reports.accept(sample(1));
    const observedAt=reports.status()?.observedAt;
    vi.advanceTimersByTime(20000);
    expect(reports.accept(sample(1))).toBe(true);
    expect(reports.status()?.observedAt).toBe(observedAt);
    await vi.advanceTimersByTimeAsync(25000);
    expect(reports.status()?.state).toBe('stale');
    expect(store.eventsAfter(0).map(event=>event.payload.state)).toEqual(['reporting','stale']);
  });

  it('exige dos muestras nuevas para recuperar y retira bootId/streamId anteriores',()=>{
    const {store,reports}=setup();reports.accept(sample(1));
    vi.advanceTimersByTime(45000);expect(reports.status()?.state).toBe('stale');
    expect(reports.accept(sample(2))).toBe(true);expect(reports.status()?.state).toBe('recovering');
    expect(reports.accept(sample(3))).toBe(true);expect(reports.status()?.state).toBe('reporting');
    const nextStream=sample(1,{streamId:'collector-stream-0002'});
    expect(reports.accept(nextStream)).toBe(true);
    expect(reports.accept(sample(4))).toBe(false);
    expect(reports.accept(sample(2,{streamId:'collector-stream-0002',bootId:'router-boot-0002'}))).toBe(true);
    expect(reports.accept(sample(5,{streamId:'collector-stream-0002',bootId:'router-boot-0001'}))).toBe(false);
    const events=store.eventsAfter(0);
    expect(events.map(event=>event.payload.state)).toEqual(['reporting','stale','recovering','reporting','reporting']);
    expect(events.at(-1)?.payload.bootChanged).toBe(true);
    expect(events.filter(event=>event.type==='incident')).toHaveLength(0);
  });

  it('muestra telemetría stale a los45s, avisa a los90s y notifica recuperación solo tras dos muestras',async()=>{
    const {store,reports}=setup();reports.accept(sample(1));
    await vi.advanceTimersByTimeAsync(45000);
    expect(reports.status()?.state).toBe('stale');
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(45000);
    const incident=store.eventsAfter(0).find(event=>event.type==='incident');
    expect(incident?.payload).toMatchObject({category:'infrastructure',transitionReason:'telemetry_timeout',silenceSeconds:90});
    reports.accept(sample(2));
    await vi.advanceTimersByTimeAsync(15000);
    reports.accept(sample(3));
    const events=store.eventsAfter(0);
    expect(events.filter(event=>event.type==='incident')).toHaveLength(1);
    expect(events.at(-1)?.payload.transitionReason).toBe('telemetry_recovered');
    expect(reports.status()?.state).toBe('reporting');
  });

  it('no confirma la alerta antes de guardar el evento; la reintenta tras reiniciar el colector',async()=>{
    const {store,reports}=setup();reports.accept(sample(1));
    await vi.advanceTimersByTimeAsync(45000);
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await expect(vi.advanceTimersByTimeAsync(45000)).rejects.toThrow();
    const journal=JSON.parse((store.db.prepare("SELECT value FROM settings WHERE key='router-telemetry'").get() as {value:string}).value);
    expect(journal.alertedAt).toBeUndefined();
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toHaveLength(0);
    reports.close();store.db.exec('DROP TRIGGER fail_event');
    const resumed=new RouterReports(store,()=>Date.now());reporters.push(resumed);
    await vi.runOnlyPendingTimersAsync();
    expect(store.eventsAfter(0).filter(event=>event.type==='incident')).toMatchObject([
      {payload:{transitionReason:'telemetry_timeout',silenceSeconds:90}}
    ]);
  });
});
