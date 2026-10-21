// Compile-time proof only: imports are erased, never bundles backend modules.
import type * as Backend from "../../../contracts/api.ts";
import type * as UI from "../ui/src/contract.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type ResourcesMatch = Assert<
  Equal<UI.ResourcesResponse, Backend.ResourcesResponse>
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
