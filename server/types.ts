export type Action = 'start' | 'stop' | 'refresh' | 'boot-windows' | 'boot-cachyos';
export type McpToolName = 'list_resources' | 'get_resource' | 'list_projects' | 'get_incidents' | 'get_cost_summary' | 'plan_operation' | 'execute_operation' | 'get_operation' | 'get_pending_incidents' | 'acknowledge_incident';
export type AgentOperationPolicy = { actions: Action[]; resourceIds?: string[]; catalogIds?: string[]; projectIds?: string[]; connectionIds?: string[] };
export type AgentReadPolicy = { resourceIds?: string[]; catalogIds?: string[]; projectIds?: string[]; connectionIds?: string[]; accountIds?: string[]; costs?: boolean };
export type HealthSignal<State extends string> = {
  state: State; source: string; observedAt: string | null; freshUntil?: string | null;
  reasonCode?: string; evidence?: string;
};
export type ResourceHealth = {
  presence?: HealthSignal<'fresh' | 'stale' | 'unknown'>;
  control?: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'>;
  service?: HealthSignal<'healthy' | 'degraded' | 'unhealthy' | 'unknown'>;
  telemetry?: HealthSignal<'fresh' | 'stale' | 'unknown'>;
  tunnel?: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'>;
  cwmp?: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'>;
  wanLink?: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'>;
  internetProbe?: HealthSignal<'available' | 'degraded' | 'unavailable' | 'unknown'>;
};
export type HostMetricsSnapshot = {
  cpu?: { percent: number; observedAt: string };
  memory?: { usedBytes: number | null; totalBytes: number | null; utilizationPercent: number | null; observedAt: string };
  filesystems?: { device: string; mountpoint: string; utilizationPercent: number; observedAt: string }[];
  network?: { device: string; receivedBytes: number | null; sentBytes: number | null; observedAt: string }[];
};
export type ServiceProbeSignal = Omit<HealthSignal<'healthy' | 'degraded' | 'unhealthy' | 'unknown'>, 'observedAt' | 'freshUntil'> & { observedAt: string; freshUntil: string };
export type ServiceProbeTarget = {
  resourceId: string; url: string; expectedStatusCodes: number[]; intervalSeconds: number; timeoutMs: number;
  /** Relación de alojamiento explícita; nunca se deduce del nombre o URL. */
  hostResourceId?: string;
};
export type ServiceDefinition = {
  key:string; name:string; projectKey?:string; projectName?:string; environment?:string;
  criticality:'critical'|'high'|'normal'|'low';
  relations:{resourceId:string;relationType:'hosted_on'|'depends_on';evidence:'operator_confirmed'|'provider_metadata'}[];
};
export type VerifiedResourceObservation = { state: string; observedAt: string; stateChangedAt?: string | null };
export type AdapterOperationResult = { message: string; observation?: VerifiedResourceObservation };
export type PowerVerificationUpdate = { phase: 'dispatch' | 'wake' | 'cooldown' | 'verify'; deadlineAt: string; bootId?: string };
export type OperationProgress = (message: string, verification?: PowerVerificationUpdate) => void;
export type ActionAvailability = { allowed: boolean; reasonCode: string; availableAt?: string | null; observedAt?: string | null };
export type CatalogProvider = 'aws' | 'coolify' | 'host';
export type CatalogIdentity = {
  catalogId: string; provider: CatalogProvider; accountId: string; region: string;
  resourceType: string; providerId: string; lifecycle: 'active' | 'candidate_missing' | 'retired';
  projectId?: string; project?: string; environment?: string;
};
export type Resource = {
  id: string; name: string; kind: 'ec2' | 'service' | 'router' | 'computer';
  state: string; location: string; account: string; detail: string;
  actions: Action[]; observedAt: string | null; note?: string;
  system?: 'windows' | 'cachyos';
  stateChangedAt?: string | null;
  catalog?: CatalogIdentity;
  health?: ResourceHealth;
  hostMetrics?: HostMetricsSnapshot;
  monitoring?: { availability: 'on-demand' | 'unspecified'; expectedState?: 'asleep' | 'stopped' };
  coverage?: { state: 'healthy' | 'partial' | 'failed' | 'unknown'; observedAt: string | null; freshUntil: string | null };
  serviceSignals?: { hermes?: HealthSignal<'healthy' | 'degraded' | 'unhealthy' | 'unknown'>; https?: HealthSignal<'healthy' | 'degraded' | 'unhealthy' | 'unknown'> };
  actionAvailability?: Partial<Record<Action, ActionAvailability>>;
};
export type Adapter = {
  inventory(): Promise<Resource[]>;
  localInventory?(): Promise<Resource[]>;
  /** Proyección local síncrona de lecturas compartidas; nunca consulta proveedores. */
  localSnapshot?(): Resource[];
  cloudInventory?(): Promise<Resource[]>;
  perform(resource: Resource, action: Action, onProgress?: OperationProgress): Promise<AdapterOperationResult>;
  setBootDefault?(system: 'windows' | 'cachyos'): Promise<{ defaultSystem: 'windows' | 'cachyos'; verifiedAt: string }>;
  readBootDefault?(): Promise<{ defaultSystem: 'windows' | 'cachyos'; observedAt: string }>;
  checkRouter?(): Promise<{ ready: boolean }>;
};
export type AwsAccount = {
  name: string; accountId: string; displayName?: string;
  enabled?: boolean; disabledReason?: 'account_suspended';
  instances?: { id: string; region: string; name: string; type: string }[];
} & (
  { accessKeyId: string; secretAccessKey: string; sessionToken?: string; roleArn?: never; sourceAccount?: never }
  | { roleArn: string; sourceAccount: string; accessKeyId?: never; secretAccessKey?: never; sessionToken?: never }
);
export type HostObservationConfig = {
  key: string; displayName: string; enabled: boolean;
  snapshotDirectory: string; expectedFingerprint: string;
  monitoring?: { enabled: boolean };
};
export type Config = {
  hosts?: HostObservationConfig[];
  origin: string; passwordHash: string;
  agentTokens: { name: string; hash: string; scopes: ('read' | 'operate')[]; mcpTools?: McpToolName[]; readPolicy?: AgentReadPolicy; operationPolicy?: AgentOperationPolicy; secretsPolicy?: { projects: string[]; names?: string[]; autoDeliver?: boolean } }[];
  aws: AwsAccount[];
  awsEventTokenHashes?: Record<string, string>;
  coolify: { url: string; token: string; resources: { uuid: string; name: string; type: string }[] };
  acs: { url: string; deviceId: string };
  desktop?: { socketPath: string; reportTokenHashes?: { windows:string; cachyos:string } };
  routerTelemetryTokenHash?: string;
  macTelemetryTokenHash?: string;
  hermes?: { resourceId: string; reportTokenHash: string };
  otelCollectors?: { hostId: string; resourceId: string; tokenHash: string }[];
  serviceProbes?: ServiceProbeTarget[];
  /** Bóveda de secretos de agentes. Sin ella /api/secrets/* responde 503. */
  secretsVault?: { kind: 'vaultwarden'; serverUrl: string; email: string; password: string; organizationId: string };
  services?: ServiceDefinition[];
  push?: {
    /** Ausencias personales: desactivadas por defecto; no modifican avisos de órdenes o energía. */
    signalLoss?: { desktop?: boolean; mac?: boolean };
    vapidPublicKey: string;
    vapidPrivateKey: string;
    vapidSubject: string;
    encryptionKeyHex: string;
  };
};
export type Operation = {
  id: string; resourceId: string; resourceName: string; action: Action; actor: string;
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  message: string; createdAt: string; updatedAt: string;
  review?: import('./operational-types.js').OperationReview;
};
