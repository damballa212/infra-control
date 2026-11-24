import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateProductionMonitoring, type MonitoringActivationPlan } from '../server/monitoring-activation.js';
import { AwsCatalogDiscovery, type AwsDiscoveryIO } from '../server/aws-discovery.js';
import { CatalogRepository } from '../server/catalog.js';
import { parseConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import type { ServiceDefinition, ServiceProbeTarget } from '../server/types.js';

const T0=Date.parse('2026-11-14T12:00:00Z');
const stores:Store[]=[];
const expected=['i-0b4413f90cc7e0831','i-0d72dff3f7a35d4d7','i-07ef7c6aa0c5e6038'];
function fixture(){
  const plan=JSON.parse(readFileSync(new URL('../research/2026-11-14-cloud-activation-plan.json',import.meta.url),'utf8')) as MonitoringActivationPlan;
  const unrelated:ServiceDefinition={key:'unrelated',name:'Unrelated service',criticality:'normal',relations:[]};
  const extraProbe:ServiceProbeTarget={resourceId:'aws:100000000002:us-east-1:i-1234567890abcdef0',url:'https://other.example.com/health',expectedStatusCodes:[200],intervalSeconds:60,timeoutMs:3000};
  const config=parseConfig({origin:'https://control.example.test',passwordHash:'fixture',agentTokens:[],aws:[
    {name:'prod',accountId:'100000000002',accessKeyId:'fixture-source',secretAccessKey:'fixture-source',instances:[]},
    plan.awsConnection,
    {...plan.suspend,accessKeyId:'fixture-suspended',secretAccessKey:'fixture-suspended',instances:[]}
  ],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},services:[...structuredClone(plan.services),unrelated],serviceProbes:[...structuredClone(plan.serviceProbes),extraProbe]});
  const store=new Store(':memory:');stores.push(store);const catalog=new CatalogRepository(store);
  catalog.configureServices([unrelated]);
  store.operational.setExpectation('computer:mac','on-demand',0);
  const mode={identityFailure:false,identityMismatch:false,regionsFailure:false,instancesFailure:false,otherRegionsFailure:false,missingTarget:false,stopped:false,offset:0,changeConfig:false};
  const identity=vi.fn<AwsDiscoveryIO['identity']>(async(account,all)=>{
    expect(all).toBe(config.aws);
    if(account.accountId===plan.awsConnection.accountId){
      if(mode.identityFailure)throw Object.assign(new Error('fixture provider failure'),{name:'AccessDenied'});
      if(mode.identityMismatch)return '999999999999';
    }
    return account.accountId;
  });
  const regions=vi.fn<AwsDiscoveryIO['regions']>(async(account,all)=>{
    expect(all).toBe(config.aws);
    if(account.accountId===plan.awsConnection.accountId?mode.regionsFailure:mode.otherRegionsFailure)throw Object.assign(new Error('fixture directory denied'),{name:'UnauthorizedOperation'});
    return {regions:['us-east-1']};
  });
  const instances=vi.fn<AwsDiscoveryIO['instances']>(async(account,region,token,all)=>{
    expect(all).toBe(config.aws);expect(region).toBe('us-east-1');expect(token).toBeUndefined();
    if(account.accountId!==plan.awsConnection.accountId)return {instances:[]};
    if(mode.instancesFailure)throw new Error('fixture EC2 failure');
    if(mode.changeConfig)config.serviceProbes=[];
    return {instances:expected.filter((_id,index)=>!mode.missingTarget||index!==2).map(id=>({InstanceId:id,InstanceType:'t3.small',State:{Name:mode.stopped?'stopped':'running'}}))};
  });
  const io:AwsDiscoveryIO={identity,regions,instances,now:()=>Date.now()+mode.offset};
  const snapshot=()=>({
    services:store.db.prepare('SELECT * FROM catalog_services ORDER BY id').all(),
    relations:store.db.prepare('SELECT * FROM catalog_service_resources ORDER BY service_id,resource_ref,relation_type').all(),
    projects:store.db.prepare("SELECT * FROM catalog_projects WHERE source='service-config' ORDER BY id").all(),
    expectations:store.db.prepare('SELECT * FROM availability_expectations ORDER BY resource_key').all(),
    ownerAudit:store.db.prepare('SELECT * FROM operational_owner_audit ORDER BY id').all()
  });
  const configure=vi.spyOn(catalog,'configureServices'),expectation=vi.spyOn(store.operational,'setExpectation');
  const run=()=>activateProductionMonitoring({config,plan,store,catalog,discovery:new AwsCatalogDiscovery(catalog,config.aws,io)});
  const seed=async()=>{
    vi.setSystemTime(new Date(T0-60000));
    await new AwsCatalogDiscovery(catalog,config.aws,io).scan();
    vi.setSystemTime(new Date(T0));
    identity.mockClear();regions.mockClear();instances.mockClear();
  };
  const rejectedWithoutPolicyChanges=async()=>{
    const before=snapshot();await expect(run()).rejects.toThrow();
    expect(configure).not.toHaveBeenCalled();expect(expectation).not.toHaveBeenCalled();expect(snapshot()).toEqual(before);
  };
  return {plan,config,store,catalog,mode,identity,regions,instances,configure,expectation,snapshot,run,seed,rejectedWithoutPolicyChanges};
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(T0));});
afterEach(()=>{try{for(const store of stores.splice(0))store.close();}finally{vi.restoreAllMocks();vi.useRealTimers();}});

describe('activación productiva con evidencia del barrido actual',()=>{
  it('activa los tres targets y conserva servicios/sondas ajenos de la configuración efectiva',async()=>{
    const f=fixture();const probes=structuredClone(f.config.serviceProbes);
    const result=await f.run();
    expect(result).toMatchObject({productionAccountId:'100000000001',criticalServices:3,eligibleProbes:3,discoveryFailures:0});
    expect(result.checks).toHaveLength(3);expect(f.configure).toHaveBeenCalledTimes(1);expect(f.expectation).toHaveBeenCalledTimes(3);
    expect(f.config.serviceProbes).toEqual(probes);
    expect(f.catalog.listServices().find(service=>service.key==='unrelated')).toMatchObject({active:true,name:'Unrelated service'});
    for(const check of result.checks)expect(f.store.operational.expectation(`catalog:${check.catalogId}`)).toMatchObject({mode:'always-on'});
    expect(f.catalog.mergeInventory([],new Set()).every(resource=>resource.actions.length===0)).toBe(true);
  });

  it('STS fallido no reutiliza los targets y scopes EC2 sanos anteriores',async()=>{
    const f=fixture();await f.seed();f.mode.identityFailure=true;
    await f.rejectedWithoutPolicyChanges();
    expect(f.identity.mock.calls.some(([account])=>account.accountId===f.plan.awsConnection.accountId)).toBe(true);
    expect(f.catalog.listResources().filter(record=>record.accountId===f.plan.awsConnection.accountId)).toHaveLength(3);
    expect(f.catalog.listScopes().some(scope=>scope.scopeKey==='aws:ec2:us-east-1'&&scope.state==='healthy')).toBe(true);
  });

  it('una identidad física distinta rechaza la activación sin cambios de políticas',async()=>{
    const f=fixture();await f.seed();f.mode.identityMismatch=true;await f.rejectedWithoutPolicyChanges();
  });

  it('un fallo EC2 no acredita los targets antiguos',async()=>{
    const f=fixture();await f.seed();f.mode.instancesFailure=true;await f.rejectedWithoutPolicyChanges();
  });

  it('un directorio de producción fallido no se oculta por el fallback de regiones conocidas',async()=>{
    const f=fixture();await f.seed();f.mode.regionsFailure=true;await f.rejectedWithoutPolicyChanges();
    expect(f.instances.mock.calls.some(([account])=>account.accountId===f.plan.awsConnection.accountId)).toBe(true);
  });

  it('un fallo de directorio ajeno no invalida evidencia completa de producción',async()=>{
    const f=fixture();f.mode.otherRegionsFailure=true;
    const result=await f.run();
    expect(result.eligibleProbes).toBe(3);expect(result.discoveryFailures).toBeGreaterThan(0);
    expect(f.expectation).toHaveBeenCalledTimes(3);
  });

  it.each([-1000,60000])('rechaza timestamps fuera del barrido con offset %s',async offset=>{
    const f=fixture();f.mode.offset=offset;await f.rejectedWithoutPolicyChanges();
  });

  it('rechaza scopes sin generación avanzada aunque conserven estado healthy',async()=>{
    const f=fixture();await f.seed();f.mode.offset=-60000;f.mode.instancesFailure=true;
    await f.rejectedWithoutPolicyChanges();
  });

  it('un snapshot completo que omite un target no activa expectativas sobre su fila anterior',async()=>{
    const f=fixture();await f.seed();f.mode.missingTarget=true;await f.rejectedWithoutPolicyChanges();
  });

  it('una observación fresca stopped sigue siendo válida para una expectativa always-on',async()=>{
    const f=fixture();f.mode.stopped=true;const result=await f.run();
    expect(result.checks.every(check=>check.state==='stopped'&&check.expectation==='always-on')).toBe(true);
  });

  it('sin sondas efectivas falla antes del discovery o cualquier escritura de servicios',async()=>{
    const f=fixture();f.config.serviceProbes=[];await f.rejectedWithoutPolicyChanges();expect(f.identity).not.toHaveBeenCalled();
  });

  it.each(['url','status','interval','timeout','host','target'] as const)('rechaza configuración de probe distinta: %s',async field=>{
    const f=fixture(),probe=f.config.serviceProbes![0];
    if(field==='url')probe.url='https://different.example.com/health';
    if(field==='status')probe.expectedStatusCodes=[204];
    if(field==='interval')probe.intervalSeconds=120;
    if(field==='timeout')probe.timeoutMs=1000;
    if(field==='host')probe.hostResourceId=f.plan.alwaysOn[1];
    if(field==='target')probe.resourceId=f.plan.alwaysOn[1];
    await f.rejectedWithoutPolicyChanges();expect(f.identity).not.toHaveBeenCalled();
  });

  it('detecta probes duplicadas por UUID aunque usen referencias distintas',async()=>{
    const f=fixture();await f.seed();
    const record=f.catalog.resolveAlias(f.plan.serviceProbes[0].resourceId)!;
    f.config.serviceProbes!.push({...f.config.serviceProbes![0],resourceId:`catalog:${record.catalogId}`});
    await f.rejectedWithoutPolicyChanges();expect(f.identity).not.toHaveBeenCalled();
  });

  it.each(['name','projectKey','projectName','environment','criticality','relationType','evidence'] as const)('rechaza metadatos efectivos del servicio distintos: %s',async field=>{
    const f=fixture(),service=f.config.services![0];
    if(field==='name')service.name='Different service';
    if(field==='projectKey')service.projectKey='different-project';
    if(field==='projectName')service.projectName='Different project';
    if(field==='environment')service.environment='staging';
    if(field==='criticality')service.criticality='normal';
    if(field==='relationType')service.relations[0].relationType='depends_on';
    if(field==='evidence')service.relations[0].evidence='provider_metadata';
    await f.rejectedWithoutPolicyChanges();expect(f.identity).not.toHaveBeenCalled();
  });

  it('rechaza una relación configurada ya resuelta a otro UUID físico',async()=>{
    const f=fixture();await f.seed();
    const wrong=f.catalog.resolveAlias(f.plan.alwaysOn[1])!;
    f.config.services![0].relations[0].resourceId=`catalog:${wrong.catalogId}`;
    await f.rejectedWithoutPolicyChanges();expect(f.identity).not.toHaveBeenCalled();
  });

  it('revalida la configuración si cambia durante el await del discovery',async()=>{
    const f=fixture();f.mode.changeConfig=true;await f.rejectedWithoutPolicyChanges();
  });

  it('una relación persistida al UUID incorrecto revierte configureServices y no escribe expectativas',async()=>{
    const f=fixture(),before=f.snapshot(),original=CatalogRepository.prototype.configureServices.bind(f.catalog);
    f.configure.mockImplementation(definitions=>{
      original(definitions);
      const wrong=f.catalog.resolveAlias(f.plan.alwaysOn[1])!;
      f.store.db.prepare('UPDATE catalog_service_resources SET resource_id=? WHERE resource_ref=?').run(wrong.catalogId,f.plan.services[0].relations[0].resourceId);
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.configure).toHaveBeenCalledTimes(1);expect(f.expectation).not.toHaveBeenCalled();expect(f.snapshot()).toEqual(before);
  });

  it('un fallo al guardar expectativas revierte también servicios y expectativas anteriores del lote',async()=>{
    const f=fixture(),before=f.snapshot(),cursor=f.store.latestEventId(),original=f.store.operational.setExpectation.bind(f.store.operational);
    let calls=0;f.expectation.mockImplementation((id,mode,version)=>{if(++calls===2)throw new Error('fixture write failure');return original(id,mode,version);});
    await expect(f.run()).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(f.store.eventsAfter(cursor,250).some(event=>event.payload.expectationChanged===true)).toBe(false);
  });
});
