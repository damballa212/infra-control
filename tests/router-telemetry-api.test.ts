import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { Adapter, Config } from '../server/types.js';

const config:Config={origin:'https://test.example',passwordHash:'unused',agentTokens:[{name:'reader',hash:tokenHash('reader-token'),scopes:['read']}],aws:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''},routerTelemetryTokenHash:tokenHash('router-telemetry-only')};
const apps:ReturnType<typeof createApp>[]=[];
afterEach(()=>apps.splice(0).forEach(app=>app.locals.close()));
function setup(adapter?:Adapter){const app=createApp(config,':memory:',adapter);apps.push(app);return app;}
const sample={version:1,bootId:'fiberhome-boot-0001',streamId:'router-collector-0001',sequence:1,uptimeSeconds:3600,cpuPercent:9,memTotalBytes:128*1024*1024,memAvailableBytes:64*1024*1024};

describe('API de salud del FiberHome sin consultas bloqueantes',()=>{
  it('acepta solo token exclusivo, expone presencia y no marca la WAN como verificada',async()=>{
    const app=setup();
    expect((await request(app).get('/api/router/health')).status).toBe(401);
    expect((await request(app).post('/api/router/telemetry').set('Authorization','Bearer reader-token').send(sample)).status).toBe(401);
    expect((await request(app).post('/api/router/telemetry').set('Authorization','Bearer router-telemetry-only').send({...sample,memAvailableBytes:sample.memTotalBytes+1})).status).toBe(400);
    expect((await request(app).post('/api/router/telemetry').set('Authorization','Bearer router-telemetry-only').send(sample)).status).toBe(204);
    const health=await request(app).get('/api/router/health').set('Authorization','Bearer reader-token');
    expect(health.body.telemetry).toMatchObject({state:'reporting',uptimeSeconds:3600,cpuPercent:9,memAvailableBytes:64*1024*1024});
    expect(health.body.resource.health).toMatchObject({tunnel:{state:'available'},wanLink:{state:'unknown'},internetProbe:{state:'unknown'},cwmp:{state:'unknown'}});
    const inventory=await request(app).get('/api/resources').set('Authorization','Bearer reader-token');
    expect(inventory.body.resources.find((item:{id:string})=>item.id==='router:fiberhome')).toMatchObject({state:'reporting',observedAt:health.body.telemetry.observedAt});
  });

  it('es una lectura local que no llama al proveedor o a la PC',async()=>{
    let inventoryCalls=0;
    const adapter:Adapter={inventory:async()=>{inventoryCalls++;return[];},perform:async()=>({message:'unused'})};
    const app=setup(adapter);
    expect((await request(app).get('/api/router/health').set('Authorization','Bearer reader-token')).status).toBe(200);
    expect(inventoryCalls).toBe(0);
  });

  it('responde idempotentemente a la muestra exacta y rechaza replay modificado o generación anterior',async()=>{
    const app=setup(),post=(body:object)=>request(app).post('/api/router/telemetry').set('Authorization','Bearer router-telemetry-only').send(body);
    expect((await post(sample)).status).toBe(204);
    expect((await post(sample)).status).toBe(204);
    expect((await post({...sample,cpuPercent:99})).status).toBe(409);
    expect((await post({...sample,sequence:2})).status).toBe(204);
    expect((await post({...sample,sequence:3,bootId:'fiberhome-boot-0002'})).status).toBe(204);
    expect((await post({...sample,sequence:4,bootId:'fiberhome-boot-0001'})).status).toBe(409);
  });
});
