import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { incidentTargets } from '../server/incident-targets.js';
import type { OperationalIncident } from '../server/operational-types.js';
import { appendCostBudgetIncident } from './fixtures/aws-budget-events.js';

const ACTIVE='111111111111',OTHER='222222222222';
const stores=new Set<Store>(),directories=new Set<string>();
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'infra-budget-identity-'));directories.add(directory);
  const path=join(directory,'test.sqlite');let store=new Store(path);stores.add(store);
  let catalog=new CatalogRepository(store);
  const active=catalog.registerConnection({provider:'aws',providerAccountId:ACTIVE,name:'active',displayName:'A'.repeat(120),credentialRef:'fixture'});
  const other=catalog.registerConnection({provider:'aws',providerAccountId:OTHER,name:'lab',displayName:'S'.repeat(120),credentialRef:'fixture'});
  catalog.setConnectionState(other.id,'suspended');
  const append=(overrides:Record<string,unknown>={})=>{
    const before=store.latestEventId();
    const value=appendCostBudgetIncident(store,{accountId:ACTIVE,account:'A'.repeat(120),connectionId:active.id,budgetName:'active-budget-'.padEnd(100,'a'),overrides});
    const event=store.eventsAfter(before,250).find(event=>event.type==='incident'&&event.aggregateId===value.aggregateId)!;
    const row=store.db.prepare('SELECT data FROM operational_incidents').all().map(row=>JSON.parse(String(row.data)) as OperationalIncident).find(row=>row.openingEventId===event.id)!;
    expect(row).toBeDefined();return {...value,event,incident:row};
  };
  return {active,other,append,store:()=>store,catalog:()=>catalog,reopen:()=>{store.close();stores.delete(store);store=new Store(path);stores.add(store);catalog=new CatalogRepository(store);return store;}};
}
function stripMetadata(store:Store,id:string){
  const strip=(data:string)=>{const value=JSON.parse(data) as Record<string,unknown>;for(const key of ['accountId','account','budgetName','connectionId','sourceContext'])delete value[key];return JSON.stringify(value);};
  const current=store.db.prepare('SELECT data FROM operational_incidents WHERE id=?').get(id) as {data:string};
  store.db.prepare('UPDATE operational_incidents SET data=? WHERE id=?').run(strip(current.data),id);
  const versions=store.db.prepare('SELECT id,data FROM operational_incident_versions WHERE incident_id=?').all(id) as Array<{id:number;data:string}>;
  for(const version of versions)store.db.prepare('UPDATE operational_incident_versions SET data=? WHERE id=?').run(strip(version.data),version.id);
}
function stored(store:Store,id:string):Record<string,unknown>{return JSON.parse((store.db.prepare('SELECT data FROM operational_incidents WHERE id=?').get(id) as {data:string}).data);}
afterEach(()=>{vi.restoreAllMocks();try{for(const store of stores)store.close();stores.clear();}finally{for(const directory of directories)rmSync(directory,{recursive:true,force:true});directories.clear();}});

describe('identidad y procedencia durable del modelo de presupuestos',()=>{
  it('persiste accountId, nombre de presupuesto y evento exacto desde la primera proyección',()=>{
    const f=fixture(),value=f.append(),store=f.store();
    expect(value.aggregateId).toHaveLength(228);
    expect(stored(store,value.incident.id)).toMatchObject({accountId:ACTIVE,account:'A'.repeat(120),budgetName:value.budgetName,connectionId:f.active.id,kind:'budget',status:'information',resourceId:null,sourceContext:{eventIds:[value.event.id]}});
    const page=store.operational.incidentPage({view:'history',limit:100},'budget-account-test',payload=>payload.accountId===ACTIVE);
    expect(page.incidents).toHaveLength(1);
    expect(page.incidents[0]).toMatchObject({accountId:ACTIVE,budgetName:value.budgetName});
    expect(store.operational.incidentHistory(value.incident.id,{limit:100},'budget-version-test',payload=>payload.accountId===ACTIVE).events[0]).toMatchObject({accountId:ACTIVE,budgetName:value.budgetName});
    const next=f.reopen();
    const read=vi.spyOn(next,'eventsAfter');
    expect(next.operational.getIncident(value.incident.id)).toMatchObject({accountId:ACTIVE,connectionId:f.active.id,budgetName:value.budgetName,sourceContext:{eventIds:[value.event.id]}});
    expect(read).not.toHaveBeenCalled();
  });

  it('hidrata una versión heredada desde lineage sin crear versiones ni reemitir eventos',()=>{
    const f=fixture(),value=f.append(),store=f.store();
    const acknowledged=store.operational.acknowledge(value.incident.id,value.incident.version);
    stripMetadata(store,value.incident.id);
    const eventCursor=store.latestEventId();
    const versions=(store.db.prepare('SELECT COUNT(*) AS count FROM operational_incident_versions WHERE incident_id=?').get(value.incident.id) as {count:number}).count;
    const restored=store.operational.getIncident(value.incident.id)!;
    expect(restored).toMatchObject({accountId:ACTIVE,budgetName:value.budgetName,version:acknowledged.version,acknowledgement:acknowledged.acknowledgement,sourceContext:{eventIds:[value.event.id]}});
    expect(stored(store,value.incident.id)).toMatchObject({accountId:ACTIVE,sourceContext:{eventIds:[value.event.id]}});
    expect(store.latestEventId()).toBe(eventCursor);
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM operational_incident_versions WHERE incident_id=?').get(value.incident.id) as {count:number}).count).toBe(versions);
    const next=f.reopen();
    expect(next.operational.getIncident(value.incident.id)).toMatchObject({accountId:ACTIVE,budgetName:value.budgetName,version:acknowledged.version,acknowledgement:acknowledged.acknowledgement});
    expect(next.latestEventId()).toBe(eventCursor);
  });

  it('usa el archivo retenido exacto cuando el evento ya no está en el replay',()=>{
    const f=fixture(),value=f.append(),store=f.store();stripMetadata(store,value.incident.id);
    vi.spyOn(store,'eventsAfter').mockReturnValue([]);
    expect(store.operational.getIncident(value.incident.id)).toMatchObject({accountId:ACTIVE,budgetName:value.budgetName,sourceContext:{eventIds:[value.event.id]}});
    expect(stored(store,value.incident.id)).toMatchObject({accountId:ACTIVE});
  });

  it('no usa labels ni un evento posterior si desapareció el lineage retenido',()=>{
    const f=fixture(),value=f.append(),store=f.store();
    const later=appendCostBudgetIncident(store,{accountId:OTHER,account:'S'.repeat(120),connectionId:f.other.id,budgetName:'unrelated-budget'});
    stripMetadata(store,value.incident.id);
    store.db.prepare('DELETE FROM operational_source_events WHERE event_id=?').run(value.event.id);
    const original=store.eventsAfter.bind(store);
    vi.spyOn(store,'eventsAfter').mockImplementation((after,limit)=>original(after,limit===undefined?undefined:limit+1).filter(event=>event.id!==value.event.id).slice(0,limit));
    const restored=store.operational.getIncident(value.incident.id)!;
    expect(restored).not.toHaveProperty('accountId');
    expect(restored).not.toHaveProperty('sourceContext');
    expect(JSON.stringify(restored)).not.toContain(later.budgetName);
    expect(stored(store,value.incident.id)).not.toHaveProperty('accountId');
  });

  it('no mezcla identidades contradictorias entre openingEventId y lastEventId',()=>{
    const f=fixture(),first=f.append(),store=f.store();
    const other=f.append({accountId:OTHER,account:'S'.repeat(120),connectionId:f.other.id});
    stripMetadata(store,first.incident.id);
    const raw=stored(store,first.incident.id);raw.lastEventId=other.event.id;
    store.db.prepare('UPDATE operational_incidents SET data=? WHERE id=?').run(JSON.stringify(raw),first.incident.id);
    const restored=store.operational.getIncident(first.incident.id)!;
    expect(restored).toMatchObject({sourceContext:{conflict:true}});
    const targets=incidentTargets(restored as unknown as Record<string,unknown>,restored.id,f.catalog().listResources({includeRetired:true}));
    expect(targets.valid).toBe(false);
    expect(store.operational.incidentPage({view:'history',limit:100},'conflicting-budget',payload=>{
      const targets=incidentTargets(payload,String(payload.id??''),f.catalog().listResources({includeRetired:true}));
      return targets.valid&&payload.accountId===ACTIVE;
    }).incidents.some(incident=>incident.id===first.incident.id)).toBe(false);
  });

  it('conserva referencias explícitas y separa scope metadata de la identidad presupuestaria',()=>{
    const f=fixture(),value=f.append({resourceId:'aws:lab:i-unresolved',catalogId:'unresolved-catalog-id',scopeKey:'aws:ec2:us-east-1'});
    const projected=f.store().operational.getIncident(value.incident.id)!;
    expect(projected).toMatchObject({accountId:ACTIVE,resourceId:null,sourceContext:{eventIds:[value.event.id],resourceId:'aws:lab:i-unresolved',catalogId:'unresolved-catalog-id',scopeKey:'aws:ec2:us-east-1'}});
    expect(projected).not.toHaveProperty('scopeKey');
    const targets=incidentTargets(projected as unknown as Record<string,unknown>,projected.id,f.catalog().listResources({includeRetired:true}));
    expect(targets.kind).toBe('budget');
    expect(targets.resourceIds).toEqual(expect.arrayContaining(['aws:lab:i-unresolved','catalog:unresolved-catalog-id']));
    expect(f.catalog().isResourceReferenceActive(targets.resourceIds[0])).toBe(false);
  });
});
