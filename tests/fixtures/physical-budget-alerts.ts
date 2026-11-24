import { InfrastructureMonitor } from '../../server/monitor.js';
import type { CostReport } from '../../server/costs.js';
import type { Store } from '../../server/store.js';

/** Real monitor -> durable budget event -> operational projection, without AWS IO. */
export async function emitPhysicalBudgetAlerts(store:Store,accountIds:readonly string[]){
  const now=new Date().toISOString(),cursor=store.latestEventId();
  const report:CostReport={periodStart:'2026-11-01',periodEnd:'2026-11-14',fetchedAt:now,nextRefreshAt:now,policy:'fixture',accounts:accountIds.map(accountId=>({
    accountId,account:'Shared label',status:'available',net:85,usage:85,adjustments:0,currency:'USD',estimated:true,services:[],daily:[],budgetsStatus:'available',fetchedAt:now,
    budgets:[{name:'Shared budget',limit:100,actual:85,forecast:null,currency:'USD',updatedAt:now}]
  }))};
  const monitor=new InfrastructureMonitor(store,{inventory:async()=>[],perform:async()=>{throw new Error('No power operations');}},{get:async()=>report});
  try{await monitor.tick();}finally{monitor.close();}
  return store.eventsAfter(cursor,250).filter(event=>event.type==='incident'&&event.payload.category==='budget');
}
