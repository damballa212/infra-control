import type { Express, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from './types.js';
import { SecretsError, type SecretsErrorCode, type SecretsService } from './secrets.js';
import type { VaultAdapter } from './secrets-vault.js';
import { parsePageQuery, PageError } from './pagination.js';

const STATUS: Record<SecretsErrorCode, number> = {
  invalid_request: 400, invalid_value: 400, forbidden_project: 403, forbidden_name: 403, not_found: 404,
  idempotency_conflict: 409, not_pending: 409, not_claimable: 409, item_not_found: 422, vault_unavailable: 502
};
const destination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dotenv'), path: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('process') }).strict()
]);
const createBody = z.object({
  name: z.string().max(64), project: z.string().max(80), environment: z.string().max(80).optional(),
  machine: z.string().max(64), reason: z.string().max(200), destination
}).strict();
const approveBody = z.object({
  approval: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('paste'), value: z.string().max(16384) }).strict(),
    z.object({ mode: z.literal('existing'), itemRef: z.string().min(1).max(200) }).strict()
  ]),
  scope: z.enum(['once', 'machine_project', 'always']).default('once')
}).strict();
const itemsQuery = z.object({
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/), environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional()
}).strict();

/** Rutas de /api/secrets. Sin bóveda configurada todas fallan cerradas con 503. */
export function registerSecretsRoutes(app: Express, config: Config, service: SecretsService | undefined, vault: VaultAdapter | undefined): void {
  const origin = new URL(config.origin).origin;
  const fail = (res: Response, error: unknown): void => {
    if(error instanceof PageError){res.status(400).json({error:error.message});return;}
    if (error instanceof SecretsError) { res.status(STATUS[error.code]).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: 'No se pudo completar la operación de secretos.' });
  };
  const ready = (_req: Request, res: Response, next: NextFunction): void => {
    if (!service || !vault) { res.status(503).json({ error: 'La bóveda de secretos no está configurada.', code: 'vault_unavailable' }); return; }
    next();
  };
  const humanOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.agent) { res.status(403).json({ error: 'Esta acción pertenece a una sesión personal.' }); return; }
    if (req.method !== 'GET' && req.get('origin') !== origin) { res.status(403).json({ error: 'Origen no permitido.' }); return; }
    next();
  };
  const agentOnly = (_req: Request, res: Response, next: NextFunction): void => {
    if (!res.locals.agent) { res.status(403).json({ error: 'Las solicitudes las crea un agente; tú las apruebas.' }); return; }
    next();
  };
  const limiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, message: { error: 'Demasiadas peticiones de secretos. Espera un minuto.' } });
  const svc = (): SecretsService => service!;
  const sendRequest = (res: Response, status: number, request: unknown): void => { res.status(status).set('Cache-Control', 'no-store').json(request); };

  const policyOf = (res: Response) => config.agentTokens.find(agent => agent.name === res.locals.actor)?.secretsPolicy;

  app.post('/api/secrets/requests', ready, agentOnly, limiter(30), async (req, res) => {
    const policy = policyOf(res);
    if (!policy) { res.status(403).json({ error: 'Este token no tiene permiso para pedir secretos.', code: 'forbidden_project' }); return; }
    const body = createBody.safeParse(req.body);
    const key = req.get('Idempotency-Key');
    if (!body.success || !key) { res.status(400).json({ error: 'Solicitud no válida o falta Idempotency-Key.', code: 'invalid_request' }); return; }
    try {
      const request = await svc().request(res.locals.actor as string, policy, body.data, key);
      sendRequest(res, 201, { ...request, url: `${origin}/secretos/${request.id}` });
    } catch (error) { fail(res, error); }
  });

  /** Un agente consulta qué nombres hay en la bóveda para un proyecto (dentro de su política). Nunca valores. */
  app.get('/api/secrets/available', ready, agentOnly, limiter(30), async (req, res) => {
    const policy = policyOf(res);
    if (!policy) { res.status(403).json({ error: 'Este token no tiene permiso para consultar secretos.', code: 'forbidden_project' }); return; }
    const query = itemsQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'Proyecto o entorno no válido.', code: 'invalid_request' }); return; }
    try { sendRequest(res, 200, { items: await svc().available(policy, query.data.project, query.data.environment) }); }
    catch (error) { fail(res, error); }
  });

  app.get('/api/secrets/requests/pending',ready,humanOnly,(req,res)=>{
    try{sendRequest(res,200,svc().requestPage({...parsePageQuery(req.query),state:'pending'},'owner:pending'));}catch(error){fail(res,error);}
  });
  app.get('/api/secrets/requests/counts',ready,humanOnly,(_req,res)=>sendRequest(res,200,svc().requestCounts()));
  app.get('/api/secrets/requests/:id', ready, (req, res) => {
    const request = svc().get(String(req.params.id));
    if (!request || (res.locals.agent && request.agent !== res.locals.actor)) { res.status(404).json({ error: 'Solicitud no encontrada.', code: 'not_found' }); return; }
    sendRequest(res, 200, request);
  });

  app.post('/api/secrets/requests/:id/claim', ready, agentOnly, limiter(30), async (req, res) => {
    try {
      const delivery = await svc().claim(String(req.params.id), res.locals.actor as string);
      res.status(200).set('Cache-Control', 'no-store').json(delivery);
    } catch (error) { fail(res, error); }
  });

  app.get('/api/secrets/requests',ready,humanOnly,(req,res)=>{
    try{sendRequest(res,200,svc().requestPage(parsePageQuery(req.query),'owner:requests'));}catch(error){fail(res,error);}
  });

  app.post('/api/secrets/requests/:id/approve', ready, humanOnly, limiter(30), async (req, res) => {
    const body = approveBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Aprobación no válida.', code: 'invalid_request' }); return; }
    try { sendRequest(res, 200, await svc().approve(String(req.params.id), body.data.approval, body.data.scope)); }
    catch (error) { fail(res, error); }
  });

  app.post('/api/secrets/requests/:id/deny', ready, humanOnly, limiter(30), (req, res) => {
    try { sendRequest(res, 200, svc().deny(String(req.params.id))); } catch (error) { fail(res, error); }
  });

  app.get('/api/secrets/items', ready, humanOnly, async (req, res) => {
    const query = itemsQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'Proyecto o entorno no válido.', code: 'invalid_request' }); return; }
    try {
      const items = await vault!.list(`${query.data.project}/${query.data.environment ?? 'default'}`);
      sendRequest(res, 200, { items });
    } catch { fail(res, new SecretsError('vault_unavailable', 'No se pudo leer la bóveda.')); }
  });

  app.get('/api/secrets/grants',ready,humanOnly,(req,res)=>{
    try{sendRequest(res,200,svc().grantPage(parsePageQuery(req.query),'owner:grants'));}catch(error){fail(res,error);}
  });
  app.delete('/api/secrets/grants/:id', ready, humanOnly, (req, res) => {
    if (!svc().revokeGrant(String(req.params.id))) { res.status(404).json({ error: 'Permiso no encontrado.', code: 'not_found' }); return; }
    sendRequest(res, 200, { revoked: true });
  });
  app.get('/api/secrets/audit',ready,humanOnly,(req,res)=>{
    try{sendRequest(res,200,svc().auditPage(parsePageQuery(req.query),'owner:audit'));}catch(error){fail(res,error);}
  });
}
