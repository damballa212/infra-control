import type { Express, Request, Response } from 'express';
import type { Config } from './types.js';
import type { RestrictedEventProjection } from './restricted-event-projection.js';
import { z } from 'zod';
import type { Store } from './store.js';
import type { CatalogScopeRecord } from './catalog.js';
import type { AttentionSummary } from './operational-types.js';
import { PageError, parsePageQuery } from './pagination.js';
import { scopeObservationFresh } from './catalog-freshness.js';
export type OperationalAccess={resource:(id:string)=>boolean;incident:(payload:Record<string,unknown>,aggregateId:string)=>boolean};
export function attentionSummary(store:Store,access:OperationalAccess,scopes:CatalogScopeRecord[]):AttentionSummary {
  const now=Date.now();return {fetchedAt:new Date(now).toISOString(),counts:store.operational.summary(access.resource,access.incident),coverage:{scopes:scopes.length,healthy:scopes.filter(scope=>scope.state==='healthy'&&scopeObservationFresh(scope,now)).length,partial:scopes.filter(scope=>scope.state==='partial').length,failed:scopes.filter(scope=>scope.state==='failed').length,stale:scopes.filter(scope=>!scopeObservationFresh(scope,now)).length}};
}
type IncidentRead = { access: OperationalAccess['incident']; context: string; projection?: RestrictedEventProjection };
export function registerOperationalRoutes(app:Express,deps:{store:Store;origin:string;access:(actor:string)=>OperationalAccess;context:(actor:string)=>string;refresh:()=>void;scopes:(actor:string)=>CatalogScopeRecord[];incidentRead?:(actor:string,credential:Config['agentTokens'][number] | undefined)=>IncidentRead}):void {
  const incidentRead = (res: Response): IncidentRead => {
    const actor = res.locals.actor as string;
    return deps.incidentRead?.(actor, res.locals.agentCredential) ?? { access: deps.access(actor).incident, context: deps.context(actor) };
  };
  const incidentQuery = (req: Request, res: Response, projection: RestrictedEventProjection | undefined, purpose: string) => {
    const supplied = req.query.cursor;
    if (!projection || supplied === undefined) return parsePageQuery(req.query);
    const cursor = typeof supplied === 'string' ? projection.open(purpose, supplied) : undefined;
    if (cursor === undefined) { res.status(400).json({ error: 'Cursor de incidentes no válido.' }); return undefined; }
    return parsePageQuery({ ...req.query, cursor });
  };
  const review=z.object({expectedVersion:z.number().int().positive(),reason:z.enum(['checked_state','accepted_uncertainty','no_further_action'])}).strict();
  const version=z.object({expectedVersion:z.number().int().positive()}).strict();
  const expectation=z.object({expectedVersion:z.number().int().nonnegative(),mode:z.enum(['observe','on-demand','always-on'])}).strict();
  const wrap=(fn:Parameters<Express['get']>[1])=>fn;
  const fail=(res:any,error:unknown)=>{if(error instanceof PageError){res.status(400).json({error:error.message});return;}throw error;};
  const owner=(req:any,res:any)=>{if(res.locals.agent||res.locals.actor!=='Admin'||req.get('Origin')!==deps.origin){res.status(403).json({error:'Esta decisión requiere sesión personal y Origin exacto.'});return false;}return true;};
  for(const view of ['active','review'] as const)app.get(`/api/operations/${view}`,(req,res)=>{try{const actor=res.locals.actor as string;res.json(deps.store.operational.operationPage({...parsePageQuery(req.query),view},deps.context(actor),deps.access(actor).resource));}catch(error){fail(res,error);}});
  app.post('/api/operations/:id/review',(req,res)=>{
    if(!owner(req,res))return;const operation=deps.store.get(String(req.params.id));if(!operation||!deps.access(res.locals.actor).resource(operation.resourceId)){res.status(404).json({error:'Operación no encontrada.'});return;}
    const body=review.safeParse(req.body);if(!body.success){res.status(400).json({error:'Incluye expectedVersion y un motivo de revisión válido.'});return;}
    try{res.json(deps.store.operational.markReviewed(operation.id,body.data.expectedVersion,body.data.reason));}catch(error){if(error instanceof PageError){res.status(409).json({error:error.message});return;}throw error;}
  });
  app.get('/api/attention/summary',(_req,res)=>{deps.refresh();const actor=res.locals.actor as string;const summary=attentionSummary(deps.store,deps.access(actor),deps.scopes(actor));if(!res.locals.agent&&deps.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='secret_requests'").get())summary.pendingApprovals=Number((deps.store.db.prepare("SELECT COUNT(*) AS count FROM secret_requests WHERE state='pending' AND expires_at>?").get(new Date().toISOString()) as {count:number}).count);res.json(summary);});
  const listIncidents = (req: Request, res: Response, view: string) => {
    try {
      deps.refresh();
      const { access, context, projection } = incidentRead(res);
      const purpose = `rest:incidents:${view}`;
      const query = incidentQuery(req, res, projection, purpose);
      if (!query) return;
      const page = deps.store.operational.incidentPage({ ...query, view }, context, access);
      res.json(projection ? projection.incidentPage(page, purpose) : page);
    } catch (error) { fail(res,error); }
  };
  for (const view of ['current','history'] as const) app.get(`/api/incidents/${view}`, (req,res) => listIncidents(req,res,view));
  app.get('/api/incidents', (req,res) => listIncidents(req,res,typeof req.query.view === 'string' ? req.query.view : 'current'));
  app.get('/api/incidents/:id/history', (req,res) => {
    try {
      const { access, context, projection } = incidentRead(res);
      const incident = deps.store.operational.getIncident(String(req.params.id));
      if (!incident || !access(incident as unknown as Record<string,unknown>,incident.resourceId ?? incident.id)) {
        res.status(404).json({error:'Incidente no encontrado.'}); return;
      }
      const purpose = `rest:incident-history:${incident.id}`;
      const query = incidentQuery(req, res, projection, purpose);
      if (!query) return;
      const page = deps.store.operational.incidentHistory(incident.id, query, context, access);
      res.json(projection ? projection.historyPage({ ...page }, purpose) : page);
    } catch (error) { fail(res,error); }
  });
  app.post('/api/incidents/:id/acknowledgment',(req,res)=>{if(!owner(req,res))return;const incident=deps.store.operational.getIncident(String(req.params.id));if(!incident||!deps.access(res.locals.actor).incident(incident as unknown as Record<string,unknown>,incident.resourceId??incident.id)){res.status(404).json({error:'Incidente no encontrado.'});return;}const body=version.safeParse(req.body);if(!body.success){res.status(400).json({error:'Incluye expectedVersion.'});return;}try{res.json(deps.store.operational.acknowledge(incident.id,body.data.expectedVersion));}catch(error){if(error instanceof PageError){res.status(409).json({error:error.message});return;}throw error;}});
  app.get('/api/resources/:id/expectation',(req,res)=>{const actor=res.locals.actor as string,id=String(req.params.id);if(!deps.access(actor).resource(id)){res.status(404).json({error:'Recurso no encontrado.'});return;}res.json({expectation:deps.store.operational.expectation(id),intent:deps.store.operational.intent(id)});});
  app.put('/api/resources/:id/expectation',(req,res)=>{if(!owner(req,res))return;const id=String(req.params.id);if(!deps.access(res.locals.actor).resource(id)){res.status(404).json({error:'Recurso no encontrado.'});return;}const body=expectation.safeParse(req.body);if(!body.success){res.status(400).json({error:'Incluye mode y expectedVersion.'});return;}try{const result=deps.store.operational.setExpectation(id,body.data.mode,body.data.expectedVersion);deps.refresh();res.json({expectation:result,intent:deps.store.operational.intent(id)});}catch(error){if(error instanceof PageError){res.status(409).json({error:error.message});return;}throw error;}});
}
