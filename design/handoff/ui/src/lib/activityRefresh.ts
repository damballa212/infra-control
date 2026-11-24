import { useEffect } from "react";
import type { DetailedResource, Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { operationCanAdvance } from "./liveState.ts";

/** useRead conserva exclusión, pausa, reanudación y Retry-After. El temporizador solo solicita otra lectura tras un éxito. */
export function useOperationalRefresh(read: { data: unknown; error: unknown; loading: boolean; refresh: () => void }, interval: number, enabled = true) {
  const { online, visible } = useAppState();
  const { data, error, loading, refresh } = read;
  useEffect(() => {
    if (!enabled || !online || !visible || loading || error || data === null) return;
    const timer = window.setTimeout(refresh, interval);
    return () => window.clearTimeout(timer);
  }, [data, error, loading, refresh, interval, enabled, online, visible]);
  useEffect(() => {
    const changed = () => { if (enabled && online && visible) refresh(); };
    window.addEventListener('infra:operation-review', changed);
    window.addEventListener('infra:operational-change', changed);
    return () => { window.removeEventListener('infra:operation-review', changed); window.removeEventListener('infra:operational-change', changed); };
  }, [refresh, enabled, online, visible]);
}

export function operationResource(operation: Operation | null | undefined, resources: readonly DetailedResource[]): DetailedResource | undefined {
  if (!operation) return undefined;
  const ids = new Set([operation.resourceId, operation.review?.canonicalResourceId]);
  return resources.find(resource => ids.has(resource.id) || !!resource.catalog && ids.has(`catalog:${resource.catalog.catalogId}`));
}

/** La copia compartida (SSE/lector) puede ir por delante de la página; nunca se retrocede de estado ni de revisión. */
export function displayedOperation(operation: Operation, shared?: Operation): Operation {
  let value = shared && operationCanAdvance(operation, shared) ? shared : operation;
  const review = shared?.review && (!operation.review || shared.review.version > operation.review.version) ? shared.review : operation.review;
  if (review && (!value.review || review.version > value.review.version)) value = { ...value, review };
  return value;
}
