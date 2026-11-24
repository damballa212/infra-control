import { z } from 'zod';
import type { AwsAccount, Config } from './types.js';
import { validateAwsAccounts } from './aws-credentials.js';
import { isSafeServiceProbeUrl } from './service-probes.js';
import { hostConfigurationsSchema } from './host-config.js';

const toolNames = ['list_resources','get_resource','list_projects','get_incidents','get_cost_summary','plan_operation','execute_operation','get_operation','get_pending_incidents','acknowledge_incident'] as const;
const actions = ['start','stop','refresh','boot-windows','boot-cachyos'] as const;
const ids = z.array(z.string().min(1).max(255)).max(1000).optional();
const readPolicy = z.object({
  resourceIds: ids, catalogIds: ids, projectIds: ids, connectionIds: ids, accountIds: ids, costs: z.boolean().optional()
}).strict();
const operationPolicy = z.object({
  actions: z.array(z.enum(actions)).min(1).max(actions.length), resourceIds: ids, catalogIds: ids, projectIds: ids, connectionIds: ids
}).strict().refine(value => Boolean(value.resourceIds?.length||value.catalogIds?.length||value.projectIds?.length||value.connectionIds?.length), 'operation target required');
const agent = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  scopes: z.array(z.enum(['read','operate'])).min(1).max(2).refine(value => value.includes('read')),
  mcpTools: z.array(z.enum(toolNames)).max(toolNames.length).optional(),
  readPolicy: readPolicy.optional(),
  operationPolicy: operationPolicy.optional(),
  secretsPolicy: z.object({
    projects: z.array(z.string().regex(/^(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/)).min(1).max(50).refine(list => !list.includes('*') || list.length === 1, "'*' must be the only project"),
    names: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).min(1).max(100).optional(),
    autoDeliver: z.boolean().optional()
  }).strict().optional()
}).strict();
const otelCollector = z.object({
  hostId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  resourceId: z.string().min(1).max(220),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();
const serviceProbe = z.object({
  resourceId: z.string().min(1).max(220).regex(/^[^\u0000-\u0020\u007f]+$/),
  hostResourceId: z.string().min(1).max(220).regex(/^[^\u0000-\u0020\u007f]+$/).optional(),
  url: z.string().url().max(2048).refine(isSafeServiceProbeUrl,'unsafe HTTPS probe URL'),
  expectedStatusCodes: z.array(z.number().int().min(200).max(299)).min(1).max(10).default([200]),
  intervalSeconds: z.number().int().min(30).max(600).default(60),
  timeoutMs: z.number().int().min(250).max(3000).default(3000)
}).strict();
const serviceDefinition = z.object({
  key:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  name:z.string().min(1).max(160),
  projectKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional(),
  projectName:z.string().min(1).max(160).optional(),
  environment:z.string().min(1).max(80).optional(),
  criticality:z.enum(['critical','high','normal','low']).default('normal'),
  relations:z.array(z.object({
    resourceId:z.string().min(1).max(220).regex(/^[^\u0000-\u0020\u007f]+$/),
    relationType:z.enum(['hosted_on','depends_on']),
    evidence:z.enum(['operator_confirmed','provider_metadata'])
  }).strict()).max(100).default([])
}).strict().superRefine((item,context)=>{
  if(Boolean(item.projectKey)!==Boolean(item.projectName))context.addIssue({code:'custom',path:['projectName'],message:'project key and name must be configured together'});
  const refs=new Set<string>();
  item.relations.forEach((relation,index)=>{
    const key=`${relation.relationType}:${relation.resourceId}`;
    if(refs.has(key))context.addIssue({code:'custom',path:['relations',index],message:'duplicate service relation'});
    refs.add(key);
  });
});
const awsAccount = z.object({
  name: z.string().min(1).max(120),
  accountId: z.string().regex(/^\d{12}$/),
  displayName: z.string().min(1).max(120).optional(),
  enabled: z.boolean().default(true),
  disabledReason: z.literal('account_suspended').optional(),
  accessKeyId: z.string().min(1).max(4096).optional(),
  secretAccessKey: z.string().min(1).max(4096).optional(),
  sessionToken: z.string().min(1).max(16384).optional(),
  roleArn: z.string().min(1).max(2048).optional(),
  sourceAccount: z.string().min(1).max(120).optional(),
  instances: z.array(z.object({
    id: z.string().min(1).max(200), region: z.string().min(1).max(100),
    name: z.string().min(1).max(200), type: z.string().min(1).max(240)
  }).passthrough()).max(1000).optional()
}).passthrough().transform(account => ({
  ...account,
  displayName: account.displayName ?? account.name,
  ...(account.enabled === false && account.disabledReason === undefined ? { disabledReason: 'account_suspended' as const } : {})
}));
const configSchema = z.object({
  aws: z.array(awsAccount).max(100),
  hosts: hostConfigurationsSchema.optional(),
  origin: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  passwordHash: z.string().min(1).max(2048),
  agentTokens: z.array(agent).max(100).superRefine((items, context) => {
    const names = new Set<string>(), hashes = new Set<string>();
    items.forEach((item,index) => {
      if (names.has(item.name)) context.addIssue({code:'custom',path:[index,'name'],message:'duplicate agent name'});
      if (hashes.has(item.hash.toLowerCase())) context.addIssue({code:'custom',path:[index,'hash'],message:'duplicate agent token'});
      names.add(item.name);hashes.add(item.hash.toLowerCase());
    });
  }),
  otelCollectors: z.array(otelCollector).max(100).superRefine((items, context) => {
    const hosts=new Set<string>(),resources=new Set<string>(),hashes=new Set<string>();
    items.forEach((item,index)=>{
      if(hosts.has(item.hostId))context.addIssue({code:'custom',path:[index,'hostId'],message:'duplicate OTel host identity'});
      if(resources.has(item.resourceId))context.addIssue({code:'custom',path:[index,'resourceId'],message:'duplicate OTel resource'});
      if(hashes.has(item.tokenHash.toLowerCase()))context.addIssue({code:'custom',path:[index,'tokenHash'],message:'duplicate OTel token'});
      hosts.add(item.hostId);resources.add(item.resourceId);hashes.add(item.tokenHash.toLowerCase());
    });
  }).optional(),
  secretsVault: z.object({
    kind: z.literal('vaultwarden'),
    serverUrl: z.string().url().refine(value => new URL(value).protocol === 'https:', 'Vaultwarden must use https'),
    email: z.string().email().max(320),
    password: z.string().min(16).max(1024),
    organizationId: z.string().uuid()
  }).strict().optional(),
  serviceProbes: z.array(serviceProbe).max(10).superRefine((items, context) => {
    const ids=new Set<string>();
    items.forEach((item,index)=>{if(ids.has(item.resourceId))context.addIssue({code:'custom',path:[index,'resourceId'],message:'duplicate service probe resource'});ids.add(item.resourceId);});
  }).optional(),
  services:z.array(serviceDefinition).max(100).superRefine((items,context)=>{
    const keys=new Set<string>();items.forEach((item,index)=>{const key=item.key.toLocaleLowerCase();if(keys.has(key))context.addIssue({code:'custom',path:[index,'key'],message:'duplicate service key'});keys.add(key);});
  }).optional()
}).passthrough();

export function parseConfig(value: unknown): Config {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid server configuration');
  try { validateAwsAccounts(parsed.data.aws as unknown as AwsAccount[]); }
  catch { throw new Error('Invalid server configuration'); }
  return parsed.data as Config;
}
