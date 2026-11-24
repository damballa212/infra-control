import { randomUUID } from 'node:crypto';
import type { Store, DurableEvent } from './store.js';
import type { Operation, Resource } from './types.js';
import type { CatalogScopeRecord } from './catalog.js';
import type { OperationReview, OperationalIncident, ResourceExpectation, PowerIntent } from './operational-types.js';
import { KeysetPages, PageError, requireChoice, type PageQuery } from './pagination.js';
import { costBudgetSource, hydrateCostBudgetSource } from './incident-source.js';
import { scopeObservationFresh } from './catalog-freshness.js';
const OP='o.id,o.actor,o.resource AS resourceId,o.name AS resourceName,o.action,o.state,o.message,o.created AS createdAt,o.updated AS updatedAt';
const POWER=['start','stop','boot-windows','boot-cachyos'];
type AllowIncident=(payload:Record<string,unknown>,aggregateId:string)=>boolean;
type RowOperation=Operation&{sequence:number};
export class OperationalReadModel {
  readonly pages:KeysetPages;
  constructor(private readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS operational_identity(operation_id TEXT PRIMARY KEY,resource_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operational_identity_resource ON operational_identity(resource_key);
      CREATE TABLE IF NOT EXISTS operation_reviews(operation_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_review_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operational_incidents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operational_incident_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,incident_id TEXT NOT NULL,event_id INTEGER,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operational_incident_event ON operational_incident_versions(event_id);
      CREATE TABLE IF NOT EXISTS operational_source_events(event_id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS availability_expectations(resource_key TEXT PRIMARY KEY,mode TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operational_owner_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,resource_key TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);`);
    this.pages=new KeysetPages(store);
  }
  canonical(id:string):string {
    if(id.startsWith('catalog:'))return id;
    const row=this.store.db.prepare('SELECT resource_id AS id FROM catalog_resource_aliases WHERE alias=?').get(id) as {id:string}|undefined;
    return row?`catalog:${row.id}`:id;
  }
  private raw(id:string):RowOperation|undefined{return this.store.db.prepare(`SELECT o.rowid AS sequence,${OP} FROM operations o WHERE o.id=?`).get(id) as RowOperation|undefined;}
  private review(id:string):OperationReview|undefined {const row=this.store.db.prepare('SELECT data FROM operation_reviews WHERE operation_id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data) as OperationReview:undefined;}
  decorate<T extends Operation>(operation:T):T {const review=this.review(operation.id);return review?{...operation,review}:operation;}
  private saveReview(operation:RowOperation,value:Omit<OperationReview,'version'>,actor:string,emit:boolean):void {
    const audit=this.store.db.prepare('INSERT INTO operation_review_audit(operation_id,kind,actor,at,data) VALUES (?,?,?,?,?)').run(operation.id,value.disposition,actor,value.updatedAt,JSON.stringify(value));
    const review:OperationReview={...value,version:Number(audit.lastInsertRowid)};
    this.store.db.prepare('INSERT OR REPLACE INTO operation_reviews(operation_id,data) VALUES (?,?)').run(operation.id,JSON.stringify(review));
    if(emit){const {sequence:_sequence,...publicOperation}=operation;this.store.appendEvent('operation',`operation:${operation.id}`,{...publicOperation,review,reviewChange:true});}
  }
  operationChanged(id:string):void {
    const operation=this.raw(id);if(!operation)return;
    const identity=this.canonical(operation.resourceId);
    this.store.db.prepare('INSERT OR REPLACE INTO operational_identity(operation_id,resource_key) VALUES (?,?)').run(id,identity);
    if(POWER.includes(operation.action)&&['failed','uncertain'].includes(operation.state)&&!this.review(id))this.saveReview(operation,{disposition:'pending',canonicalResourceId:identity,updatedAt:operation.updatedAt,reason:'execution_not_confirmed',evidence:{kind:'execution_result'}},'system',false);
    this.reconcile(identity);
  }
  private reconcile(identity:string):void {
    const confirmed=this.store.db.prepare(`SELECT o.rowid AS sequence,${OP} FROM operations o JOIN operational_identity i ON i.operation_id=o.id WHERE i.resource_key=? AND o.state='succeeded' AND o.action IN ('start','stop','boot-windows','boot-cachyos') ORDER BY o.rowid DESC LIMIT 1`).get(identity) as RowOperation|undefined;
    if(!confirmed)return;
    for(const value of this.store.db.prepare(`SELECT o.rowid AS sequence,${OP} FROM operations o JOIN operational_identity i ON i.operation_id=o.id JOIN operation_reviews r ON r.operation_id=o.id WHERE i.resource_key=? AND o.rowid<?`).iterate(identity,confirmed.sequence)){
      const operation=value as unknown as RowOperation,review=this.review(operation.id)!;if(review.disposition!=='pending')continue;
      this.saveReview(operation,{disposition:'superseded',canonicalResourceId:identity,updatedAt:new Date().toISOString(),reason:operation.action===confirmed.action?'later_confirmed_same_target':'later_confirmed_new_power_intention',supersededByOperationId:confirmed.id,evidence:{kind:'later_confirmed_power',operationId:confirmed.id,action:confirmed.action,confirmedAt:confirmed.updatedAt}},'system',true);
    }
  }
  identityLearned(alias:string,catalogId:string):void {
    const identity=`catalog:${catalogId}`;
    for(const value of this.store.db.prepare('SELECT id FROM operations WHERE resource=?').iterate(alias)){
      const id=String(value.id);this.store.db.prepare('INSERT OR REPLACE INTO operational_identity(operation_id,resource_key) VALUES (?,?)').run(id,identity);
      const review=this.review(id);if(review&&review.canonicalResourceId!==identity){const operation=this.raw(id)!;const {version:_version,...rest}=review;this.saveReview(operation,{...rest,canonicalResourceId:identity,updatedAt:new Date().toISOString()},'system',true);}
    }
    this.reconcile(identity);
  }
  markReviewed(id:string,expectedVersion:number,reason:string):Operation {
    return this.store.atomic(()=>{
      const operation=this.raw(id),review=this.review(id);if(!operation||!review)throw new PageError('La orden no tiene una revisión pendiente.');
      if(review.disposition==='reviewed'&&review.reason===reason)return this.decorate(operation);
      if(review.version!==expectedVersion||review.disposition!=='pending')throw new PageError('La revisión cambió. Actualiza antes de decidir.');
      const at=new Date().toISOString();this.saveReview(operation,{disposition:'reviewed',canonicalResourceId:this.canonical(operation.resourceId),updatedAt:at,reason,reviewedBy:'Admin',reviewedAt:at,evidence:{kind:'human_review'}},'Admin',true);
      return this.decorate(operation);
    });
  }
  operationPage(query:PageQuery,authority:string,allow:(id:string)=>boolean){
    requireChoice(query.state,['accepted','running','succeeded','failed','uncertain']);requireChoice(query.view,['history','all','active','review']);requireChoice(query.type,[...POWER,'refresh','power']);
    const where:string[]=[],params:Array<string|number>=[];
    if(query.state){where.push('o.state=?');params.push(query.state);}if(query.actor){where.push('o.actor=?');params.push(query.actor);}if(query.type){where.push(query.type==='power'?"o.action!='refresh'":'o.action=?');if(query.type!=='power')params.push(query.type);}
    if(query.view==='active')where.push("o.state IN ('accepted','running')");
    if(query.q){where.push("instr(lower(o.name||' '||o.actor||' '||o.message||' '||o.action),?)>0");params.push(query.q.toLowerCase());}
    if(query.resourceId){where.push('i.resource_key=?');params.push(this.canonical(query.resourceId));}
    const page=this.pages.page<Operation>('operations',authority,query,{from:'operations o LEFT JOIN operational_identity i ON i.operation_id=o.id',key:'o.rowid',select:OP,where:where.join(' AND '),params},row=>{
      const operation=row as unknown as Operation;if(!allow(operation.resourceId))return undefined;const projected=this.decorate(operation);if(query.view==='review'&&projected.review?.disposition!=='pending')return undefined;return projected;
    });return {operations:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore};
  }
  operationCounts(allow:(id:string)=>boolean){
    const counts={total:0,active:0,uncertain:0,failed:0,review:0};
    for(const value of this.store.db.prepare(`SELECT ${OP} FROM operations o`).iterate()){
      const operation=value as unknown as Operation;if(!allow(operation.resourceId))continue;counts.total++;if(['accepted','running'].includes(operation.state))counts.active++;if(operation.state==='uncertain')counts.uncertain++;if(operation.state==='failed')counts.failed++;if(this.review(operation.id)?.disposition==='pending')counts.review++;
    }return counts;
  }
  expectation(id:string):ResourceExpectation {const key=this.canonical(id),row=this.store.db.prepare('SELECT mode,version,updated_at AS updatedAt FROM availability_expectations WHERE resource_key=?').get(key) as Omit<ResourceExpectation,'resourceId'>|undefined;return row?{resourceId:key,...row}:{resourceId:key,mode:id.startsWith('computer:')?'on-demand':'observe',version:0,updatedAt:null};}
  setExpectation(id:string,mode:ResourceExpectation['mode'],expectedVersion:number):ResourceExpectation {
    return this.store.atomic(()=>{const current=this.expectation(id);if(current.mode===mode&&current.version>=expectedVersion)return current;if(current.version!==expectedVersion)throw new PageError('La expectativa cambió.');const at=new Date().toISOString();this.store.db.prepare('INSERT OR REPLACE INTO availability_expectations(resource_key,mode,version,updated_at) VALUES (?,?,?,?)').run(current.resourceId,mode,current.version+1,at);this.store.db.prepare('INSERT INTO operational_owner_audit(kind,resource_key,actor,at,data) VALUES (?,?,?,?,?)').run('expectation',current.resourceId,'Admin',at,JSON.stringify({mode,previous:current.mode}));this.store.appendEvent('resource',current.resourceId,{resourceId:current.resourceId,projectionChange:true,expectationChanged:true});return this.expectation(id);});
  }
  intent(id:string):PowerIntent|null {
    const operation=this.store.db.prepare(`SELECT ${OP} FROM operations o JOIN operational_identity i ON i.operation_id=o.id WHERE i.resource_key=? AND o.action!='refresh' ORDER BY o.rowid DESC LIMIT 1`).get(this.canonical(id)) as Operation|undefined;
    return operation?{operationId:operation.id,action:operation.action,result:operation.state,requestedAt:operation.createdAt,...(operation.state==='succeeded'?{confirmedAt:operation.updatedAt}:{}),targetPower:operation.action==='stop'?'off':'on',...(operation.action==='boot-windows'?{targetSystem:'windows' as const}:operation.action==='boot-cachyos'?{targetSystem:'cachyos' as const}:{}),transition:this.store.expectations.context([id])}:null;
  }
  safeEvent(payload:Record<string,unknown>):Record<string,unknown>{const safe:Record<string,unknown>={};for(const key of ['category','resourceId','resourceName','kind','from','to','transitionReason','account','accountId','budgetName','threshold','percent','amount','limit','currency','source','asOf','observedAt','reasonCode','connectionId','scopeKey','catalogId','component','status','actionable']){const value=payload[key];if(typeof value==='string'&&value.length<=240&&!/[\u0000-\u001f\u007f]/.test(value))safe[key]=value;else if(typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')safe[key]=value;}return safe;}
  private hydrateBudgetIncident(incident:OperationalIncident):OperationalIncident {
    if(incident.kind!=='budget'||incident.sourceContext)return incident;
    const ids=[...new Set([incident.lastEventId,incident.openingEventId].filter((id):id is number=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0))];
    const events:DurableEvent[]=[];
    for(const id of ids){
      const retained=this.store.eventsAfter(id-1,1)[0];
      if(retained?.id===id)events.push(retained);
      const archived=this.store.db.prepare('SELECT data FROM operational_source_events WHERE event_id=?').get(id) as {data:string}|undefined;
      if(archived){const event=JSON.parse(archived.data) as DurableEvent;if(event.id===id)events.push(event);}
    }
    const hydrated=hydrateCostBudgetSource(incident,events);
    if(hydrated===incident)return incident;
    const before=JSON.stringify(incident),after=JSON.stringify(hydrated);
    // Enrich only this exact projection/version. No transition, new version,
    // acknowledgement, source event or notification is produced.
    this.store.atomic(()=>{
      this.store.db.prepare('UPDATE operational_incidents SET data=? WHERE id=? AND data=?').run(after,incident.id,before);
      this.store.db.prepare('UPDATE operational_incident_versions SET data=? WHERE id=? AND incident_id=? AND data=?').run(after,incident.version,incident.id,before);
    });
    return hydrated;
  }
  private publicIncident(value:OperationalIncident):OperationalIncident {const incident=this.hydrateBudgetIncident(value),canonical=incident.resourceId?this.canonical(incident.resourceId):null;return {...incident,canonicalResourceId:canonical,key:canonical?`${incident.component}:${canonical}`:incident.key};}
  getIncident(id:string):OperationalIncident|undefined {const row=this.store.db.prepare('SELECT data FROM operational_incidents WHERE id=?').get(id) as {data:string}|undefined;return row?this.publicIncident(JSON.parse(row.data) as OperationalIncident):undefined;}
  private current(key:string):OperationalIncident|undefined {for(const value of this.store.db.prepare('SELECT data FROM operational_incidents ORDER BY rowid DESC').iterate()){const incident=this.publicIncident(JSON.parse(String(value.data)) as OperationalIncident);if(incident.key===key&&['open','unknown'].includes(incident.status))return incident;}return undefined;}
  private put(incident:OperationalIncident,eventId:number|null,emit:boolean):OperationalIncident {
    const inserted=this.store.db.prepare('INSERT INTO operational_incident_versions(incident_id,event_id,data) VALUES (?,?,?)').run(incident.id,eventId,'{}');incident={...incident,version:Number(inserted.lastInsertRowid)};
    this.store.db.prepare('INSERT INTO operational_incidents(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(incident.id,JSON.stringify(incident));
    this.store.db.prepare('UPDATE operational_incident_versions SET data=? WHERE id=?').run(JSON.stringify(incident),incident.version);
    if(emit){const id=this.store.appendEvent('resource',incident.resourceId??incident.key,{resourceId:incident.resourceId,connectionId:incident.connectionId,scopeKey:incident.scopeKey,accountId:incident.accountId,account:incident.account,budgetName:incident.budgetName,kind:incident.kind,sourceContext:incident.sourceContext,projectionChange:true,operationalIncidentId:incident.id});this.store.db.prepare('UPDATE operational_incident_versions SET event_id=? WHERE id=?').run(id,incident.version);}
    return incident;
  }
  private transition(component:string,resourceId:string|null,kind:OperationalIncident['kind'],source:string,status:OperationalIncident['status'],actionable:boolean,reason:string,at:string,observedAt:string|null,eventId:number|null,extra:Partial<OperationalIncident>={},from?:string,to?:string):void {
    const canonical=resourceId?this.canonical(resourceId):null,key=canonical?`${component}:${canonical}`:component,current=this.current(key);
    if(status==='resolved'&&!current)return;
    if(!current&&status==='unknown'&&!actionable)return;
    if(current&&current.status===status&&current.kind===kind&&current.actionable===actionable&&current.evidence.reasonCode===reason)return;
    const incident:OperationalIncident={...(current??{id:randomUUID(),key,component,resourceId,canonicalResourceId:canonical,category:'infrastructure',kind,source,status,actionable,openedAt:at,updatedAt:at,openingEventId:eventId,lastEventId:eventId,version:0,evidence:{reasonCode:reason,observedAt}}),...extra,kind,source,status,actionable,updatedAt:at,lastEventId:eventId,evidence:{reasonCode:reason,observedAt,...(from?{from}:{}),...(to?{to}:{})},...(status==='resolved'?{resolvedAt:at,...(eventId!==null?{recoveryEventId:eventId}:{})}:{})};
    this.put(incident,eventId,eventId===null);
  }
  acceptEvent(event:DurableEvent):void {
    if(event.payload.projectionChange||event.type==='operation')return;
    const data=event.payload,reason=String(data.transitionReason??''),resource=typeof data.signalResourceId==='string'?data.signalResourceId:typeof data.resourceId==='string'?data.resourceId:event.aggregateId;
    const observedAt=typeof data.observedAt==='string'?data.observedAt:null,from=typeof data.from==='string'?data.from:undefined,to=typeof data.to==='string'?data.to:undefined;
    if(event.type==='incident'||event.type==='coverage')this.store.db.prepare('INSERT OR IGNORE INTO operational_source_events(event_id,data) VALUES (?,?)').run(event.id,JSON.stringify({...event,payload:this.safeEvent(data)}));
    if(data.source==='host-native-monitor'){
      const component=String(data.component??''),status=data.status,kind=data.kind;
      if(!['host-cpu','host-memory','host-disk','docker-health','host-availability'].includes(component)||!['open','unknown','resolved','information'].includes(String(status))||!['observability','application','availability'].includes(String(kind))||typeof data.resourceId!=='string')return;
      this.transition(component,data.resourceId,kind as 'observability'|'application'|'availability','host-native-monitor',status as 'open'|'unknown'|'resolved'|'information',data.actionable===true,reason,event.createdAt,observedAt,event.id,{},from,to);return;
    }
    if(data.source==='https-probe'&&reason){
      const key='probe',status=reason==='service_probe_recovered'?'resolved':reason==='service_probe_inconclusive'||reason==='service_probe_suspended'?'unknown':'open';
      if(!['service_probe_recovered','service_probe_inconclusive','service_probe_suspended','service_probe_unhealthy','service_probe_observability_lost'].includes(reason))return;
      this.transition(key,resource,reason==='service_probe_observability_lost'?'observability':'application','https-probe',status,status!=='resolved'&&reason!=='service_probe_suspended',reason,event.createdAt,observedAt,event.id,{},from,to);return;
    }
    if(event.aggregateId==='hermes:orchestrator'){
      const state=String(data.to??data.state??'unknown');this.transition('hermes',resource,state==='stale'?'observability':'application','hermes-systemd-reporter',state==='healthy'?'resolved':state==='unknown'||data.expectedTransition?'unknown':'open',state!=='healthy'&&!data.expectedTransition,state==='unknown'?'hermes_observation_unknown':String(data.reasonCode??state),event.createdAt,observedAt,event.id,{},from,state);return;
    }
    if(event.aggregateId==='router:fiberhome'&&['telemetry_timeout','telemetry_recovered','telemetry_recovered_unalerted'].includes(reason)){
      this.transition('router-telemetry',resource,'observability','ssh-telemetry',reason==='telemetry_timeout'?'open':'resolved',reason==='telemetry_timeout',reason,event.createdAt,observedAt,event.id,{},from,to);return;
    }
    if(event.type==='coverage'){
      const connectionId=String(data.connectionId??''),scopeKey=String(data.scopeKey??''),state=String(data.state);
      this.transition(`coverage:${connectionId}:${scopeKey}`,null,'coverage','catalog',state==='healthy'?'resolved':'open',state!=='healthy',String(data.errorCode??state),event.createdAt,observedAt,event.id,{connectionId,scopeKey},undefined,state);return;
    }
    if(event.type==='incident'){
      const budget=data.category==='budget';this.transition(`${budget?'budget':'change'}:${event.id}`,budget?null:resource,budget?'budget':'change',String(data.source??'provider'),'information',false,budget?'budget_threshold_observed':reason||'external_change',event.createdAt,observedAt,event.id,{category:String(data.category??'infrastructure'),...(budget?costBudgetSource(event)??{}:{})},from,to);
    }
  }
  observeResources(resources:readonly Resource[],now=Date.now()):void {
    this.store.atomic(()=>{for(const resource of resources){
      if(resource.catalog?.provider==='host')continue;
      const at=new Date(now).toISOString(),canonical=this.canonical(resource.id),expectation=this.expectation(resource.id),context=this.store.expectations.context([resource.id],now);
      const fresh=Boolean(resource.observedAt&&now-Date.parse(resource.observedAt)>=-300_000&&(resource.health?.presence?.freshUntil?now<=Date.parse(resource.health.presence.freshUntil):now-Date.parse(resource.observedAt)<=1_200_000));
      const availabilityKey=`availability:${canonical}`,existing=this.current(availabilityKey);
      if(expectation.mode!=='always-on'||context.expected){if(existing)this.transition('availability',resource.id,existing.kind,'availability-policy','unknown',false,context.expected?'expected_power_transition':'obligation_removed',at,resource.observedAt,null);}
      else if(!fresh){const providerGap=resource.coverage&&resource.coverage.state!=='healthy';this.transition('availability',resource.id,'observability','availability-policy','unknown',!providerGap,providerGap?'provider_coverage_lost':'availability_observation_stale',at,resource.observedAt,null);}
      else this.transition('availability',resource.id,'availability','availability-policy',resource.state==='running'||resource.state.startsWith('running:')?'resolved':'open',resource.state!=='running'&&!resource.state.startsWith('running:'),'availability_requirement',at,resource.observedAt,null,{},undefined,resource.state);
      for(const [component,signal] of [['probe',resource.serviceSignals?.https],['hermes',resource.serviceSignals?.hermes]] as const){
        if(!signal)continue;const key=`${component}:${canonical}`,current=this.current(key),expected=['intended_host_stop','expected_ec2_transition'].includes(signal.reasonCode??'');
        const valid=Boolean(signal.observedAt&&(!signal.freshUntil||Date.parse(signal.freshUntil)>now));
        if(expected){if(current)this.transition(component,resource.id,current.kind,signal.source,'unknown',false,'expected_host_transition',at,signal.observedAt,null);continue;}
        if(signal.state==='healthy'&&valid)this.transition(component,resource.id,'application',signal.source,'resolved',false,'healthy_observed',at,signal.observedAt,null);
        else if(valid&&(signal.state==='unhealthy'||signal.state==='degraded'))this.transition(component,resource.id,'application',signal.source,'open',true,signal.reasonCode??'health_failed',at,signal.observedAt,null);
        else if(current&&(signal.state==='unknown'||!valid))this.transition(component,resource.id,current.kind,signal.source,'unknown',current.actionable,'observation_unknown',at,signal.observedAt,null);
      }
    }});
  }
  observeScopes(scopes:readonly CatalogScopeRecord[],now=Date.now()):void {
    this.store.atomic(()=>{
      const active=new Set(scopes.map(scope=>`coverage:${scope.connectionId}:${scope.scopeKey}`));
      for(const row of this.store.db.prepare('SELECT data FROM operational_incidents').all()){
        const incident=JSON.parse(String(row.data)) as OperationalIncident;
        if(incident.kind==='coverage'&&incident.source==='catalog'&&['open','unknown'].includes(incident.status)&&!active.has(incident.key))this.transition(incident.component,null,'coverage','catalog','information',false,'scope_no_longer_configured',new Date(now).toISOString(),incident.evidence.observedAt,null);
      }
      for(const scope of scopes){
        const fresh=scopeObservationFresh(scope,now);
        const healthy=scope.state==='healthy'&&fresh;
        this.transition(`coverage:${scope.connectionId}:${scope.scopeKey}`,null,'coverage','catalog',healthy?'resolved':scope.state==='healthy'?'unknown':'open',!healthy,healthy?'coverage_current':scope.errorCode??'coverage_stale',new Date(now).toISOString(),scope.lastSuccessAt,null,{connectionId:scope.connectionId,scopeKey:scope.scopeKey});
      }
    });
  }
  acknowledge(id:string,expectedVersion:number):OperationalIncident {
    return this.store.atomic(()=>{const incident=this.getIncident(id);if(!incident)throw new PageError('Incidente no encontrado.');if(incident.acknowledgement)return incident;if(incident.version!==expectedVersion)throw new PageError('El informe cambió.');return this.put({...incident,acknowledgement:{by:'Admin',at:new Date().toISOString(),reportVersion:expectedVersion}},null,true);});
  }
  incidentPage(query:PageQuery,authority:string,allow:AllowIncident){
    requireChoice(query.state,['open','unknown','resolved','information']);requireChoice(query.view,['current','history','all']);requireChoice(query.type,['application','observability','availability','coverage','budget','change']);
    const page=this.pages.page<OperationalIncident>('incidents',authority,query,{from:'operational_incidents n',key:'n.rowid',select:'n.data'},row=>{
      const incident=this.publicIncident(JSON.parse(String(row.data)) as OperationalIncident);if(!allow(incident as unknown as Record<string,unknown>,incident.resourceId??incident.id))return undefined;
      if(query.view==='current'&&!['open','unknown'].includes(incident.status)||query.state&&incident.status!==query.state||query.type&&incident.kind!==query.type||query.resourceId&&incident.canonicalResourceId!==this.canonical(query.resourceId)||query.q&&!JSON.stringify(incident).toLowerCase().includes(query.q.toLowerCase()))return undefined;return incident;
    });return {incidents:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore};
  }
  incidentHistory(id:string,query:PageQuery,authority:string,allow:AllowIncident){const page=this.pages.page<OperationalIncident>('incident-history:'+id,authority,query,{from:'operational_incident_versions v',key:'v.id',select:'v.data',where:'v.incident_id=?',params:[id]},row=>{const incident=this.publicIncident(JSON.parse(String(row.data)) as OperationalIncident);return allow(incident as unknown as Record<string,unknown>,incident.resourceId??incident.id)?incident:undefined;});return {events:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore};}
  forEvent(eventId:number):OperationalIncident[]{const ids=this.store.db.prepare('SELECT DISTINCT incident_id AS id FROM operational_incident_versions WHERE event_id=?').all(eventId) as Array<{id:string}>;return ids.flatMap(value=>{const incident=this.getIncident(value.id);return incident?[incident]:[];});}
  incidentEventPage(after:number,limit:number,allow:AllowIncident,category?:string){
    const incidents:Array<{id:number;aggregateId:string;createdAt:string;incident:Record<string,unknown>}>=[];let cursor=after,hasMore=false;
    for(const value of this.store.db.prepare('SELECT event_id AS eventId,data FROM operational_source_events WHERE event_id>? ORDER BY event_id').iterate(after)){
      const event=JSON.parse(String(value.data)) as DurableEvent;if(event.type!=='incident'||!allow(event.payload,event.aggregateId)||category&&event.payload.category!==category)continue;if(incidents.length>=limit){hasMore=true;break;}incidents.push({id:event.id,aggregateId:event.aggregateId,createdAt:event.createdAt,incident:this.safeEvent(event.payload)});cursor=event.id;
    }return {incidents,cursor,hasMore};
  }
  summary(allowResource:(id:string)=>boolean,allowIncident:AllowIncident){
    const operations=this.operationCounts(allowResource),groups=new Set<string>();let openIncidents=0,unknownIncidents=0,coverageProblems=0;
    for(const value of this.store.db.prepare('SELECT o.resource FROM operations o JOIN operation_reviews r ON r.operation_id=o.id').iterate()){const resource=String(value.resource);if(!allowResource(resource))continue;const reviews=this.store.db.prepare('SELECT r.data FROM operation_reviews r JOIN operations o ON o.id=r.operation_id WHERE o.resource=?').all(resource) as Array<{data:string}>;if(reviews.some(row=>(JSON.parse(row.data) as OperationReview).disposition==='pending'))groups.add(this.canonical(resource));}
    for(const value of this.store.db.prepare('SELECT data FROM operational_incidents').iterate()){const incident=this.publicIncident(JSON.parse(String(value.data)) as OperationalIncident);if(!allowIncident(incident as unknown as Record<string,unknown>,incident.resourceId??incident.id)||!incident.actionable||!['open','unknown'].includes(incident.status))continue;if(incident.status==='open')openIncidents++;else unknownIncidents++;if(incident.kind==='coverage')coverageProblems++;groups.add(incident.canonicalResourceId??incident.key);}
    return {attentionGroups:groups.size,active:operations.active,pendingReviews:operations.review,openIncidents,unknownIncidents,coverageProblems};
  }
  bootstrap():void {
    this.store.atomic(()=>{
      for(const row of this.store.db.prepare('SELECT id FROM operations ORDER BY rowid').iterate())this.operationChanged(String(row.id));
      if(this.store.db.prepare("SELECT 1 FROM settings WHERE key='operational-bootstrap-v1'").get())return;
      let cursor=0;for(;;){const events=this.store.eventsAfter(cursor,250);if(!events.length)break;for(const event of events)this.acceptEvent(event);cursor=events[events.length-1]!.id;}
      this.store.db.prepare("INSERT INTO settings(key,value) VALUES ('operational-bootstrap-v1','true')").run();
    });
  }
}
