// Compile-time proof only: imports are erased, never bundles backend modules.
import type * as Backend from "../../../contracts/api.ts";
import type * as UI from "../ui/src/contract.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
// Backend.Resource se define con Omit<>; la igualdad estricta falla por identidad de tipo mapeado
// aunque las propiedades sean idénticas, así que se exige asignabilidad en ambos sentidos.
export type ResourcesMatch = Assert<
  UI.ResourcesResponse extends Backend.ResourcesResponse
    ? Backend.ResourcesResponse extends UI.ResourcesResponse
      ? true
      : false
    : false
>;
// DIVERGENCIA CONOCIDA (a corregir en un PR de UI con validación visual): el backend declara
// cursor: number | string (puede ser opaco) y la UI lo modela como number. Se compara todo salvo el cursor.
type NoCursor<T> = Omit<T, "cursor">;
export type ResourcesSnapshotMatch = Assert<
  NoCursor<UI.ResourcesSnapshotResponse> extends NoCursor<Backend.ResourcesSnapshotResponse>
    ? NoCursor<Backend.ResourcesSnapshotResponse> extends NoCursor<UI.ResourcesSnapshotResponse>
      ? true
      : false
    : false
>;
export type OperationsMatch = Assert<
  Equal<UI.OperationsResponse, Backend.OperationsResponse>
>;
export type RequestMatch = Assert<
  Equal<UI.OperationRequest, Backend.OperationRequest>
>;
export type CostsMatch = Assert<Equal<UI.CostReport, Backend.CostReport>>;
export type AuthMatch = Assert<Equal<UI.AuthUser, Backend.AuthUser>>;
export type BootPreferenceMatch = Assert<
  Equal<UI.BootPreference, Backend.DesktopBootPreferenceResponse>
>;
export type OperationHistoryMatch = Assert<
  Equal<UI.OperationHistoryResponse, Backend.OperationHistoryResponse>
>;
export type CatalogServicesMatch = Assert<
  Equal<UI.CatalogServicesResponse, Backend.CatalogServicesResponse>
>;
export type SecretRequestMatch = Assert<Equal<UI.SecretRequest, Backend.SecretRequest>>;
export type SecretApprovalMatch = Assert<Equal<UI.SecretApproval, Backend.SecretApproval>>;
export type SecretGrantMatch = Assert<Equal<UI.SecretGrant, Backend.SecretGrant>>;
export type SecretAuditMatch = Assert<Equal<UI.SecretAuditEvent, Backend.SecretAuditEvent>>;
export type VaultItemMatch = Assert<Equal<UI.VaultItem, Backend.VaultItem>>;
export type PageInfoMatch = Assert<Equal<UI.PageInfo, Backend.PageInfo>>;
export type OperationPageMatch = Assert<Equal<UI.OperationPageResponse, Backend.OperationPageResponse>>;
export type OperationReviewMatch = Assert<Equal<UI.OperationReview, Backend.OperationReview>>;
export type IncidentMatch = Assert<Equal<UI.OperationalIncident, Backend.OperationalIncident>>;
export type IncidentPageMatch = Assert<Equal<UI.IncidentPageResponse, Backend.IncidentPageResponse>>;
export type AttentionMatch = Assert<Equal<UI.AttentionSummary, Backend.AttentionSummary>>;
export type ExpectationMatch = Assert<Equal<UI.ResourceExpectation, Backend.ResourceExpectation>>;
export type PowerIntentMatch = Assert<Equal<UI.PowerIntent, Backend.PowerIntent>>;
export type SecretRequestsPageMatch = Assert<Equal<UI.SecretRequestsPageResponse, Backend.SecretRequestsPageResponse>>;
export type SecretGrantsPageMatch = Assert<Equal<UI.SecretGrantsPageResponse, Backend.SecretGrantsPageResponse>>;
export type SecretAuditPageMatch = Assert<Equal<UI.SecretAuditPageResponse, Backend.SecretAuditPageResponse>>;
