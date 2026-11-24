import assert from 'node:assert/strict';
import type { AwsCatalogDiscovery } from './aws-discovery.js';
import { isAwsAccountEnabled } from './aws-credentials.js';
import type { CatalogRepository, CatalogResourceRecord, CatalogScopeRecord } from './catalog.js';
import { resolveConfiguredProbeResource } from './service-probes.js';
import type { Store } from './store.js';
import type { AwsAccount, Config, ServiceDefinition, ServiceProbeTarget } from './types.js';

export type MonitoringActivationPlan={
  schemaVersion:number;
  awsConnection:Pick<AwsAccount,'name'|'accountId'|'roleArn'|'sourceAccount'|'enabled'|'instances'>;
  suspend:{name:string;accountId:string;enabled:false;disabledReason:'account_suspended'};
  services:ServiceDefinition[];serviceProbes:ServiceProbeTarget[];alwaysOn:string[];
};
export type MonitoringActivationInput={
  config:Config;plan:MonitoringActivationPlan;store:Store;catalog:CatalogRepository;
  discovery:AwsCatalogDiscovery;now?:()=>number;
};
const MAX_SCAN_MS=1_200_000;
const scopeId=(connectionId:string,key:string)=>JSON.stringify([connectionId,key]);
const physicalId=(record:Pick<CatalogResourceRecord,'provider'|'accountId'|'region'|'resourceType'|'providerId'>)=>JSON.stringify([record.provider,record.accountId,record.region,record.resourceType,record.providerId]);
function canonicalAws(reference:string){
  const match=/^aws:(\d{12}):([a-z]{2,8}(?:-[a-z0-9]+)+-\d+):(i-[a-f0-9]{8,32})$/.exec(reference);
  return match?{provider:'aws' as const,accountId:match[1]!,region:match[2]!,resourceType:'ec2-instance',providerId:match[3]!}:undefined;
}
const sorted=(values:string[])=>[...values].sort();

/** Requires the stopped singleton and deployment lease to be held by its caller.
 * Discovery may persist provider evidence. Services and expectations commit only
 * after every production/configuration check succeeds, in one transaction.
 */
export async function activateProductionMonitoring({config,plan,store,catalog,discovery,now=Date.now}:MonitoringActivationInput){
  assert.equal(plan.schemaVersion,1,'Unsupported activation plan');
  assert.equal(plan.alwaysOn.length,3,'Three production targets required');
  assert.equal(plan.serviceProbes.length,3,'Three approved probes required');
  assert.equal(plan.services.length,3,'Three approved services required');
  const approved=plan.alwaysOn.map(reference=>{
    const identity=canonicalAws(reference);
    assert(identity&&identity.accountId===plan.awsConnection.accountId,'Invalid production reference');
    return {reference,identity,key:physicalId(identity)};
  });
  const targetKeys=new Set(approved.map(target=>target.key));
  assert.equal(targetKeys.size,3,'Duplicate production target');
  assert.equal(new Set(plan.services.map(service=>service.key.toLocaleLowerCase())).size,plan.services.length,'Duplicate approved service');
  const records=()=>catalog.listResources({includeRetired:true});
  const resolve=(reference:string):CatalogResourceRecord|undefined=>reference.startsWith('catalog:')
    ?records().find(record=>record.catalogId===reference.slice('catalog:'.length))
    :records().find(record=>record.aliases.includes(reference));
  const identity=(reference:string):string=>{
    const canonical=canonicalAws(reference);if(canonical)return physicalId(canonical);
    const record=resolve(reference);return record?physicalId(record):JSON.stringify(['unresolved',reference]);
  };
  const relations=(definition:ServiceDefinition)=>{
    const values=definition.relations.map(relation=>JSON.stringify([identity(relation.resourceId),relation.relationType,relation.evidence]));
    assert.equal(new Set(values).size,values.length,'Duplicate service relation');return sorted(values);
  };
  const serviceSignature=(definition:ServiceDefinition)=>[
    definition.key,definition.name,definition.projectKey??null,definition.projectName??null,
    definition.environment??null,definition.criticality,relations(definition)
  ];
  const probeSignature=(probe:ServiceProbeTarget)=>[
    identity(probe.resourceId),probe.url,[...probe.expectedStatusCodes].sort((a,b)=>a-b),
    probe.intervalSeconds,probe.timeoutMs,probe.hostResourceId===undefined?null:identity(probe.hostResourceId)
  ];
  const validateConfiguration=()=>{
    const production=config.aws.find(account=>account.name===plan.awsConnection.name);
    assert(production&&isAwsAccountEnabled(production,config.aws)&&production.accountId===plan.awsConnection.accountId,'Production connection mismatch');
    assert(typeof plan.awsConnection.roleArn==='string'&&typeof plan.awsConnection.sourceAccount==='string','Approved role required');
    assert.equal(production.roleArn,plan.awsConnection.roleArn,'Production role mismatch');
    assert.equal(production.sourceAccount,plan.awsConnection.sourceAccount,'Production source mismatch');
    assert.equal(production.instances?.length??0,0,'No new power allowlist permitted');
    const suspended=config.aws.find(account=>account.name===plan.suspend.name);
    assert(suspended&&suspended.accountId===plan.suspend.accountId&&suspended.enabled===false&&suspended.disabledReason==='account_suspended','Suspension mismatch');
    const configuredProbes=config.serviceProbes??[],probeKeys=configuredProbes.map(probe=>identity(probe.resourceId));
    assert.equal(new Set(probeKeys).size,probeKeys.length,'Duplicate physical probe target');
    const approvedProbeKeys=plan.serviceProbes.map(probe=>identity(probe.resourceId));
    assert.deepEqual(sorted(approvedProbeKeys),sorted([...targetKeys]),'Approved probes do not cover production targets');
    for(const probe of plan.serviceProbes){
      if(probe.hostResourceId!==undefined)assert(targetKeys.has(identity(probe.hostResourceId)),'Unapproved probe host');
      const matches=configuredProbes.filter(actual=>identity(actual.resourceId)===identity(probe.resourceId));
      assert.equal(matches.length,1,'Approved probe not configured');
      assert.deepEqual(probeSignature(matches[0]!),probeSignature(probe),'Probe configuration mismatch');
    }
    const definitions=config.services??[];
    assert.equal(new Set(definitions.map(definition=>definition.key.toLocaleLowerCase())).size,definitions.length,'Duplicate configured service');
    for(const definition of plan.services){
      for(const relation of definition.relations)assert(targetKeys.has(identity(relation.resourceId)),'Unapproved service target');
      const matches=definitions.filter(actual=>actual.key===definition.key);
      assert.equal(matches.length,1,'Approved service not configured');
      assert.deepEqual(serviceSignature(matches[0]!),serviceSignature(definition),'Service configuration mismatch');
    }
    return production;
  };
  const production=validateConfiguration();
  const beforeScopes=new Map(catalog.listScopes().map(scope=>[scopeId(scope.connectionId,scope.scopeKey),scope.generation]));
  const beforeRecords=new Map(records().map(record=>[record.catalogId,record.observedAt]));
  const scanStart=now();assert(Number.isFinite(scanStart),'Invalid scan clock');
  const scan=await discovery.scan();
  const scanEnd=now();
  assert(Number.isFinite(scanEnd)&&scanEnd>=scanStart&&scanEnd-scanStart<=MAX_SCAN_MS,'Invalid or stale scan window');
  const inWindow=(value:string|null)=>{
    const time=value===null?NaN:Date.parse(value);return Number.isFinite(time)&&time>=scanStart&&time<=scanEnd;
  };
  const verifyScan=()=>{
    const connection=catalog.connectionByAlias('aws',production.name);
    assert(connection&&connection.providerAccountId===production.accountId,'Production connection unresolved');
    assert(catalog.connections().some(item=>item.id===connection.id&&item.state==='active'),'Production connection inactive');
    const scopes=catalog.listScopes();
    const required=new Set(['aws:identity','aws:regions',...approved.map(target=>`aws:ec2:${target.identity.region}`)]);
    for(const key of required){
      const scope:CatalogScopeRecord|undefined=scopes.find(item=>item.connectionId===connection.id&&item.scopeKey===key);
      assert(scope&&scope.state==='healthy'&&scope.generation>(beforeScopes.get(scopeId(connection.id,key))??0),'Production scope not completed in this scan');
      assert(inWindow(scope.lastAttemptAt)&&inWindow(scope.lastSuccessAt)&&scope.lastAttemptAt===scope.lastSuccessAt,'Production scope timestamp outside scan');
    }
    return approved.map(target=>{
      const record=resolve(target.reference);
      assert(record&&record.connectionId===connection.id&&physicalId(record)===target.key,'Production target unresolved');
      const scope=scopes.find(item=>item.connectionId===connection.id&&item.scopeKey===`aws:ec2:${target.identity.region}`);
      assert(record.lifecycle==='active'&&record.scopeKey===scope?.scopeKey&&inWindow(record.observedAt)&&record.observedAt===scope.lastSuccessAt,'Production target not observed in this scan');
      const previous=beforeRecords.get(record.catalogId);
      assert(previous===undefined||previous===null||Date.parse(record.observedAt!)>Date.parse(previous),'Production target observation did not advance');
      assert(scan.resources.some(item=>item.catalogId===record.catalogId&&physicalId(item)===target.key),'Production target absent from scan result');
      return {reference:target.reference,record};
    });
  };
  validateConfiguration();
  verifyScan();
  const configured=new Set(catalog.connections().filter(connection=>connection.state==='active'&&config.aws.some(account=>account.accountId===connection.providerAccountId&&isAwsAccountEnabled(account,config.aws))).map(connection=>connection.id));
  const verifyResolvedConfiguration=()=>{
    for(const probe of plan.serviceProbes){
      const actual=(config.serviceProbes??[]).find(item=>identity(item.resourceId)===identity(probe.resourceId))!;
      const expected=resolve(probe.resourceId),record=resolve(actual.resourceId);
      assert(expected&&record&&record.catalogId===expected.catalogId,'Configured probe resolves to wrong UUID');
      assert(resolveConfiguredProbeResource(catalog,configured,actual.resourceId,actual)===`catalog:${expected.catalogId}`,'Configured probe is ineligible');
      if(probe.hostResourceId!==undefined)assert(resolve(actual.hostResourceId!)?.catalogId===resolve(probe.hostResourceId)?.catalogId,'Configured probe host resolves to wrong UUID');
    }
    for(const definition of plan.services){
      const actual=(config.services??[]).find(item=>item.key===definition.key)!;
      const expected=definition.relations.map(relation=>{
        const record=resolve(relation.resourceId);assert(record,'Approved service reference unresolved');
        return JSON.stringify([record.catalogId,relation.relationType,relation.evidence]);
      });
      const resolved=actual.relations.map(relation=>{
        const record=resolve(relation.resourceId);assert(record,'Configured service reference unresolved');
        return JSON.stringify([record.catalogId,relation.relationType,relation.evidence]);
      });
      assert.deepEqual(sorted(resolved),sorted(expected),'Configured service resolves to wrong UUID');
    }
  };
  verifyResolvedConfiguration();
  return store.atomic(()=>{
    // Revalidate after the await and before the first service/policy write.
    validateConfiguration();const targets=verifyScan();verifyResolvedConfiguration();
    catalog.configureServices(config.services??[]);
    for(const definition of plan.services){
      const actual=catalog.listServices().find(service=>service.key===definition.key.toLocaleLowerCase());
      assert(actual&&actual.active&&actual.source==='service-config','Approved service was not persisted');
      assert.equal(actual.name,definition.name,'Persisted service name mismatch');
      assert.equal(actual.environment,definition.environment??null,'Persisted service environment mismatch');
      assert.equal(actual.criticality,definition.criticality,'Persisted service criticality mismatch');
      if(definition.projectKey){
        const project=store.db.prepare("SELECT id,name FROM catalog_projects WHERE source='service-config' AND external_key=?").get(definition.projectKey.toLocaleLowerCase()) as {id:string;name:string}|undefined;
        assert(project&&project.name===definition.projectName&&actual.projectId===project.id&&actual.project===definition.projectName,'Persisted service project mismatch');
      }else assert.equal(actual.projectId,null,'Unexpected service project');
      const active=actual.relations.filter(relation=>relation.active);
      assert(active.every(relation=>relation.resolved&&relation.resourceId!==null&&resolve(relation.resourceAlias)?.catalogId===relation.resourceId),'Persisted service relation unresolved or inconsistent');
      const expected=definition.relations.map(relation=>JSON.stringify([resolve(relation.resourceId)!.catalogId,relation.relationType,relation.evidence]));
      assert.deepEqual(sorted(active.map(relation=>JSON.stringify([relation.resourceId,relation.relationType,relation.evidence]))),sorted(expected),'Persisted service relation UUID/type/evidence mismatch');
    }
    const checks=targets.map(({reference,record})=>{
      const id=`catalog:${record.catalogId}`,current=store.operational.expectation(id);
      const expectation=store.operational.setExpectation(id,'always-on',current.version);
      return {resourceId:reference,catalogId:record.catalogId,state:record.state,expectation:expectation.mode};
    });
    return {productionAccountId:production.accountId,checks,criticalServices:plan.services.length,eligibleProbes:plan.serviceProbes.length,discoveryFailures:scan.failures,scanStartedAt:new Date(scanStart).toISOString(),scanCompletedAt:new Date(scanEnd).toISOString()};
  });
}
