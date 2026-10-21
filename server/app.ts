import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { hashPassword, newSession, tokenHash, verifyPassword } from './auth.js';
import { ActiveOperationError, DeploymentBlockedError, Store, type PushPreferences } from './store.js';
import type { Adapter, Config, Operation, Resource } from './types.js';
import { InfrastructureAdapter, UncertainError } from './infrastructure.js';
import { Costs } from './costs.js';
import { mountFrontend } from './frontend.js';
import { DesktopReports } from './desktop-reports.js';
import { DesktopClient } from './desktop.js';
import { DesktopCommandChannel, CHANNEL_CAPABILITIES, type ChannelCapability, type PcSystem } from './desktop-commands.js';
import { RouterReports, type RouterTunnelProbe } from './router-reports.js';
import { MacReports } from './mac-reports.js';
import { PushService, type PushTransport } from './push.js';
import { InfrastructureMonitor } from './monitor.js';
import { HermesReports } from './hermes-reports.js';
import { timingSafeEqual } from 'node:crypto';
import { DesktopOfflineError } from './operation-error.js';

const credentials = z.object({ username: z.literal('admin'), password: z.string().min(1).max(256) }).strict();
const order = z.object({ resourceId: z.string().min(1).max(150), action: z.enum(['start', 'stop', 'refresh', 'boot-windows', 'boot-cachyos']), confirmed: z.boolean().optional() }).strict();
const bootPreference = z.object({ system: z.enum(['windows','cachyos']), confirmed: z.literal(true), expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const cancelBootPreference = z.object({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const pushSubscriptionBody=z.object({endpoint:z.string().min(1).max(2048),expirationTime:z.number().finite().nullable().optional(),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).min(43).max(200),auth:z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).min(16).max(100)}).strict()}).strict();
const pushPreferencesBody=z.object({operations:z.boolean(),devices:z.boolean(),router:z.boolean(),infrastructure:z.boolean(),budgets:z.boolean()}).strict();
export function createApp(config: Config, dbPath: string, suppliedAdapter?: Adapter, frontendRoot?: string, pushTransport?: PushTransport) {
  const app = express(), store = new Store(dbPath), costs = new Costs(config, store);
  const pushService=new PushService(store,config.push,pushTransport);
  const reports=new DesktopReports(store);
  const routerReports=new RouterReports(store,Date.now,Boolean(config.desktop?.socketPath||suppliedAdapter?.checkRouter));
  const macReports=new MacReports(store,Date.now,Boolean(config.macTelemetryTokenHash));
  const hermesReports=new HermesReports(store,config.hermes?[config.hermes.resourceId]:[]);
  const commandChannel=new DesktopCommandChannel();
  const desktop=config.desktop?.reportTokenHashes?new DesktopClient(config.desktop.socketPath,undefined,undefined,()=>reports.status(),commandChannel):undefined;
  const adapter=suppliedAdapter??new InfrastructureAdapter(config,undefined,desktop,config.routerTelemetryTokenHash?()=>routerReports.status():undefined,config.macTelemetryTokenHash?()=>macReports.status():undefined,config.hermes?()=>hermesReports.status():undefined,()=>routerReports.tunnelProbe());
  const monitor=pushService.enabled?new InfrastructureMonitor(store,adapter,costs):undefined;
  const streams=new Set<express.Response>();
  let closed = false;
  let routerCheckInFlight: Promise<RouterTunnelProbe> | undefined;
  const runRouterCheck = async (): Promise<{ probe: RouterTunnelProbe; cached: boolean }> => {
    if (!adapter.checkRouter) throw new Error('Router check is not configured');
    const cached = routerReports.tunnelProbe();
    if (cached && cached.ageSeconds < 10) return { probe: cached, cached: true };
    if (routerCheckInFlight) return { probe: await routerCheckInFlight, cached: true };
    const task = (async () => {
      const ready = (await adapter.checkRouter!()).ready === true;
      if (closed) return { state: 'unavailable', source: 'ssh-router-check', observedAt: new Date().toISOString(), freshUntil: new Date().toISOString(), ageSeconds: 0, reasonCode: 'router_check_failed' } as const;
      return routerReports.recordTunnelProbe(ready);
    })();
    routerCheckInFlight = task;
    try { return { probe: await task, cached: false }; }
    finally { if (routerCheckInFlight === task) routerCheckInFlight = undefined; }
  };
  let unsubscribeBootReconcile=()=>{};
  app.locals.commandChannel = commandChannel;
  app.locals.closeStreams = () => { for(const stream of streams)stream.end(); };
  app.locals.close = () => { closed = true; unsubscribeBootReconcile(); monitor?.close(); costs.close(); pushService.close(); for(const stream of streams)stream.end(); reports.close(); routerReports.close(); macReports.close(); hermesReports.close(); store.close(); };
  app.disable('x-powered-by');
  // Only the local Nginx proxy reaches the loopback-bound published port.
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.origin.startsWith('https:') ? [] : null } } }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready',(_req,res)=>{
    try{store.db.prepare('SELECT 1 AS ready').get();res.json({status:'ready',storage:'available'});}
    catch{res.status(503).json({status:'not_ready',storage:'unavailable'});}
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiadas solicitudes. Espera un minuto.' } }));
  app.use(express.json({ limit: '4kb' })); app.use(cookieParser());
  // Bearer clients do not rely on ambient cookies. Every cookie-authenticated
  // mutation, including login, requires an exact same-origin header.
  app.use('/api', (req, res, next) => {
    const bearer = req.headers.authorization?.startsWith('Bearer ');
    if (req.method !== 'GET' && req.method !== 'HEAD' && (!bearer || req.path.startsWith('/auth/')) && req.get('Origin') !== config.origin) {
      res.status(403).json({ error: 'Origen de solicitud no permitido.' }); return;
    }
    next();
  });
  const reportBody=z.object({bootId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),sequence:z.number().int().positive().max(2147483647),event:z.enum(['online','heartbeat','poweroff','reboot','stopping'])}).strict();
  const routerTelemetryBody=z.object({version:z.literal(1),bootId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),streamId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),sequence:z.number().int().positive().max(2147483647),uptimeSeconds:z.number().finite().min(0).max(1e12),cpuPercent:z.number().finite().min(0).max(100).nullable(),memTotalBytes:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),memAvailableBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict().superRefine((value,context)=>{if(value.memAvailableBytes>value.memTotalBytes)context.addIssue({code:'custom',path:['memAvailableBytes'],message:'Memory availability exceeds total'});});
  const macReportBody=z.object({bootId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),sequence:z.number().int().positive().max(2147483647),event:z.enum(['online','heartbeat','sleep','wake'])}).strict();
  const hermesTelemetryBody=z.object({version:z.literal(1),bootId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),streamId:z.string().regex(/^[a-zA-Z0-9:._+-]{8,100}$/),sequence:z.number().int().positive().max(2147483647),serviceState:z.enum(['active','inactive','failed','unknown']),restartCount:z.number().int().min(0).max(2147483647)}).strict();
  app.post('/api/hermes/events',rateLimit({windowMs:60000,limit:30,message:{error:'Hermes envió demasiadas muestras. Espera un minuto.'}}),(req,res)=>{
    const expected=config.hermes?.reportTokenHash;
    if(!expected||!config.hermes?.resourceId){res.status(503).json({error:'Reporter de Hermes no configurado.'});return;}
    const raw=req.get('Authorization'),hash=raw?.startsWith('Bearer ')?tokenHash(raw.slice(7)):'';
    if(hash.length!==expected.length||!timingSafeEqual(Buffer.from(hash),Buffer.from(expected))){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const body=hermesTelemetryBody.safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Telemetría de Hermes no válida.'});return;}
    if(!hermesReports.accept(body.data)){res.status(409).json({error:'Muestra repetida alterada o anterior al arranque actual.'});return;}
    res.status(204).end();
  });
  app.post('/api/router/telemetry',(req,res)=>{
    const expected=config.routerTelemetryTokenHash;
    if(!expected){res.status(503).json({error:'Telemetría del router no configurada.'});return;}
    const raw=req.get('Authorization'),hash=raw?.startsWith('Bearer ')?tokenHash(raw.slice(7)):'';
    if(hash.length!==expected.length||!timingSafeEqual(Buffer.from(hash),Buffer.from(expected))){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const body=routerTelemetryBody.safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Telemetría no válida.'});return;}
    if(!routerReports.accept(body.data)){res.status(409).json({error:'Muestra repetida o anterior a la generación actual.'});return;}
    res.status(204).end();
  });
  app.post('/api/mac/events',(req,res)=>{
    const expected=config.macTelemetryTokenHash;
    if(!expected){res.status(503).json({error:'Reporter del Mac no configurado.'});return;}
    const raw=req.get('Authorization'),hash=raw?.startsWith('Bearer ')?tokenHash(raw.slice(7)):'';
    if(hash.length!==expected.length||!timingSafeEqual(Buffer.from(hash),Buffer.from(expected))){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const body=macReportBody.safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Aviso no válido.'});return;}
    if(!macReports.accept(body.data)){res.status(409).json({error:'Secuencia o arranque anterior.'});return;}
    res.status(204).end();
  });
  // Cada sistema de la PC tiene su propio token; el mismo token autoriza sus avisos y su canal de órdenes, nada más.
  const desktopOsFor=(req:express.Request):PcSystem|undefined=>{
    const raw=req.get('Authorization');
    const hash=raw?.startsWith('Bearer ')?tokenHash(raw.slice(7)):'';
    return (['windows','cachyos'] as const).find(os=>{
      const expected=config.desktop?.reportTokenHashes?.[os];
      return expected&&hash.length===expected.length&&timingSafeEqual(Buffer.from(hash),Buffer.from(expected));
    });
  };
  const recordChannel=()=>{
    try{store.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('desktop-channel',?)").run(JSON.stringify({at:new Date().toISOString(),windows:commandChannel.snapshot('windows'),cachyos:commandChannel.snapshot('cachyos')}));}catch{/* Diagnóstico: nunca afecta al canal. */}
  };
  const channelAck=z.object({accepted:z.boolean(),bootId:z.string().max(100)}).strict();
  app.get('/api/desktop/commands',async(req,res)=>{
    const os=desktopOsFor(req);
    if(!os){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const caps=new Set(String(req.query.caps??'').split(',').filter((c):c is ChannelCapability=>(CHANNEL_CAPABILITIES as readonly string[]).includes(c)));
    const waitSeconds=Math.min(25,Math.max(0,Number(req.query.wait)||0));
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    const wasConnected=commandChannel.connected(os);
    const pending=commandChannel.poll(os,caps,waitSeconds*1000,controller.signal);
    // Al (re)conectar, un ping mide la latencia real del canal sin tocar la PC.
    if(!wasConnected&&caps.has('ping'))void commandChannel.send(os,'ping','').then(recordChannel);
    const command=await pending;
    res.set('Cache-Control','no-store');
    if(!command){res.status(204).end();return;}
    res.json(command);
  });
  app.post('/api/desktop/commands/:id/ack',(req,res)=>{
    const os=desktopOsFor(req);
    if(!os){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const body=channelAck.safeParse(req.body);
    if(!body.success||!/^[0-9a-f-]{36}$/.test(req.params.id)){res.status(400).json({error:'Confirmación no válida.'});return;}
    if(!commandChannel.ack(os,req.params.id,body.data)){res.status(409).json({error:'La orden ya no está vigente.'});return;}
    res.status(204).end();
  });
  app.post('/api/desktop/events', (req,res)=>{
    const os=desktopOsFor(req);
    if(!os){res.status(401).json({error:'Dispositivo no autorizado.'});return;}
    const body=reportBody.safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Aviso no válido.'});return;}
    if(!reports.accept(os,body.data)){res.status(409).json({error:'Aviso anterior al estado actual.'});return;}
    res.status(204).end();
  });
  const passwordHash = () => (store.db.prepare("SELECT value FROM settings WHERE key='password'").get() as { value: string } | undefined)?.value ?? config.passwordHash;
  let bootReconcileRunning=false;
  let lastBootReconcileAttemptAt=0;
  const reconcilePendingBootPreference=async()=>{
    if(closed||bootReconcileRunning)return;
    if(store.desktopBootPreference().state!=='pending'||Date.now()-lastBootReconcileAttemptAt<60000)return;
    lastBootReconcileAttemptAt=Date.now();
    bootReconcileRunning=true;
    try{
      const pending=store.claimPendingDesktopBootPreference();
      if(!pending?.operationKey||!pending.desired)return;
      if(!adapter.readBootDefault||!adapter.setBootDefault){
        if(!closed)store.finishDesktopBootPreference(pending.operationKey,'failed','El controlador no puede verificar la capacidad UEFI. No se envió ningún cambio.');
        return;
      }
      try{
        const observed=await adapter.readBootDefault();
        if(!closed)store.observeDesktopBootDefault(observed.defaultSystem,observed.observedAt);
      }catch(error){
        if(closed)return;
        if(error instanceof DesktopOfflineError){
          store.finishDesktopBootPreference(pending.operationKey,'pending','La PC aún no está disponible para verificar UEFI. La intención queda pendiente; no se envió ningún cambio.');
        }else{
          store.finishDesktopBootPreference(pending.operationKey,'failed','La PC respondió, pero no se pudo verificar la capacidad UEFI. No se envió ningún cambio.');
        }
        return;
      }
      try{
        const result=await adapter.setBootDefault(pending.desired);
        if(!closed)store.finishDesktopBootPreference(pending.operationKey,'applied',`El firmware verificó ${result.defaultSystem==='windows'?'Windows':'CachyOS'} como predeterminado. La PC no se reinició.`,result.verifiedAt);
      }catch(error){
        if(closed)return;
        const state=error instanceof DesktopOfflineError?'pending':'uncertain';
        const message=state==='pending'
          ? 'La PC reportó el arranque, pero todavía no hay identidad SSH autenticada. La intención queda pendiente; no se enviaron órdenes.'
          : 'La respuesta al aplicar el arranque no pudo verificarse. Comprueba el valor UEFI antes de repetir; la PC no se reinició.';
        store.finishDesktopBootPreference(pending.operationKey,state,message);
      }
    }finally{bootReconcileRunning=false;}
  };
  unsubscribeBootReconcile=reports.subscribeAccepted((_os,event)=>{
    if(event.event==='online'||event.event==='heartbeat')void reconcilePendingBootPreference();
  });
  if(reports.status().phase==='running')void reconcilePendingBootPreference();
  app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60000, limit: 5, skipSuccessfulRequests: true, message: { error: 'Espera 15 minutos antes de volver a intentar.' } }), async (req, res) => {
    const data = credentials.safeParse(req.body);
    // Perform the password derivation for invalid usernames as well.
    const validPassword = await verifyPassword(typeof req.body?.password === 'string' && req.body.password.length <= 256 ? req.body.password : '', passwordHash());
    if (!data.success || !validPassword) { res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); return; }
    const session = newSession(); store.addSession(tokenHash(session));
    res.cookie('__Host-infra', session, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 7 * 86400000 });
    res.json({ name: 'Admin' });
  });
  app.use('/api', (req, res, next) => {
    const authorization = req.get('Authorization');
    if (authorization) {
      const hash = tokenHash(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
      const agent = config.agentTokens.find(token => token.hash === hash);
      if (!agent) { res.status(401).json({ error: 'Token no válido.' }); return; }
      res.locals.actor = agent.name; res.locals.scopes = agent.scopes; res.locals.agent = true;
    } else if (typeof req.cookies['__Host-infra'] === 'string' && store.session(tokenHash(req.cookies['__Host-infra']))) {
      res.locals.actor = 'Admin'; res.locals.scopes = ['read', 'operate']; res.locals.agent = false;
    } else { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return; }
    if (!res.locals.scopes.includes('read') || (req.method !== 'GET' && !res.locals.scopes.includes('operate'))) { res.status(403).json({ error: 'Tu token no permite esta operación.' }); return; }
    next();
  });
  const humanOnly=(req:express.Request,res:express.Response,next:express.NextFunction)=>{
    if(res.locals.agent){res.status(403).json({error:'La gestión de avisos pertenece a una sesión personal.'});return;}
    next();
  };
  app.get('/api/push/config',(_req,res)=>res.json({enabled:pushService.enabled,vapidPublicKey:pushService.publicKey}));
  app.get('/api/push/status',humanOnly,(_req,res)=>res.json(pushService.readiness()));
  app.get('/api/push/subscriptions',humanOnly,(_req,res)=>res.json({subscriptions:pushService.list()}));
  app.get('/api/system/health',(_req,res)=>res.json({panel:{state:'healthy',observedAt:new Date().toISOString()},push:pushService.readiness(),cloud:monitor?.status()??{enabled:false,state:'disabled',intervalSeconds:300,lastAttemptAt:null,lastCompletedAt:null,consecutiveFailures:0,resourcesObserved:0,unknownResources:0},router:routerReports.status()??null,mac:macReports.status()??null,desktop:reports.status(),desktopChannel:{windows:commandChannel.snapshot('windows'),cachyos:commandChannel.snapshot('cachyos')},hermes:hermesReports.status()??null}));
  app.post('/api/push/subscriptions',humanOnly,rateLimit({windowMs:60000,limit:5,message:{error:'Espera antes de volver a registrar un dispositivo.'}}),(req,res)=>{
    const parsed=pushSubscriptionBody.safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'Suscripción Push no válida.'});return;}
    try{const registered=pushService.register(parsed.data);monitor?.wake();res.status(201).json(registered);}
    catch(error){
      if(error instanceof Error&&error.message==='Web Push is not configured'){res.status(503).json({error:'Web Push todavía no está configurado en el servidor.'});return;}
      if(error instanceof Error&&error.message==='Push subscription limit reached'){res.status(409).json({error:'Se alcanzó el límite de dispositivos con avisos activos.'});return;}
      res.status(400).json({error:'El proveedor de avisos o sus claves no son válidos.'});
    }
  });
  app.put('/api/push/subscriptions/:id/preferences',humanOnly,(req,res)=>{
    const id=z.string().uuid().safeParse(req.params.id),preferences=pushPreferencesBody.safeParse(req.body);
    if(!id.success||!preferences.success){res.status(400).json({error:'Identificador o preferencias no válidas.'});return;}
    if(!pushService.updatePreferences(id.data,preferences.data as PushPreferences)){res.status(404).json({error:'Dispositivo no encontrado.'});return;}
    res.json({id:id.data,preferences:preferences.data});
  });
  app.post('/api/push/subscriptions/:id/test',humanOnly,rateLimit({windowMs:60000,limit:1,message:{error:'Espera un minuto antes de enviar otra prueba de aviso.'}}),(req,res)=>{
    const id=z.string().uuid().safeParse(req.params.id);
    if(!id.success){res.status(400).json({error:'Identificador no válido.'});return;}
    try{
      if(!pushService.testDevice(id.data)){res.status(404).json({error:'Dispositivo con avisos no encontrado.'});return;}
      res.status(202).json({queued:true,expiresInSeconds:60,message:'Prueba en cola; esta respuesta no confirma que el sistema operativo la haya mostrado.'});
    }catch(error){
      if(error instanceof Error&&error.message==='Web Push is not configured'){res.status(503).json({error:'Web Push todavía no está configurado en el servidor.'});return;}
      res.status(503).json({error:'No se pudo preparar la prueba de avisos.'});
    }
  });
  app.delete('/api/push/subscriptions/:id',humanOnly,(req,res)=>{
    const id=z.string().uuid().safeParse(req.params.id);
    if(!id.success){res.status(400).json({error:'Identificador no válido.'});return;}
    if(!pushService.remove(id.data)){res.status(404).json({error:'Dispositivo no encontrado.'});return;}
    res.status(204).end();
  });
  monitor?.start();
  pushService.start();
  app.get('/api/auth/me', (_req, res) => res.json({ name: res.locals.actor, agent: res.locals.agent, scopes: res.locals.scopes }));
  app.get('/api/router/health',(_req,res)=>res.json({resource:routerReports.resource(),telemetry:routerReports.status()??null,probe:routerReports.tunnelProbe()??null,fetchedAt:new Date().toISOString()}));
  app.post('/api/router/check',rateLimit({windowMs:60000,limit:6,message:{error:'Espera antes de volver a comprobar el túnel del FiberHome.'}}),async(_req,res)=>{
    if(!adapter.checkRouter){res.status(503).json({error:'El sondeo privado del FiberHome no está configurado.'});return;}
    let result:{probe:RouterTunnelProbe;cached:boolean};
    try{result=await runRouterCheck();}
    catch{
      res.status(503).json({error:'No se pudo consultar el broker privado del FiberHome. El estado del túnel no se ha actualizado.'});
      return;
    }
    const {probe,cached}=result;
    res.json({
      probe,resource:routerReports.resource(),cached,fetchedAt:new Date().toISOString(),
      message:probe.state==='available'
        ? 'El FiberHome respondió por el túnel privado. Esta comprobación no mide WAN ni acceso a Internet.'
        : 'El túnel privado no respondió. Esto no confirma que el router esté apagado ni una caída de Internet.'
    });
  });
  app.get('/api/mac/health',(_req,res)=>res.json({resource:macReports.resource(),telemetry:macReports.status()??null,fetchedAt:new Date().toISOString()}));
  app.get('/api/hermes/health',(_req,res)=>res.json({telemetry:hermesReports.status()??null,fetchedAt:new Date().toISOString()}));
  app.get('/api/events',(req,res)=>{
    if(streams.size>=50){res.set('Retry-After','15').status(503).end();return;}
    const rawCursor=req.get('Last-Event-ID')??(typeof req.query.cursor==='string'?req.query.cursor:undefined);
    if(rawCursor!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(rawCursor)||!Number.isSafeInteger(Number(rawCursor)))){res.status(400).json({error:'Cursor de eventos no válido.'});return;}
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','Connection':'keep-alive'});
    res.flushHeaders();res.write('retry: 5000\n\n');streams.add(res);
    const valid=()=>{
      if(closed||res.destroyed)return false;
      const token=req.get('Authorization');
      if(token){const hash=tokenHash(token.startsWith('Bearer ')?token.slice(7):'');return config.agentTokens.some(agent=>agent.scopes.includes('read')&&agent.hash.length===hash.length&&timingSafeEqual(Buffer.from(agent.hash),Buffer.from(hash)));}
      return typeof req.cookies['__Host-infra']==='string'&&!!store.session(tokenHash(req.cookies['__Host-infra']));
    };
    let cursor=rawCursor===undefined?store.latestEventId():Number(rawCursor),initializing=true,draining=false,needsDrain=false;
    let unsubscribe=()=>{};
    const end=()=>{if(!res.writableEnded)res.end();};
    const send=(id:number|undefined,event:string,payload:unknown)=>{
      if(!valid()){end();return false;}
      if(res.writableLength>65536){end();return false;}
      res.write(`${id===undefined?'':`id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    };
    const sendDesktopSnapshot=async(id:number)=>{if(desktop&&valid())try{send(id,'desktop',await desktop.resource());}catch{/* The durable event log remains available for replay. */}};
    const resync=async()=>{const latest=store.latestEventId();cursor=latest;send(latest,'resync',{cursor:latest,reason:'event-history-unavailable',snapshotRequired:true});await sendDesktopSnapshot(latest);};
    let drain=()=>{};
    drain=()=>{
      if(initializing||draining||closed||res.destroyed){needsDrain=true;return;}
      draining=true;needsDrain=false;
      try{
        if(!valid()){end();return;}
        const bounds=store.eventBounds();
        if(cursor>bounds.latest||(bounds.first!==null&&cursor<bounds.first-1)||store.countEventsAfter(cursor)>250){
          initializing=true;void resync().finally(()=>{initializing=false;if(needsDrain)drain();});return;
        }
        for(const item of store.eventsAfter(cursor,250)){if(!send(item.id,item.type,item.payload))return;cursor=item.id;}
      }finally{draining=false;}
      if(needsDrain){needsDrain=false;drain();}
    };
    unsubscribe=store.subscribeEvents(()=>{needsDrain=true;drain();});
    if(rawCursor===undefined){
      send(undefined,'ready',{cursor});
      void sendDesktopSnapshot(cursor).finally(()=>{initializing=false;if(needsDrain)drain();});
    }else{drain();initializing=false;if(needsDrain){needsDrain=false;drain();}}
    const timer=setInterval(()=>{
      if(!valid()){res.end();return;}
      if(res.writableLength>65536){res.end();return;}
      res.write(': keepalive\n\n');
    },15000);timer.unref();
    res.on('close',()=>{clearInterval(timer);unsubscribe();streams.delete(res);});
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies['__Host-infra']) store.deleteSession(tokenHash(req.cookies['__Host-infra']));
    for(const stream of streams)stream.end();
    res.clearCookie('__Host-infra', { secure: true, httpOnly: true, sameSite: 'strict', path: '/' }); res.json({ ok: true });
  });
  app.post('/api/auth/password', rateLimit({ windowMs: 15 * 60000, limit: 5, message: { error: 'Demasiados intentos. Espera 15 minutos.' } }), async (req, res) => {
    if (res.locals.agent) { res.status(403).json({ error: 'Cambia la contraseña desde tu sesión personal.' }); return; }
    const data = z.object({ current: z.string().max(256), password: z.string().min(16).max(256) }).strict().safeParse(req.body);
    if (!data.success) { res.status(400).json({ error: 'La nueva contraseña debe tener al menos 16 caracteres.' }); return; }
    if (!await verifyPassword(data.data.current, passwordHash())) { res.status(401).json({ error: 'Contraseña actual incorrecta.' }); return; }
    store.db.prepare("INSERT OR REPLACE INTO settings VALUES ('password',?)").run(await hashPassword(data.data.password));
    store.db.exec('DELETE FROM sessions');
    for(const stream of streams)stream.end();
    res.clearCookie('__Host-infra', { secure: true, httpOnly: true, sameSite: 'strict', path: '/' }); res.json({ ok: true });
  });
  app.get('/api/resources', async (_req, res) => { const cursor=store.latestEventId();res.json({ resources: await adapter.inventory(), fetchedAt: new Date().toISOString(), refreshSeconds: 60, cursor }); });
  app.get('/api/desktop/boot-preference', (_req,res) => {
    const {operationKey: _privateKey,...preference}=store.desktopBootPreference();
    res.json(preference);
  });
  app.get('/api/desktop/boot-preference/verify',async(_req,res)=>{
    if(!adapter.readBootDefault){res.status(503).json({error:'La lectura verificada del firmware no está configurada.'});return;}
    if(store.busy('computer:desktop')){res.status(409).json({error:'Espera a que termine la operación actual de la PC antes de leer el firmware.'});return;}
    const before=store.desktopBootPreference();
    try{
      const observed=await adapter.readBootDefault();
      const current=store.desktopBootPreference();
      if(current.version!==before.version||current.state!==before.state||current.effective!==before.effective||current.observedAt!==before.observedAt||store.busy('computer:desktop')){
        res.status(409).json({error:'El estado del arranque cambió mientras se leía el firmware. Actualiza el estado antes de volver a verificar.'});return;
      }
      const {operationKey:_privateKey,...preference}=store.observeDesktopBootDefault(observed.defaultSystem,observed.observedAt);
      res.json(preference);
    }catch(error){
      if(error instanceof DesktopOfflineError){res.status(503).json({error:'La PC no está disponible para confirmar el orden UEFI.'});return;}
      res.status(503).json({error:'No se pudo leer y verificar el orden UEFI. No se modificó el arranque.'});
    }
  });
  app.post('/api/desktop/boot-preference',rateLimit({windowMs:60000,limit:3,message:{error:'Espera antes de volver a cambiar el arranque predeterminado.'}}),async(req,res)=>{
    const parsed=bootPreference.safeParse(req.body),key=req.get('Idempotency-Key');
    if(!parsed.success||!key||!/^[a-zA-Z0-9_-]{1,100}$/.test(key)){res.status(400).json({error:'Elige Windows o CachyOS, confirma la acción, envía expectedVersion e incluye Idempotency-Key.'});return;}
    const previous=store.desktopBootPreference();
    const replay=previous.operationKey===key||previous.state==='applied'&&previous.desired===parsed.data.system&&previous.effective===parsed.data.system;
    if(!replay){
      if(store.busy('computer:desktop')){res.status(409).json({error:'Ya hay otra operación de la PC en curso.'});return;}
      if(!adapter.readBootDefault||!adapter.setBootDefault){res.status(503).json({error:'El controlador no confirma el helper UEFI del PC. No se registró ni envió ningún cambio.'});return;}
      try{
        const observed=await adapter.readBootDefault();
        store.observeDesktopBootDefault(observed.defaultSystem,observed.observedAt);
      }
      catch(error){if(!(error instanceof DesktopOfflineError)){res.status(503).json({error:'No se pudo verificar el helper UEFI del PC. No se registró ni envió ningún cambio.'});return;}}
    }
    let record,started;
    try{({record,started}=store.beginDesktopBootPreferenceOnce(key,parsed.data.system,parsed.data.expectedVersion));}
    catch(error){
      if(error instanceof DeploymentBlockedError){res.set('Retry-After','15').status(503).json({error:'El panel está preparando un despliegue. Intenta de nuevo en unos segundos.'});return;}
      if(error instanceof ActiveOperationError){res.status(409).json({error:'Ya hay otra operación de la PC en curso.'});return;}
      if(error instanceof Error&&error.message==='Boot preference idempotency conflict'){res.status(409).json({error:'La clave ya corresponde a otro sistema predeterminado.'});return;}
      if(error instanceof Error&&error.message==='Boot preference version conflict'){res.status(409).json({error:'La preferencia cambió desde la última lectura. Actualiza el estado antes de volver a elegir.'});return;}
      throw error;
    }
    if(!started||record.state!=='applying'){const {operationKey:_privateKey,...publicRecord}=record;res.status(record.state==='applied'?200:record.state==='failed'?409:202).json(publicRecord);return;}
    if(!adapter.setBootDefault){const failed=store.finishDesktopBootPreference(key,'failed','El controlador fijo del PC no tiene esta capacidad instalada.');const {operationKey:_privateKey,...publicRecord}=failed;res.status(503).json(publicRecord);return;}
    try{
      const result=await adapter.setBootDefault(parsed.data.system);
      const done=store.finishDesktopBootPreference(key,'applied',`Firmware verificó ${result.defaultSystem==='windows'?'Windows':'CachyOS'} como predeterminado. La PC no se reinició.`,result.verifiedAt);
      const {operationKey:_privateKey,...publicRecord}=done;res.json(publicRecord);
    }catch(error){
      const state=error instanceof DesktopOfflineError?'pending':'uncertain';
      const message=state==='pending'
        ? 'La preferencia quedó pendiente. Se aplicará cuando la PC vuelva a reportar y se autentique; no se encendió ni reinició.'
        : 'No se confirmó la respuesta del controlador. Comprueba la preferencia efectiva antes de repetir; no se ordenó un reinicio.';
      const result=store.finishDesktopBootPreference(key,state,message);
      const {operationKey:_privateKey,...publicRecord}=result;res.status(202).json(publicRecord);
    }
  });
  app.delete('/api/desktop/boot-preference/pending',(req,res)=>{
    const parsed=cancelBootPreference.safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'Incluye la versión actual de la preferencia.'});return;}
    try{
      const {operationKey:_privateKey,...publicRecord}=store.cancelPendingDesktopBootPreference(parsed.data.expectedVersion);
      res.json(publicRecord);
    }catch(error){
      if(error instanceof Error&&error.message==='Boot preference version conflict'){res.status(409).json({error:'La preferencia cambió desde la última lectura. Actualiza el estado antes de cancelar.'});return;}
      if(error instanceof Error&&error.message==='Boot preference is not pending'){res.status(409).json({error:'No hay una preferencia pendiente para cancelar.'});return;}
      throw error;
    }
  });
  app.get('/api/costs', async (_req, res) => { res.json(await costs.get()); });
  app.get('/api/operations', (_req, res) => res.json({ operations: store.list() }));
  app.get('/api/operations/:id', (req, res) => { const op = store.get(req.params.id); if (!op) { res.status(404).json({ error: 'Operación no encontrada.' }); return; } res.json(op); });
  app.get('/api/operations/:id/history', (req, res) => { const op=store.get(req.params.id);if(!op){res.status(404).json({error:'Operación no encontrada.'});return;}res.json({events:store.operationHistory(op.id)}); });
  app.post('/api/operations', rateLimit({ windowMs: 60000, limit: 10, message: { error: 'Límite de operaciones alcanzado. Espera un minuto.' } }), async (req, res) => {
    const parsed = order.safeParse(req.body), key = req.get('Idempotency-Key');
    if (!parsed.success || !key || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) { res.status(400).json({ error: 'Orden no válida. Incluye Idempotency-Key.' }); return; }
    const { resourceId, action, confirmed } = parsed.data;
    if (action !== 'refresh' && !confirmed) { res.status(400).json({ error: 'Confirma expresamente la acción sobre este equipo.' }); return; }
    const fingerprint = JSON.stringify({ resourceId, action });
    let existing = store.existing(res.locals.actor, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) { res.status(409).json({ error: 'La clave ya corresponde a otra orden.' }); return; }
      res.status(202).json(store.get(existing.id)); return;
    }
    const fastRouterCheck = resourceId === 'router:fiberhome' && action === 'refresh' && Boolean(adapter.checkRouter);
    const resource: Resource | undefined = fastRouterCheck
      ? { ...routerReports.resource(), actions: ['refresh'] }
      : (await adapter.inventory()).find(item => item.id === resourceId);
    if (!resource || !resource.actions.includes(action)) { res.status(400).json({ error: 'Acción no disponible para este equipo en su estado actual.' }); return; }
    existing = store.existing(res.locals.actor, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) { res.status(409).json({ error: 'La clave ya corresponde a otra orden.' }); return; }
      res.status(202).json(store.get(existing.id)); return;
    }
    // These checks and insert are synchronous: requests cannot interleave here.
    if (store.busy(resourceId)) { res.status(409).json({ error: 'Ya hay una operación en curso para este equipo.' }); return; }
    let op:Operation;
    try{op=store.create(res.locals.actor,key,fingerprint,resource,action);}
    catch(error){
      if(error instanceof DeploymentBlockedError){res.set('Retry-After','15').status(503).json({error:'El panel está preparando un despliegue. Intenta de nuevo en unos segundos.'});return;}
      if(error instanceof ActiveOperationError){res.status(409).json({error:'Ya hay una operación en curso para este equipo.'});return;}
      throw error;
    }
    res.status(202).json(op);
    store.update(op.id, 'running', 'Ejecutando y comprobando el resultado…');
    const perform = fastRouterCheck && adapter.checkRouter
      ? async () => {
          const { probe } = await runRouterCheck();
          return { message: probe.state === 'available'
            ? 'El FiberHome respondió por el túnel privado. La telemetría y CWMP conservan su propia fecha; WAN e Internet no se midieron.'
            : 'El túnel privado no respondió. Esto no confirma que el router esté apagado ni una caída de Internet.' };
        }
      : () => adapter.perform(resource, action, message => {
      if (closed) return;
      try { store.update(op.id, 'running', message); }
      catch { /* Progress history is best-effort and cannot interrupt a hardware action. */ }
    });
    void perform().then(result => {
      if (!closed) store.update(op.id, 'succeeded', result.message);
    }).catch((error: unknown) => {
      if (!closed) store.update(op.id, error instanceof UncertainError ? 'uncertain' : 'failed', error instanceof UncertainError ? error.message : 'El proveedor no pudo completar o verificar la operación. Comprueba el equipo antes de repetir.');
    });
  });
  app.get('/api/openapi.json', (_req, res) => res.json({
    openapi: '3.1.0', info: { title: 'Infra Control', version: '0.1.0', description: 'API privada compartida por PWA y agentes. Operaciones asíncronas e idempotentes. Nunca asumir éxito por HTTP 202.' },
    servers: [{ url: config.origin }], security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/api/events': { get: { summary: 'SSE autenticado con historial durable, sin polling por cliente', parameters: [{ in: 'header', name: 'Last-Event-ID', schema: { type: 'integer', minimum: 0 } }, { in: 'query', name: 'cursor', schema: { type: 'integer', minimum: 0 }, description: 'Cursor inicial obtenido de GET /api/resources; Last-Event-ID tiene precedencia.' }], responses: { '200': { description: 'Eventos desktop/resource/operation/incident; resync indica cursor fuera de ventana y exige una nueva snapshot.' }, '400': { description: 'Cursor inválido' }, '503': { description: 'Límite de conexiones' } } } },
      '/api/desktop/events': { post: { summary: 'Avisos salientes del PC; requiere token exclusivo del SO, sin permisos de lectura u operación', responses: { '204': { description: 'Aviso aceptado' }, '400': { description: 'bootId, sequence o event inválido' }, '401': { description: 'Dispositivo no autorizado' }, '409': { description: 'Secuencia o arranque anterior' } } } },
      '/api/desktop/commands': { get: { summary: 'Canal de órdenes iniciado por la PC (long-poll hasta 25 s): 200 con una orden de la lista cerrada, 204 si no hay; token exclusivo del SO', security: [], parameters: [{ in: 'query', name: 'wait', schema: { type: 'integer', minimum: 0, maximum: 25 } }, { in: 'query', name: 'caps', schema: { type: 'string', description: 'Capacidades que el agente sabe ejecutar: ping, power, boot-default' } }], responses: { '200': { description: 'Orden {id, command, expectedBootId, issuedAt}' }, '204': { description: 'Sin órdenes' }, '401': { description: 'Dispositivo no autorizado' } } } },
      '/api/desktop/commands/{id}/ack': { post: { summary: 'Confirmación o rechazo de una orden entregada; el bootId debe coincidir con el esperado', security: [], responses: { '204': { description: 'Confirmación aceptada' }, '400': { description: 'Confirmación no válida' }, '401': { description: 'Dispositivo no autorizado' }, '409': { description: 'La orden ya no está vigente o el bootId no coincide' } } } },
      '/api/mac/events': { post: { summary: 'Reporter saliente de presencia y avisos best-effort de reposo/despertar del Mac; token exclusivo, sin permiso de lectura ni operación', security: [], responses: { '204': { description: 'Aviso aceptado o repetición exacta' }, '400': { description: 'Aviso inválido' }, '401': { description: 'Token exclusivo inválido' }, '409': { description: 'Secuencia o bootId anterior' }, '503': { description: 'Reporter no configurado' } } } },
      '/api/mac/health': { get: { summary: 'Snapshot local de presencia del Mac; no hace SSH al dispositivo', responses: { '200': { description: 'resource, telemetría reciente o null, fetchedAt; presencia stale tras 90 s' } } } },
      '/api/hermes/events': { post: { summary: 'Heartbeat saliente del estado systemd; token exclusivo, sin acceso a chats ni órdenes', security: [], responses: { '204': { description: 'Muestra aceptada' }, '400': { description: 'Muestra fuera del contrato' }, '401': { description: 'Token exclusivo inválido' }, '409': { description: 'Secuencia anterior o stream retirado' }, '503': { description: 'Reporter no configurado' } } } },
      '/api/hermes/health': { get: { summary: 'Última observación systemd de Hermes; no consulta la instancia EC2', responses: { '200': { description: 'telemetry con estado de unidad y vencimiento a 45 s, o null' } } } },
      '/api/system/health': { get: { summary: 'Estado de observadores, panel y cola de avisos; sin sondeos adicionales por cliente', responses: { '200': { description: 'panel, push, cloud, router, Mac, PC y Hermes' } } } },
      '/api/router/check': { post: { summary: 'Comprueba una vez el túnel privado del FiberHome; compartido durante 10 s y sin consultar PC, ACS, WAN o Internet', responses: { '200': { description: 'probe, resource y cached; una respuesta negativa no significa router apagado ni Internet caído' }, '401': { description: 'Autenticación requerida' }, '429': { description: 'Máximo seis comprobaciones por minuto' }, '503': { description: 'Sondeo no configurado o broker local inaccesible; no se altera el estado observado del túnel' } } } },
      '/api/push/config': { get: { summary: 'Clave VAPID pública y disponibilidad; no revela credenciales', security: [], responses: { '200': { description: 'enabled, vapidPublicKey' } } } },
      '/api/push/status': { get: { summary: 'Estado de la cola y número de suscripciones de la sesión humana', responses: { '200': { description: 'enabled, subscriptions, pending, dead' } } } },
      '/api/push/subscriptions': { get: { summary: 'Suscripciones de la sesión humana sin incluir endpoints ni claves', responses: { '200': { description: 'subscriptions y preferencias' } } }, post: { summary: 'Registrar suscripción validada de navegador para esta cuenta', responses: { '201': { description: 'Dispositivo registrado; endpoints se cifran en SQLite' }, '400': { description: 'Suscripción o proveedor no permitido' }, '403': { description: 'La gestión requiere sesión humana y mismo origen' }, '409': { description: 'Límite de dispositivos alcanzado' }, '503': { description: 'VAPID no configurado' } } } },
      '/api/push/subscriptions/{id}/preferences': { put: { summary: 'Actualizar preferencias solo del dispositivo de la sesión humana', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Preferencias guardadas' }, '404': { description: 'Dispositivo no encontrado' } } } },
      '/api/push/subscriptions/{id}/test': { post: { summary: 'Encolar una prueba no sensible para este dispositivo; no confirma recepción', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '202': { description: 'Encolada con TTL de60s; comprobar el dispositivo' }, '403': { description: 'Solo sesión humana' }, '404': { description: 'Dispositivo no encontrado' }, '429': { description: 'Una prueba por minuto' }, '503': { description: 'VAPID no configurado' } } } },
      '/api/push/subscriptions/{id}': { delete: { summary: 'Revocar suscripción y eliminar su cola asociada', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '204': { description: 'Revocada' }, '404': { description: 'Dispositivo no encontrado' } } } },
      '/api/desktop/boot-preference': { get: { summary: 'Preferencia física deseada y último valor UEFI observado; lee SQLite', responses: { '200': { description: 'desired, effective, state, version, requestedAt, observedAt, verifiedAt' } } }, post: { summary: 'Cambiar el default UEFI sin encender ni reiniciar; si la PC no responde queda pendiente', parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['system','confirmed','expectedVersion'], properties: { system: { enum: ['windows','cachyos'] }, confirmed: { const: true }, expectedVersion: { type: 'integer', minimum: 0 } } } } } }, responses: { '200': { description: 'Default aplicado y leído de vuelta desde el firmware' }, '202': { description: 'Intención pendiente u operación incierta; revisar antes de reintentar' }, '400': { description: 'Sistema, confirmación, versión o clave no válida' }, '409': { description: 'Versión vencida, operación PC activa o replay de una operación UEFI fallida' }, '503': { description: 'Compuerta activa o controlador sin capacidad' } } } },
      '/api/desktop/boot-preference/pending': { delete: { summary: 'Cancelar una intención pendiente antes de aplicarla', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 0 } } } } } }, responses: { '200': { description: 'Intención cancelada' }, '400': { description: 'Versión inválida' }, '409': { description: 'No está pendiente o la versión cambió' } } } },
      '/api/desktop/boot-preference/verify': { get: { summary: 'Leer el orden UEFI actual por SSH autenticado; no escribe ni corrige drift', responses: { '200': { description: 'Último default físico leído y estado comparado con desired' }, '409': { description: 'Operación PC activa o estado cambiado durante la lectura' }, '503': { description: 'PC/controlador no disponible o lectura no verificable' } } } },
      '/api/router/health': { get: { summary: 'Snapshot local de salud del FiberHome; no consulta ACS, router ni PC', responses: { '200': { description: 'resource, última telemetría, último probe SSH fresco o null, fetchedAt' }, '401': { description: 'Autenticación requerida' } } } },
      '/api/router/telemetry': { post: { summary: 'Ingesta privada de métricas ligeras por el túnel SSH', security: [], responses: { '204': { description: 'Muestra aceptada o repetición exacta idempotente' }, '400': { description: 'Métrica fuera de contrato' }, '401': { description: 'Token exclusivo de telemetría inválido' }, '409': { description: 'Secuencia o generación retirada' }, '503': { description: 'Telemetría no configurada' } } } },
      '/api/resources': { get: { summary: 'Inventario y capacidades actuales (caché compartida 60 s)', responses: { '200': { description: 'resources, fetchedAt, refreshSeconds y cursor monotónico previo a la lectura para sincronizar SSE' } } } },
      '/api/costs': { get: { summary: 'Costes y presupuestos (caché persistente 24 h; no fuerza consultas a AWS)', responses: { '200': { description: 'accounts, fetchedAt, nextRefreshAt' } } } },
      '/api/operations': { get: { summary: 'Últimas 100 operaciones', responses: { '200': { description: 'operations' } } }, post: { summary: 'Ejecutar una capacidad anunciada por el recurso', parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['resourceId', 'action'], properties: { resourceId: { type: 'string' }, action: { enum: ['start', 'stop', 'refresh', 'boot-windows', 'boot-cachyos'] }, confirmed: { type: 'boolean', description: 'Obligatorio true para todas las acciones salvo refresh. El agente debe contar con autorización del usuario.' } } } } } }, responses: { '202': { description: 'Orden registrada; consultar su estado hasta succeeded, failed o uncertain' }, '400': { description: 'Orden o capacidad no válida' }, '409': { description: 'Conflicto de idempotencia u operación en curso' }, '429': { description: 'Esperar Retry-After' }, '503': { description: 'Compuerta de despliegue activa; respetar Retry-After' } } } },
      '/api/operations/{id}': { get: { summary: 'Resultado verificable de una orden', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Operation: id, actor, resourceId, action, state, message, createdAt, updatedAt' }, '404': { description: 'No existe' } } } },
      '/api/operations/{id}/history': { get: { summary: 'Transiciones durables de una orden', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ events: [{ id, type, aggregateId, payload, createdAt }] }' }, '404': { description: 'No existe' } } } }
    }
  }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  if (frontendRoot) mountFrontend(app, frontendRoot);
  app.get('/', (_req, res) => res.json({ service: 'Infra Control API', version: '0.1.0', frontend: 'pending-design-approval', health: '/health', documentation: '/api/openapi.json' }));
  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const isBodyError = error instanceof SyntaxError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 413);
    res.status(isBodyError ? 400 : 503).json({ error: isBodyError ? 'Contenido de solicitud no válido.' : 'Servicio temporalmente no disponible. Intenta de nuevo más tarde.' });
  });
  return app;
}
