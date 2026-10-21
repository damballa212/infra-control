// Public, type-only integration surface. No credentials or provider SDKs at runtime.
export type { Action, Operation, HealthSignal, ResourceHealth, ActionAvailability } from '../server/types.js';
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
export type ResourcesSnapshotResponse = { resources: DetailedResource[]; fetchedAt: string; refreshSeconds: number; cursor: number };
export type RouterHealthResponse = { resource: DetailedResource; telemetry: RouterSnapshotType | null; probe: RouterTunnelProbeType | null; fetchedAt: string };
export type RouterCheckResponse = { probe: RouterTunnelProbeType; resource: DetailedResource; cached: boolean; fetchedAt: string; message: string };
export type HermesHealthResponse = { telemetry: import('../server/hermes-reports.js').HermesSnapshot | null; fetchedAt: string };
export type { DesktopBootPreference };
export type DesktopBootPreferenceResponse = Omit<DesktopBootPreference, 'operationKey'>;
export type OperationsResponse = { operations: Operation[] };
export type OperationHistoryResponse = { events: DurableEvent[] };
export type OperationRequest = { resourceId: string; action: Action; confirmed?: boolean };
export type ApiError = { error: string };
export type AuthUser = { name: string; agent?: boolean; scopes?: ('read' | 'operate')[] };
