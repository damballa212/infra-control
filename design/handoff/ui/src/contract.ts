// COPIA TIPADA del contrato público (../../../../contracts/api.ts + server/types.ts + server/costs.ts).
// La UI no importa nada de server/. `checks/contract-sync.ts` comprueba en tiempo de compilación que esta copia
// sigue siendo idéntica al contrato real; si el backend cambia, ese check falla y hay que actualizar este archivo.

export type Action = "start" | "stop" | "refresh" | "boot-windows" | "boot-cachyos";

export type ResourceKind = "ec2" | "service" | "router" | "computer";
export type HostMetricsSnapshot = {
  cpu?: { percent: number; observedAt: string };
  memory?: { usedBytes: number | null; totalBytes: number | null; utilizationPercent: number | null; observedAt: string };
  filesystems?: { device: string; mountpoint: string; utilizationPercent: number; observedAt: string }[];
  network?: { device: string; receivedBytes: number | null; sentBytes: number | null; observedAt: string }[];
};

export type Resource = {
  id: string;
  name: string;
  kind: ResourceKind;
  state: string;
  location: string;
  account: string;
  detail: string;
  actions: Action[];
  observedAt: string | null;
  note?: string;
  system?: "windows" | "cachyos";
  stateChangedAt?: string | null;
  hostMetrics?: HostMetricsSnapshot;
  monitoring?: { availability: "on-demand" | "unspecified"; expectedState?: "asleep" | "stopped" };
  coverage?: { state: "healthy" | "partial" | "failed" | "unknown"; observedAt: string | null; freshUntil: string | null };
  serviceSignals?: { hermes?: HealthSignal<"healthy" | "degraded" | "unhealthy" | "unknown">; https?: HealthSignal<"healthy" | "degraded" | "unhealthy" | "unknown"> };
  catalog?: {
    catalogId: string;
    provider: "aws" | "coolify" | "host";
    accountId: string;
    region: string;
    resourceType: string;
    providerId: string;
    lifecycle: "active" | "candidate_missing" | "retired";
    projectId?: string;
    project?: string;
    environment?: string;
  };
};

export type HealthSignal<State extends string> = {
  state: State;
  source: string;
  observedAt: string | null;
  freshUntil?: string | null;
  reasonCode?: string;
  evidence?: string;
};
export type ResourceHealth = {
  presence?: HealthSignal<"fresh" | "stale" | "unknown">;
  control?: HealthSignal<"available" | "degraded" | "unavailable" | "unknown">;
  service?: HealthSignal<"healthy" | "degraded" | "unhealthy" | "unknown">;
  telemetry?: HealthSignal<"fresh" | "stale" | "unknown">;
  tunnel?: HealthSignal<"available" | "degraded" | "unavailable" | "unknown">;
  cwmp?: HealthSignal<"available" | "degraded" | "unavailable" | "unknown">;
  wanLink?: HealthSignal<"available" | "degraded" | "unavailable" | "unknown">;
  internetProbe?: HealthSignal<"available" | "degraded" | "unavailable" | "unknown">;
};
export type ActionAvailability = { allowed: boolean; reasonCode: string; availableAt?: string | null; observedAt?: string | null };
export type DetailedResource = Resource & {
  health?: ResourceHealth;
  actionAvailability?: Partial<Record<Action, ActionAvailability>>;
};

export type OperationState =
  "accepted" | "running" | "succeeded" | "failed" | "uncertain";

export type Operation = {
  id: string;
  resourceId: string;
  resourceName: string;
  action: Action;
  actor: string;
  state: OperationState;
  message: string;
  createdAt: string;
  updatedAt: string;
  review?: OperationReview;
};

export type OperationReview = {
  disposition: 'pending' | 'reviewed' | 'superseded'; version: number; canonicalResourceId: string;
  updatedAt: string; reason: string; supersededByOperationId?: string;
  reviewedBy?: string; reviewedAt?: string;
  evidence: { kind: 'execution_result' | 'later_confirmed_power' | 'human_review'; operationId?: string; action?: Action; confirmedAt?: string };
};

export type CostAccount = {
  account: string;
  accountId?: string;
  status: "available" | "partial" | "unavailable";
  net: number | null;
  usage: number | null;
  adjustments: number | null;
  currency: string;
  estimated: boolean;
  services: { name: string; amount: number }[];
  daily: { date: string; amount: number }[];
  budgetsStatus: "available" | "unavailable" | "partial";
  budgets: {
    name: string;
    limit: number | null;
    actual: number | null;
    forecast: number | null;
    currency: string;
    updatedAt: string | null;
  }[];
  fetchedAt: string;
};

export type CostReport = {
  accounts: CostAccount[];
  fetchedAt: string;
  nextRefreshAt: string;
  periodStart: string;
  periodEnd: string;
  policy: string;
};

export type ResourcesResponse = {
  resources: Resource[];
  fetchedAt: string;
  refreshSeconds: number;
};
export type ResourcesSnapshotResponse = {
  resources: DetailedResource[];
  fetchedAt: string;
  refreshSeconds: number;
  cursor: number;
};
export type OperationsResponse = { operations: Operation[]; nextCursor?: string | null; hasMore?: boolean };
export type PageQuery = { limit?: number; cursor?: string; q?: string; actor?: string; state?: string; type?: string; resourceId?: string; view?: string };
export type PageInfo = { nextCursor: string | null; hasMore: boolean };
export type OperationPageResponse = { operations: Operation[] } & PageInfo;
export type ReviewReason = 'checked_state' | 'accepted_uncertainty' | 'no_further_action';
export type IncidentSourceContext = {
  eventIds: number[]; resourceId?: string; catalogId?: string; scopeKey?: string; conflict?: true;
};
export type OperationalIncident = {
  id: string; key: string; component: string; resourceId: string | null; canonicalResourceId: string | null; connectionId?: string; scopeKey?: string;
  accountId?: string; account?: string; budgetName?: string; sourceContext?: IncidentSourceContext;
  category: string; kind: 'application' | 'observability' | 'availability' | 'coverage' | 'budget' | 'change'; source: string;
  status: 'open' | 'unknown' | 'resolved' | 'information'; actionable: boolean; openedAt: string; updatedAt: string; resolvedAt?: string;
  openingEventId: number | null; lastEventId: number | null; recoveryEventId?: number; version: number;
  evidence: { reasonCode: string; observedAt: string | null; from?: string; to?: string };
  acknowledgement?: { by: string; at: string; reportVersion: number };
};
export type IncidentPageResponse = { incidents: OperationalIncident[] } & PageInfo;
export type IncidentHistoryPageResponse = { events: OperationalIncident[] } & PageInfo;
export type ResourceExpectation = { resourceId: string; mode: 'observe' | 'on-demand' | 'always-on'; version: number; updatedAt: string | null };
export type PowerIntent = { operationId: string; action: Action; result: Operation['state']; requestedAt: string; confirmedAt?: string; targetPower: 'on' | 'off'; targetSystem?: 'windows' | 'cachyos'; transition: { expected: boolean; reasonCode?: string; expiresAt: string | null } };
export type ResourceExpectationResponse = { expectation: ResourceExpectation; intent: PowerIntent | null };
export type AttentionSummary = {
  fetchedAt: string; counts: { attentionGroups: number; active: number; pendingReviews: number; openIncidents: number; unknownIncidents: number; coverageProblems: number };
  coverage: { scopes: number; healthy: number; partial: number; failed: number; stale: number }; pendingApprovals?: number;
};
export type SecretRequestsPageResponse = { requests: SecretRequest[]; pendingCount: number } & PageInfo;
export type SecretGrantsPageResponse = { grants: SecretGrant[] } & PageInfo;
export type SecretAuditPageResponse = { events: SecretAuditEvent[] } & PageInfo;
export type SecretRequestCountsResponse = { counts: Record<string, number> };
/** GET /api/operations/:id/history: eventos durables; payload es la orden en ese momento. */
export type OperationHistoryEvent = {
  id: number;
  type: "desktop" | "resource" | "operation" | "incident" | "coverage";
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
export type OperationHistoryResponse = { events: OperationHistoryEvent[] };

export type CatalogServiceRelation = {
  resourceAlias: string;
  resourceId: string | null;
  resolved: boolean;
  relationType: "hosted_on" | "depends_on";
  evidence: "operator_confirmed" | "provider_metadata";
  active: boolean;
  firstSeen: string;
  lastSeen: string;
  resource?: {
    catalogId: string;
    name: string;
    provider: "aws" | "coolify" | "host";
    accountId: string;
    region: string;
    state: string;
    lifecycle: "active" | "candidate_missing" | "retired";
  };
};
export type CatalogServiceRecord = {
  id: string;
  key: string;
  name: string;
  projectId: string | null;
  project: string | null;
  environment: string | null;
  criticality: "critical" | "high" | "normal" | "low";
  source: string;
  active: boolean;
  relations: CatalogServiceRelation[];
};
export type CatalogServicesResponse = { services: CatalogServiceRecord[]; fetchedAt: string };

/**
 * GET /api/system/health: subconjunto que usa la UI. El backend filtra por readPolicy, así que cada
 * bloque puede faltar; ausencia no es fallo.
 */
export type SystemHealthResponse = {
  panel: { state: string; observedAt: string; eventStreams?: number };
  catalog?: { resources: number; observed: number; stale: number; scopes: number; healthyScopes: number; failedScopes: number; partialScopes: number };
  operations?: { visible: number; active: number; uncertain: number; failed: number };
  cloud?: { enabled: boolean; state: string; lastCompletedAt: string | null; consecutiveFailures: number; resourcesObserved: number; unknownResources: number };
};
export type OperationRequest = {
  resourceId: string;
  action: Action;
  confirmed?: boolean;
};
export type ApiError = { error: string };
export type AuthUser = {
  name: string;
  agent?: boolean;
  scopes?: ("read" | "operate")[];
};

export type BootSystem = "windows" | "cachyos";

/** Sistema que la PC arranca sola (corte de luz, encendido remoto). Copia de DesktopBootPreferenceResponse. */
export type BootPreference = {
  desired: BootSystem | null;
  effective: BootSystem | null;
  state: "unknown" | "pending" | "applying" | "applied" | "uncertain" | "failed" | "drift";
  version: number;
  requestedAt?: string;
  verifiedAt?: string;
  observedAt?: string;
  message?: string;
};

export type PushCategory =
  | "operations"
  | "devices"
  | "router"
  | "infrastructure"
  | "budgets"
  | "secrets"
  | "secretDeliveries";
export type PushPreferences = Record<PushCategory, boolean>;
/** Copia de GET /api/push/config: `enabled` es false hasta que el servidor tiene claves VAPID. */
export type PushConfig = { enabled: boolean; vapidPublicKey?: string | null };
/** Suscripción de ESTE navegador en el formato que entrega PushSubscription.toJSON(). */
export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};
export type PushDevice = {
  id: string;
  createdAt: string;
  lastSuccessAt: string | null;
  preferences: PushPreferences;
};

/** Solicitudes de secretos de agentes (GET /api/secrets/*). Ningún tipo contiene valores. */
export type SecretScope = "once" | "machine_project" | "always";
export type SecretRequestState = "pending" | "approved" | "denied" | "expired" | "delivered" | "failed";
export type SecretDestination = { kind: "dotenv"; path: string } | { kind: "process" };
export type SecretRequest = {
  id: string;
  agent: string;
  machine: string;
  name: string;
  project: string;
  environment: string | null;
  destination: SecretDestination;
  reason: string;
  state: SecretRequestState;
  scope: SecretScope | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  deliveredAt: string | null;
  auto: boolean;
};
export type SecretApproval = { mode: "paste"; value: string } | { mode: "existing"; itemRef: string };
export type SecretGrant = {
  id: string;
  agent: string;
  machine: string;
  project: string;
  environment: string | null;
  name: string;
  scope: Exclude<SecretScope, "once">;
  createdAt: string;
};
export type SecretAuditEvent = { id: number; at: string; requestId: string | null; event: string; actor: string };
export type VaultItem = { itemRef: string; name: string; updatedAt: string };
