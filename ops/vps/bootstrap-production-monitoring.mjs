// Run only in a one-shot container holding /data/instance.lock, with api stopped.
// No Cost Explorer, power operations, credential printing or IAM writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseConfig} from './dist/server/config.js';
import {Store} from './dist/server/store.js';
import {CatalogRepository} from './dist/server/catalog.js';
import {AwsCatalogDiscovery} from './dist/server/aws-discovery.js';
import {activateProductionMonitoring} from './dist/server/monitoring-activation.js';

let store;
try{
  assert.equal(process.env.INFRA_BOOTSTRAP_SINGLETON,'1','Explicit stopped-singleton guard required');
  const owner=process.env.DEPLOYMENT_GATE_OWNER;
  assert(owner,'Deployment gate owner required');
  const database=join(process.env.DATA_DIR??'/data','infra.sqlite');
  const preflight=new DatabaseSync(database,{readOnly:true});
  try{
    const row=preflight.prepare("SELECT value FROM settings WHERE key='deployment-gate'").get();
    assert(row,'Deployment gate missing');
    const gate=JSON.parse(String(row.value));
    assert.equal(gate.owner,owner,'Wrong deployment gate owner');
    assert(Date.parse(gate.expiresAt)>Date.now(),'Deployment gate expired');
    const active=preflight.prepare("SELECT COUNT(*) AS n FROM operations WHERE state IN ('accepted','running')").get();
    assert.equal(Number(active.n),0,'Operations still active');
  }finally{preflight.close();}
  const config=parseConfig(JSON.parse(readFileSync(process.env.CONFIG_PATH??'/run/secrets/config.json','utf8')));
  const plan=JSON.parse(readFileSync(process.argv[2]??'/app/activation-plan.json','utf8'));
  store=new Store(database);
  const catalog=new CatalogRepository(store);
  const discovery=new AwsCatalogDiscovery(catalog,config.aws);
  const activation=await activateProductionMonitoring({config,plan,store,catalog,discovery});
  console.log(JSON.stringify({phase:'production monitoring bootstrap verified',...activation,paidCostExplorerCalls:0,powerCommands:0}));
}catch(error){
  console.error(JSON.stringify({phase:'production monitoring bootstrap failed',errorName:error instanceof Error?error.name:'Error'}));
  process.exitCode=1;
}finally{store?.close();}
