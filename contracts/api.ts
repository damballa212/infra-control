// Public, type-only integration surface. No credentials or provider SDKs at runtime.
export type { Action, Operation, HealthSignal, ResourceHealth, ActionAvailability, CatalogIdentity } from '../server/types.js';
export type { ServiceDefinition, CatalogProvider } from '../server/types.js';
export type { CatalogServiceRecord, CatalogServiceRelation } from '../server/catalog.js';
import type { CatalogServiceRecord } from '../server/catalog.js';
export type CatalogServicesResponse = { services:CatalogServiceRecord[]; fetchedAt:string };
export type { McpToolName, AgentReadPolicy, AgentOperationPolicy } from '../server/types.js';
export type { CostAccount, CostReport } from '../server/costs.js';
export type { RouterSample, RouterSnapshot, RouterTelemetryState, RouterTunnelProbe } from '../server/router-reports.js';
export type { HermesReport, HermesSnapshot } from '../server/hermes-reports.js';
import type { Action, Resource as DetailedResource, Operation } from '../server/types.js';
import type { DesktopBootPreference, DurableEvent } from '../server/store.js';
import type { RouterSnapshot as RouterSnapshotType, RouterTunnelProbe as RouterTunnelProbeType } from '../server/router-reports.js';
// `Resource` stays the frozen visual-handoff shape; diagnostics are additive in
// the API and available to new consumers through `DetailedResource`.
export type Resource = Omit<DetailedResource, 'health' | 'actionAvailability'>;
export type { DetailedResource };
export type ResourcesResponse = { resources: Resource[]; fetchedAt: string; refreshSeconds: number };
export type ResourcesSnapshotResponse = { resources: DetailedResource[]; fetchedAt: string; refreshSeconds: number; cursor: number | string };
export type RouterHealthResponse = { resource: DetailedResource; telemetry: RouterSnapshotType | null; probe: RouterTunnelProbeType | null; fetchedAt: string };
export type RouterCheckResponse = { probe: RouterTunnelProbeType; resource: DetailedResource; cached: boolean; fetchedAt: string; message: string };
export type HermesHealthResponse = { telemetry: import('../server/hermes-reports.js').HermesSnapshot | null; fetchedAt: string };
export type { DesktopBootPreference };
export type DesktopBootPreferenceResponse = Omit<DesktopBootPreference, 'operationKey'>;
export type OperationsResponse = { operations: Operation[]; nextCursor?: string | null; hasMore?: boolean };
export type { OperationReview, PageInfo, OperationPageResponse, OperationalIncident, IncidentPageResponse, AttentionSummary, ResourceExpectation, PowerIntent, SecretRequestsPageResponse, SecretGrantsPageResponse, SecretAuditPageResponse } from '../server/operational-types.js';
export type OperationHistoryResponse = { events: DurableEvent[] };
export type OperationRequest = { resourceId: string; action: Action; confirmed?: boolean };
export type ApiError = { error: string };
export type AuthUser = { name: string; agent?: boolean; scopes?: ('read' | 'operate')[] };
export type { SecretRequest, SecretApproval, SecretDelivery, SecretDestination, SecretGrant, SecretScope, SecretAuditEvent, SecretsPolicy } from '../server/secrets.js';
export type { VaultItem } from '../server/secrets-vault.js';
