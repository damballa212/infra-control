import { createHash } from 'node:crypto';
import type { DurableEvent, PushOutboxRecord, Store } from './store.js';
import { notificationForEvent, signalForEvent, type PushSignalDirective } from './push-notices.js';

type State='loss'|'recovery'|'explained'|'unknown';
type Cycle={subscriptionId:string;key:string;eventId:number;state:State;cycleId:string|null;mode:string;factId:number;sentLoss:number;sentModes:string;recoverySent:number};
type Payload=Record<string,unknown> & {cycleKey?:string;cycleId?:string;cycleRole?:string;cycleMode?:string;factKey?:string;sourceAggregate?:string;sourceProbe?:boolean;deviceKind?:'desktop'|'mac';expectedOperationId?:string;lossAt?:number;independentPower?:boolean;signalFactId?:number};
const SAFE="CASE WHEN json_valid(payload) THEN payload ELSE '{}' END";
const hash=(value:string)=>createHash('sha256').update(value).digest('base64url').slice(0,24);

export class PushLifecycle {
  constructor(private readonly store:Store,private readonly devicePolicy:{desktop?:boolean;mac?:boolean}|undefined,private readonly now=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_signal_cycles_v2 (
      subscription_id TEXT NOT NULL,signal_key TEXT NOT NULL,event_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('loss','recovery','explained','unknown')),cycle_id TEXT,mode TEXT NOT NULL,fact_id INTEGER NOT NULL,
      sent_loss INTEGER NOT NULL DEFAULT 0,sent_modes TEXT NOT NULL DEFAULT '[]',recovery_sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(subscription_id,signal_key),FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE);`);
  }
  private row(subscriptionId:string,key:string):Cycle|undefined {
    return this.store.db.prepare('SELECT subscription_id AS subscriptionId,signal_key AS key,event_id AS eventId,state,cycle_id AS cycleId,mode,fact_id AS factId,sent_loss AS sentLoss,sent_modes AS sentModes,recovery_sent AS recoverySent FROM push_signal_cycles_v2 WHERE subscription_id=? AND signal_key=?').get(subscriptionId,key) as Cycle|undefined;
  }
  private save(row:Cycle):void {
    this.store.db.prepare(`INSERT OR REPLACE INTO push_signal_cycles_v2(subscription_id,signal_key,event_id,state,cycle_id,mode,fact_id,sent_loss,sent_modes,recovery_sent) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.subscriptionId,row.key,row.eventId,row.state,row.cycleId,row.mode,row.factId,row.sentLoss,row.sentModes,row.recoverySent);
  }
  private cancelPending(subscriptionId:string,key:string):void {
    this.store.db.prepare(`UPDATE push_outbox SET state='dead',last_error_code='superseded' WHERE subscription_id=? AND state='pending' AND json_extract(${SAFE},'$.cycleKey')=?`).run(subscriptionId,key);
  }
  private advance(subscriptionId:string,event:DurableEvent,directive:PushSignalDirective,cancel=true):{before?:Cycle;row:Cycle} {
    const before=this.row(subscriptionId,directive.key);
    if(before&&before.eventId>=event.id)return {before,row:before};
    let row:Cycle=before?{...before,eventId:event.id}:{subscriptionId,key:directive.key,eventId:event.id,state:'unknown',cycleId:null,mode:'unknown',factId:event.id,sentLoss:0,sentModes:'[]',recoverySent:0};
    if(directive.role==='loss'){
      if(before?.state!=='loss')row={...row,cycleId:String(event.id),sentLoss:0,sentModes:'[]',recoverySent:0};
      row.state='loss';row.mode=directive.mode;
    }else if(directive.role==='inconclusive'){
      if(before?.state!=='loss')row={...row,state:'unknown',cycleId:null,sentLoss:0,sentModes:'[]',recoverySent:0};
      row.mode=directive.mode;
    }else{
      row.state=directive.role;
      row.mode=directive.mode;
      if(directive.role==='recovery'&&before?.state!=='loss'&&before?.state!=='recovery')row={...row,cycleId:null,sentLoss:0,sentModes:'[]',recoverySent:0};
    }
    if(!before||row.state!==before.state||row.mode!==before.mode||row.cycleId!==before.cycleId){row.factId=event.id;if(cancel)this.cancelPending(subscriptionId,directive.key);}
    this.save(row);
    if(row.state==='loss')this.store.observePushSignal(subscriptionId,directive.key,event.id,'loss');
    else if(row.state==='recovery'||row.state==='explained')this.store.observePushSignal(subscriptionId,directive.key,event.id,'recovery');
    return {before,row};
  }
  private metadata(event:DurableEvent,directive:PushSignalDirective,row:Cycle):Payload {
    return {cycleKey:directive.key,...(row.cycleId?{cycleId:row.cycleId}:{}),cycleRole:directive.role,cycleMode:directive.mode,signalFactId:row.factId,sourceAggregate:event.aggregateId,sourceProbe:event.payload.source==='https-probe',lossAt:Date.parse(event.createdAt)};
  }
  private factExists(subscriptionId:string,factKey:string,exceptId=''):boolean {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM push_outbox WHERE subscription_id=? AND id!=? AND state IN ('pending','sending','sent') AND json_extract(${SAFE},'$.factKey')=? LIMIT 1`).get(subscriptionId,exceptId,factKey));
  }
  private powerFact(event:DurableEvent):string|undefined {
    const data=event.payload;
    if(event.type==='operation'&&data.resourceId==='computer:desktop'&&data.state==='succeeded')return `operation:${String(data.id)}`;
    if(event.type!=='desktop'||!['running','stopped'].includes(String(data.state)))return undefined;
    const at=Date.parse(event.createdAt);
    const candidate=this.store.db.prepare("SELECT id FROM operations WHERE resource='computer:desktop' AND action!='refresh' AND created<=? ORDER BY created DESC,rowid DESC LIMIT 1").get(event.createdAt) as {id:string}|undefined;
    const operation=candidate&&this.store.get(candidate.id),window=candidate&&this.store.operationVerification(candidate.id);
    if(operation&&window&&['accepted','running','succeeded'].includes(operation.state)&&at>=Date.parse(window.startedAt)&&at<=Date.parse(window.deadlineAt)){
      const target=operation.action==='stop'?'stopped':'running';
      const os=operation.action==='boot-windows'?'windows':operation.action==='boot-cachyos'?'cachyos':undefined;
      const bootMatches=!window.bootId||data.state==='stopped'? !window.bootId||data.bootId===window.bootId : operation.action==='start'||data.bootId!==window.bootId;
      if(data.state===target&&(!os||data.system===os)&&bootMatches)return `operation:${operation.id}`;
    }
    return `desktop:${typeof data.bootId==='string'?data.bootId:event.id}:${String(data.state)}`;
  }
  bootstrap(cursor:number):void {
    if(this.store.db.prepare("SELECT 1 FROM settings WHERE key='push-signal-cycles-v2-ready'").get())return;
    this.store.atomic(()=>{
      const subscriptions=this.store.pushSubscriptions(),mapped=new Map<string,Payload>();let cursorRead=0;
      while(cursorRead<cursor){
        const events=this.store.eventsAfter(cursorRead,250).filter(event=>event.id<=cursor);if(!events.length)break;
        for(const event of events){const directive=signalForEvent(event);if(!directive)continue;
          for(const subscription of subscriptions){const {row}=this.advance(subscription.id,event,directive,false);const metadata=this.metadata(event,directive,row);mapped.set(JSON.stringify([subscription.id,String(event.id)]),metadata);
            if(directive.role==='loss'&&this.store.db.prepare("SELECT 1 FROM push_outbox WHERE subscription_id=? AND event_key=? AND state='sent'").get(subscription.id,String(event.id))){row.sentLoss=1;row.sentModes=JSON.stringify([...new Set([...(JSON.parse(row.sentModes) as string[]),directive.mode])]);this.save(row);}
            if(directive.role==='recovery'&&this.store.db.prepare("SELECT 1 FROM push_outbox WHERE subscription_id=? AND event_key=? AND state='sent'").get(subscription.id,String(event.id))){row.recoverySent=1;this.save(row);}
          }
        }
        cursorRead=events[events.length-1]!.id;
      }
      const legacy=this.store.db.prepare('SELECT subscription_id AS subscriptionId,signal_key AS key FROM push_signal_state').all() as Array<{subscriptionId:string;key:string}>;
      for(const value of legacy)if(!this.row(value.subscriptionId,value.key))this.save({...value,eventId:cursor,state:'unknown',cycleId:null,mode:'unknown',factId:cursor,sentLoss:0,sentModes:'[]',recoverySent:0});
      const pending=this.store.db.prepare("SELECT id,event_key AS eventKey,subscription_id AS subscriptionId,payload FROM push_outbox WHERE state='pending'").all() as Array<{id:string;eventKey:string;subscriptionId:string;payload:string}>;
      for(const delivery of pending){let payload:Payload;try{payload=JSON.parse(delivery.payload) as Payload;}catch{continue;}
        if(!payload.lossKey&&!payload.recoversKey)continue;
        const metadata=mapped.get(JSON.stringify([delivery.subscriptionId,delivery.eventKey]));
        if(metadata?.cycleId){this.store.db.prepare('UPDATE push_outbox SET payload=? WHERE id=?').run(JSON.stringify({...payload,...metadata}),delivery.id);}
        else this.store.finishPush(delivery.id,'dead',this.now(),'cycle_history_unknown');
      }
      this.store.db.prepare("INSERT INTO settings(key,value) VALUES ('push-signal-cycles-v2-ready','true')").run();
    });
  }
  private invalidate(cursor:number):void {
    this.store.atomic(()=>{
      this.store.db.prepare("UPDATE push_signal_cycles_v2 SET state='unknown',cycle_id=NULL,event_id=MAX(event_id,?),fact_id=?,mode='unknown',sent_loss=0,sent_modes='[]',recovery_sent=0").run(cursor,cursor);
      this.store.db.prepare(`UPDATE push_outbox SET state='dead',last_error_code='cycle_history_unknown' WHERE state='pending' AND (json_extract(${SAFE},'$.cycleKey') IS NOT NULL OR json_extract(${SAFE},'$.lossKey') IS NOT NULL OR json_extract(${SAFE},'$.recoversKey') IS NOT NULL)`).run();
      this.store.markPushSignalsUnknown(cursor);this.store.setPushCursor(cursor);
    });
  }
  enqueue():void {
    const bounds=this.store.eventBounds();let cursor=this.store.pushCursor(bounds.latest);
    if(cursor>bounds.latest||bounds.first!==null&&cursor<bounds.first-1){this.invalidate(bounds.latest);return;}
    const subscriptions=this.store.pushSubscriptions();
    while(cursor<bounds.latest){const events=this.store.eventsAfter(cursor,100);if(!events.length)break;
      for(const event of events){this.store.atomic(()=>{
        const notification=notificationForEvent(event),directive=signalForEvent(event),eventTime=Date.parse(event.createdAt);
        for(const subscription of subscriptions){
          const advance=directive?this.advance(subscription.id,event,directive):undefined;
          if(!notification)continue;
          const policy=notification.policy??{},hold=(policy.holdSeconds??0)*1000,expiresAt=eventTime+hold+notification.ttlSeconds*1000;
          if(!Number.isFinite(eventTime)||expiresAt<=this.now()||!subscription.preferences[notification.category]||policy.device&&this.devicePolicy?.[policy.device]!==true)continue;
          let factKey=this.powerFact(event);const row=advance?.row;let independentPower=false;
          if(directive?.role==='loss'){
            if(!row?.cycleId||row.state!=='loss'||(JSON.parse(row.sentModes) as string[]).includes(directive.mode))continue;
            factKey=`signal:${directive.key}:${row.cycleId}:loss:${directive.mode}`;
          }else if(directive?.role==='recovery'){
            independentPower=Boolean(factKey?.startsWith('operation:')||event.type==='desktop'&&(event.payload.reportEvent==='online'||!advance?.before||advance.before.state!=='loss'&&advance.before.state!=='unknown'));
            if(policy.recoveryNeedsLoss&&(!row?.cycleId||!row.sentLoss||row.recoverySent))continue;
            if(advance?.before?.state==='loss'&&!row?.sentLoss&&!independentPower)continue;
            if(row?.cycleId&&row.sentLoss&&!independentPower)factKey=`signal:${directive.key}:${row.cycleId}:recovery`;
          }
          if(factKey&&this.factExists(subscription.id,factKey))continue;
          const {policy:_privatePolicy,...visible}=notification;
          const metadata:Payload=directive&&row?this.metadata(event,directive,row):{};
          if(independentPower){
            // Un nuevo arranque conserva su hecho propio y no reutiliza ni consume la recuperación de una pérdida anterior.
            delete metadata.cycleId;
            metadata.independentPower=true;
            metadata.signalFactId=row!.factId;
          }
          const verification=directive?.key==='desktop-signal'&&directive.role==='loss'?this.store.activePowerVerification(eventTime,this.now()):undefined;
          this.store.enqueuePush(String(event.id),subscription.id,{...visible,...metadata,...(factKey?{factKey}:{}),tag:`infra-${hash(factKey??`${event.aggregateId}:${event.id}`)}`,expiresAt:new Date(expiresAt).toISOString(),...(policy.lossKey?{lossKey:policy.lossKey}:{}),...(policy.recoversKey?{recoversKey:policy.recoversKey}:{}),...(policy.device?{deviceKind:policy.device}:{}),...(verification?{expectedOperationId:verification.operationId}:{})},this.now(),Math.max(this.now(),eventTime+hold));
        }
        this.store.setPushCursor(event.id);
      });cursor=event.id;}
    }
  }
  current(delivery:PushOutboxRecord):boolean {
    let payload:Payload;try{payload=JSON.parse(delivery.payload) as Payload;}catch{return true;}
    const subscription=this.store.pushSubscription(delivery.subscriptionId);if(!subscription)return false;
    if(payload.manualTest!==true&&typeof payload.category==='string'&&payload.category in subscription.preferences&&!subscription.preferences[payload.category as keyof typeof subscription.preferences])return false;
    if(payload.deviceKind&&this.devicePolicy?.[payload.deviceKind]!==true)return false;
    if(!payload.cycleKey)return true;
    const row=this.row(delivery.subscriptionId,payload.cycleKey);
    if(payload.cycleRole==='explained')return Boolean(row&&row.state==='explained'&&row.factId===payload.signalFactId);
    if(payload.independentPower&&row&&row.state==='recovery'&&row.factId===payload.signalFactId&&(!payload.cycleId||row.cycleId===payload.cycleId&&!row.recoverySent))return true;
    if(!row||!payload.cycleId||row.cycleId!==payload.cycleId)return false;
    if(payload.cycleRole==='loss'){
      if(row.state!=='loss'||row.mode!==payload.cycleMode||(JSON.parse(row.sentModes) as string[]).includes(String(payload.cycleMode)))return false;
      if(payload.sourceProbe&&(!payload.sourceAggregate||!this.store.probeLifecycle.noticeCurrent(payload.sourceAggregate,String(payload.cycleMode),this.now())))return false;
      return true;
    }
    if(payload.cycleRole==='recovery')return row.state==='recovery'&&Boolean(row.sentLoss)&&!row.recoverySent;
    // Un hecho de energía explicado puede notificarse por sí mismo; no es una recuperación inventada.
    return payload.cycleRole==='explained'&&row.state==='explained';
  }
  deferUntil(delivery:PushOutboxRecord):number|undefined {
    let payload:Payload;try{payload=JSON.parse(delivery.payload) as Payload;}catch{return undefined;}
    if(payload.cycleKey!=='desktop-signal'||payload.cycleRole!=='loss'||!payload.expectedOperationId||typeof payload.lossAt!=='number')return undefined;
    const window=this.store.activePowerVerification(payload.lossAt,this.now(),payload.expectedOperationId);
    return window?Date.parse(window.deadlineAt):undefined;
  }
  sent(delivery:PushOutboxRecord):void {
    let payload:Payload;try{payload=JSON.parse(delivery.payload) as Payload;}catch{return;}
    if(!payload.cycleKey||!payload.cycleId)return;
    const row=this.row(delivery.subscriptionId,payload.cycleKey);if(!row||row.cycleId!==payload.cycleId)return;
    if(payload.cycleRole==='loss'){row.sentLoss=1;row.sentModes=JSON.stringify([...new Set([...(JSON.parse(row.sentModes) as string[]),String(payload.cycleMode)])]);}
    if(payload.cycleRole==='recovery')row.recoverySent=1;
    this.save(row);
  }
}
