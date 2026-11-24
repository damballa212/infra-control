import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AwsCatalogDiscovery, type AwsDiscoveryIO } from '../server/aws-discovery.js';
import { CatalogRepository } from '../server/catalog.js';
import { parseConfig } from '../server/config.js';
import { resolveConfiguredProbeResource } from '../server/service-probes.js';
import { Store } from '../server/store.js';
import type { AwsAccount, ServiceDefinition, ServiceProbeTarget } from '../server/types.js';

type ActivationPlan={schemaVersion:number;awsConnection:AwsAccount;services:ServiceDefinition[];serviceProbes:ServiceProbeTarget[];alwaysOn:string[]};
const expected=[
  {key:'prod-cms-production',id:'i-0b4413f90cc7e0831'},
  {key:'shop-atencion-production',id:'i-0d72dff3f7a35d4d7'},
  {key:'shop-rendicion-production',id:'i-07ef7c6aa0c5e6038'}
];

describe('referencias públicas del plan de activación AWS',()=>{
  it('resuelve services, probes y alwaysOn mediante el mapper real de discovery sin ampliar power',async()=>{
    const plan=JSON.parse(readFileSync(new URL('../research/2026-11-14-cloud-activation-plan.json',import.meta.url),'utf8')) as ActivationPlan;
    expect(plan.schemaVersion).toBe(1);
    expect(plan.awsConnection).toMatchObject({name:'shop-dev',accountId:'100000000001',sourceAccount:'prod',instances:[]});
    const config=parseConfig({
      origin:'https://control.example.test',passwordHash:'fixture',agentTokens:[],
      aws:[{name:'prod',accountId:'100000000002',accessKeyId:'fixture-source',secretAccessKey:'fixture-source',instances:[]},plan.awsConnection],
      coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},services:plan.services,serviceProbes:plan.serviceProbes
    });
    const store=new Store(':memory:'),catalog=new CatalogRepository(store);
    try{
      catalog.configureServices(config.services??[]);
      expect(catalog.listServices()).toHaveLength(3);
      expect(catalog.listServices().flatMap(service=>service.relations).every(relation=>!relation.resolved&&relation.resourceId===null)).toBe(true);
      const configured=new Set<string>();
      for(const target of config.serviceProbes??[])expect(resolveConfiguredProbeResource(catalog,configured,target.resourceId,target)).toBeUndefined();
      const identity=vi.fn(async(account:AwsAccount,all?:readonly AwsAccount[])=>{
        expect(all).toBe(config.aws);return account.accountId;
      });
      const regions=vi.fn(async(_account:AwsAccount,all?:readonly AwsAccount[])=>{
        expect(all).toBe(config.aws);return {regions:['us-east-1']};
      });
      const instances=vi.fn(async(account:AwsAccount,region:string,nextToken?:string,all?:readonly AwsAccount[])=>{
        expect(all).toBe(config.aws);expect(region).toBe('us-east-1');expect(nextToken).toBeUndefined();
        // No aliases in the fixture: serializeInstance must produce them.
        return {instances:account.accountId==='100000000001'?expected.map(item=>({InstanceId:item.id,InstanceType:'t3.small',State:{Name:'running'},Tags:[{Key:'Name',Value:item.key}]})):[]};
      });
      const io:AwsDiscoveryIO={identity,regions,instances,now:()=>Date.now()};
      const result=await new AwsCatalogDiscovery(catalog,config.aws,io).scan();
      expect(result.failures).toBe(0);expect(result.resources).toHaveLength(3);
      expect(identity).toHaveBeenCalledTimes(2);expect(instances).toHaveBeenCalledTimes(2);
      for(const connection of catalog.connections())if(connection.state==='active')configured.add(connection.id);
      const resolveExpected=(reference:string,id:string)=>{
        expect(reference.split(':')).toHaveLength(4);
        const record=catalog.resolveAlias(reference);
        expect(record).toMatchObject({provider:'aws',accountId:'100000000001',region:'us-east-1',resourceType:'ec2-instance',providerId:id,lifecycle:'active'});
        expect(record?.aliases).toContain(reference);
        return record!;
      };
      expect(plan.services).toHaveLength(3);
      for(const item of expected){
        const definition=plan.services.find(service=>service.key===item.key)!;
        expect(definition).toBeDefined();expect(definition.relations).toHaveLength(1);
        const record=resolveExpected(definition.relations[0].resourceId,item.id);
        const service=catalog.listServices().find(service=>service.key===item.key)!;
        expect(service.relations).toHaveLength(1);
        expect(service.relations[0]).toMatchObject({resolved:true,resourceId:record.catalogId,resourceAlias:definition.relations[0].resourceId});
      }
      expect(config.serviceProbes).toHaveLength(3);
      for(const [index,target] of (config.serviceProbes??[]).entries()){
        const record=resolveExpected(target.resourceId,expected[index].id);
        expect(resolveConfiguredProbeResource(catalog,configured,target.resourceId,target)).toBe(`catalog:${record.catalogId}`);
      }
      expect(plan.alwaysOn).toHaveLength(3);
      for(const [index,reference] of plan.alwaysOn.entries()){
        const record=resolveExpected(reference,expected[index].id);
        expect(store.operational.setExpectation(reference,'always-on',0)).toMatchObject({resourceId:`catalog:${record.catalogId}`,mode:'always-on'});
      }
      expect(config.aws.flatMap(account=>account.instances??[])).toEqual([]);
      const inventory=catalog.mergeInventory([],new Set());
      expect(inventory).toHaveLength(3);
      expect(inventory.every(resource=>resource.actions.length===0)).toBe(true);
    }finally{store.close();}
  });
});
