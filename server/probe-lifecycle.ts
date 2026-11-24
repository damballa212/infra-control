import type { Store } from './store.js';
import type { ServiceProbeSignal } from './types.js';

type Journal = {
  open: boolean; applicationFailure: boolean; mode: 'none' | 'application' | 'inconclusive' | 'observability' | 'suspended';
  unknownSince: number | null; hadHealthy: boolean; suspended: boolean; resumeRequired: boolean;
  hostId: string; displayId: string; delayMs: number;
};
const PREFIX='service-probe-lifecycle-v2:';

/** Estado operacional separado del resultado crudo de cada petición HTTPS. */
export class ProbeLifecycle {
  constructor(private readonly store: Store) {}
  private load(id:string,displayId=id,hostId=id):Journal {
    const row=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(PREFIX+id) as {value:string}|undefined;
    if(row){try{return JSON.parse(row.value) as Journal;}catch{/* Conserva el resultado crudo aunque el journal anterior no pueda leerse. */}}
    const previous=this.store.db.prepare('SELECT payload,outage_open AS outageOpen FROM service_probe_latest WHERE resource_id=?').get(id) as {payload:string;outageOpen:number}|undefined;
    let signal:ServiceProbeSignal|undefined;try{signal=previous?JSON.parse(previous.payload) as ServiceProbeSignal:undefined;}catch{/* Sin evidencia válida. */}
    return {open:Boolean(previous?.outageOpen),applicationFailure:Boolean(previous?.outageOpen),mode:previous?.outageOpen?'application':'none',unknownSince:signal?.state==='unknown'?Date.parse(signal.observedAt):null,hadHealthy:signal?.state==='healthy',suspended:false,resumeRequired:false,hostId,displayId,delayMs:120_000};
  }
  private save(id:string,journal:Journal):void {this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(PREFIX+id,JSON.stringify(journal));}
  maintenance(id:string,hostId?:string):boolean {
    const host=hostId??this.load(id).hostId;
    return this.store.expectations.context([host]).reasonCode==='intended_host_stop';
  }
  needsProbe(id:string):boolean{return this.load(id).resumeRequired;}
  private event(id:string,journal:Journal,type:'resource'|'incident',reason:string,to:string,now:number,from='unknown'):void {
    const signal=this.store.serviceProbe(id);
    this.store.appendEvent(type,id,{category:'infrastructure',source:'https-probe',resourceId:journal.displayId,signalResourceId:id,...(id.startsWith('catalog:')?{catalogId:id.slice(8)}:{}),from,to,transitionReason:reason,observedAt:signal?.observedAt??null,evaluatedAt:new Date(now).toISOString(),...(reason==='service_probe_observability_lost'?{incidentKind:'observability',baseline:journal.hadHealthy?'previously-confirmed':'never-confirmed',reasonCode:'probe_observation_unavailable'}:{}),...(reason==='service_probe_suspended'?{expectedTransition:true}:{} )});
  }
  private writeOpen(id:string,open:boolean):void {this.store.db.prepare('UPDATE service_probe_latest SET outage_open=? WHERE resource_id=?').run(Number(open),id);}
  evaluate(id:string,displayId=id,hostId=id,now=Date.now(),delayMs=120_000):boolean {
    return this.store.atomic(()=>{
      const journal=this.load(id,displayId,hostId);journal.hostId=hostId;journal.displayId=displayId;journal.delayMs=Math.max(120_000,Math.min(1_200_000,delayMs));
      if(this.maintenance(id,hostId)){
        if(journal.suspended)return false;
        journal.suspended=true;journal.mode='suspended';journal.unknownSince=null;journal.resumeRequired=true;
        this.save(id,journal);this.event(id,journal,'resource','service_probe_suspended','unknown',now);return true;
      }
      if(journal.suspended){journal.suspended=false;journal.resumeRequired=true;journal.mode='inconclusive';journal.unknownSince=now;}
      const signal=this.store.serviceProbe(id);
      const expired=Boolean(signal&&Date.parse(signal.freshUntil)<=now);
      const unknown=!signal||signal.state==='unknown'||expired||journal.resumeRequired;
      let changed=false;
      if(unknown){
        if(journal.unknownSince===null)journal.unknownSince=expired?Date.parse(signal!.freshUntil):now;
        if(journal.mode==='application'){
          journal.mode='inconclusive';this.save(id,journal);this.event(id,journal,'resource','service_probe_inconclusive','unknown',now);changed=true;
        }
        if(now-journal.unknownSince>=journal.delayMs&&journal.mode!=='observability'){
          journal.open=true;journal.mode='observability';this.save(id,journal);this.writeOpen(id,true);
          this.event(id,journal,'incident','service_probe_observability_lost','unknown',now);changed=true;
        }
      }
      this.save(id,journal);return changed;
    });
  }
  record(id:string,signal:ServiceProbeSignal,now:number,displayId:string,hostId:string):boolean {
    return this.store.atomic(()=>{
      const previous=this.store.serviceProbe(id);
      if(previous&&Date.parse(signal.observedAt)<=Date.parse(previous.observedAt))return false;
      const journal=this.load(id,displayId,hostId);journal.hostId=hostId;journal.displayId=displayId;
      journal.delayMs=Math.max(120_000,Date.parse(signal.freshUntil)-Date.parse(signal.observedAt));
      const suspended=this.maintenance(id,hostId);
      let reason:string|undefined,from=previous&&Date.parse(previous.freshUntil)>now?previous.state:'unknown';
      if(suspended){
        if(!journal.suspended)reason='service_probe_suspended';
        journal.suspended=true;journal.resumeRequired=true;journal.mode='suspended';journal.unknownSince=null;
      }else{
        journal.suspended=false;journal.resumeRequired=false;
        if(signal.state==='healthy'){
          if(journal.open){reason='service_probe_recovered';from=journal.applicationFailure?'unhealthy':'unknown';}
          journal.open=false;journal.applicationFailure=false;journal.mode='none';journal.unknownSince=null;journal.hadHealthy=true;
        }else if(signal.state==='unhealthy'){
          if(!journal.open||journal.mode!=='application')reason='service_probe_unhealthy';
          journal.open=true;journal.applicationFailure=true;journal.mode='application';journal.unknownSince=null;
        }else if(signal.state==='unknown'){
          journal.unknownSince??=Date.parse(signal.observedAt);
          if(journal.mode==='application')reason='service_probe_inconclusive';
          if(journal.mode!=='observability')journal.mode='inconclusive';
        }
      }
      this.store.db.prepare(`INSERT INTO service_probe_latest(resource_id,observed_at,payload,outage_open) VALUES (?,?,?,?)
        ON CONFLICT(resource_id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload,outage_open=excluded.outage_open`).run(id,signal.observedAt,JSON.stringify(signal),Number(journal.open));
      this.save(id,journal);
      const changed=!previous||from!==signal.state;
      if(changed)this.store.appendEvent('resource',id,{...(id.startsWith('catalog:')?{catalogId:id.slice(8)}:{}),resourceId:displayId,signalResourceId:id,source:'https-probe',health:{service:signal}});
      if(reason)this.event(id,journal,reason==='service_probe_inconclusive'||reason==='service_probe_suspended'?'resource':'incident',reason,reason==='service_probe_suspended'||reason==='service_probe_inconclusive'?'unknown':signal.state,now,from);
      return this.evaluate(id,displayId,hostId,now,journal.delayMs)||changed||Boolean(reason);
    });
  }
  noticeCurrent(id:string,mode:string,now:number):boolean {
    const journal=this.load(id),signal=this.store.serviceProbe(id);
    if(!journal.open||this.maintenance(id,journal.hostId)||journal.suspended)return false;
    if(mode==='application')return journal.mode==='application'&&signal?.state==='unhealthy'&&Date.parse(signal.freshUntil)>now;
    return mode==='observability'&&journal.mode==='observability'&&(!signal||signal.state==='unknown'||Date.parse(signal.freshUntil)<=now||journal.resumeRequired);
  }
}
