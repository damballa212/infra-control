import type { CatalogScopeRecord } from './catalog.js';
export function scopeObservationFresh(scope: CatalogScopeRecord, now: number): boolean {
  if (!scope.lastSuccessAt) return false;
  const age = now - Date.parse(scope.lastSuccessAt);
  if (!Number.isFinite(age)) return false;
  if (scope.scopeKey.startsWith('host:')) return age >= -5000 && age < 180_000;
  return age >= -300_000 && age <= (scope.scopeKey.startsWith('coolify:') ? 240_000 : 1_200_000);
}
