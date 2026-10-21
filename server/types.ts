export type Action = 'start' | 'stop' | 'refresh' | 'boot-windows' | 'boot-cachyos';
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
export type ActionAvailability = { allowed: boolean; reasonCode: string; availableAt?: string | null; observedAt?: string | null };
export type Resource = {
  id: string; name: string; kind: 'ec2' | 'service' | 'router' | 'computer';
  state: string; location: string; account: string; detail: string;
  actions: Action[]; observedAt: string | null; note?: string;
  system?: 'windows' | 'cachyos';
  health?: ResourceHealth;
  actionAvailability?: Partial<Record<Action, ActionAvailability>>;
};
export type Adapter = {
  inventory(): Promise<Resource[]>;
  cloudInventory?(): Promise<Resource[]>;
  perform(resource: Resource, action: Action, onProgress?: (message: string) => void): Promise<{ message: string }>;
  setBootDefault?(system: 'windows' | 'cachyos'): Promise<{ defaultSystem: 'windows' | 'cachyos'; verifiedAt: string }>;
  readBootDefault?(): Promise<{ defaultSystem: 'windows' | 'cachyos'; observedAt: string }>;
  checkRouter?(): Promise<{ ready: boolean }>;
};
export type AwsAccount = {
  name: string; accountId: string; accessKeyId: string; secretAccessKey: string;
  instances: { id: string; region: string; name: string; type: string }[];
};
export type Config = {
  origin: string; passwordHash: string;
  agentTokens: { name: string; hash: string; scopes: ('read' | 'operate')[] }[];
  aws: AwsAccount[];
  coolify: { url: string; token: string; resources: { uuid: string; name: string; type: string }[] };
  acs: { url: string; deviceId: string };
  desktop?: { socketPath: string; reportTokenHashes?: { windows:string; cachyos:string } };
  routerTelemetryTokenHash?: string;
  macTelemetryTokenHash?: string;
  hermes?: { resourceId: string; reportTokenHash: string };
  push?: {
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
};
