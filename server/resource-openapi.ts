const text = { type: 'string' };
const nullable = { type: ['string', 'null'] };
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
export const eventCursorSchema = { oneOf: [{ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: 'string', pattern: '^[A-Za-z0-9_-]{48}$' }], description: 'Numérico para la sesión personal y los agentes sin readPolicy. Opaco para las credenciales con readPolicy.' };
export const resourceSchemas = {
  CatalogIdentity: { type: 'object', required: ['catalogId','provider','accountId','region','resourceType','providerId','lifecycle'], properties: { catalogId: text, provider: { enum: ['aws','coolify','host'] }, accountId: { type: 'string', description: 'Para host: UUID opaco de enrollment; nunca machine-id, fingerprint ni ruta.' }, region: text, resourceType: text, providerId: text, lifecycle: { enum: ['active','candidate_missing','retired'] }, projectId: text, project: text, environment: text } },
  HostMetricsSnapshot: { type: 'object', description: 'Métricas observadas; campos desconocidos se omiten o conservan null. observedAt pertenece a cada medición.', properties: {
    cpu: { type: 'object', required: ['percent','observedAt'], properties: { percent: { type: 'number', minimum: 0, maximum: 100 }, observedAt: text } },
    memory: { type: 'object', required: ['usedBytes','totalBytes','utilizationPercent','observedAt'], properties: { usedBytes: { type: ['number','null'] }, totalBytes: { type: ['number','null'] }, utilizationPercent: { type: ['number','null'] }, observedAt: text } },
    filesystems: { type: 'array', items: { type: 'object', required: ['device','mountpoint','utilizationPercent','observedAt'], properties: { device: text, mountpoint: text, utilizationPercent: { type: 'number' }, observedAt: text } } },
    network: { type: 'array', items: { type: 'object', properties: { device: text, receivedBytes: { type: ['number','null'] }, sentBytes: { type: ['number','null'] }, observedAt: text } } }
  } },
  Resource: { type: 'object', required: ['id','name','kind','state','location','account','detail','actions','observedAt'], properties: {
    id: text, name: text, kind: { enum: ['ec2','service','router','computer'] }, state: text, location: text, account: text, detail: text,
    actions: { type: 'array', items: { enum: ['start','stop','refresh','boot-windows','boot-cachyos'] }, description: 'Autoridad para controles; siempre vacío para provider host.' },
    observedAt: nullable, stateChangedAt: nullable, note: text, system: { enum: ['windows','cachyos'] }, catalog: reference('CatalogIdentity'), hostMetrics: reference('HostMetricsSnapshot'),
    health: { type: 'object', description: 'Señales independientes con source/observedAt/freshUntil. Docker running no acredita healthy; ausencia de archivo no acredita apagado.' },
    coverage: { type: 'object', properties: { state: { enum: ['healthy','partial','failed','unknown'] }, observedAt: nullable, freshUntil: nullable } },
    serviceSignals: { type: 'object' }, actionAvailability: { type: 'object' }, monitoring: { type: 'object' }
  } },
  ResourcesSnapshot: { type: 'object', required: ['resources','fetchedAt','refreshSeconds','cursor'], properties: { resources: { type: 'array', items: reference('Resource') }, fetchedAt: text, refreshSeconds: { type: 'integer' }, cursor: eventCursorSchema } }
};
