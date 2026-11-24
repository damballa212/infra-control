import type { AuthUser, BootPreference, BootSystem, CatalogServicesResponse, CostReport, Operation, OperationHistoryResponse, OperationRequest, PageQuery, OperationPageResponse, IncidentPageResponse, IncidentHistoryPageResponse, AttentionSummary, OperationalIncident, ResourceExpectationResponse, SecretRequestsPageResponse, SecretGrantsPageResponse, SecretAuditPageResponse, SecretRequestCountsResponse, PushConfig, PushDevice, ResourcesSnapshotResponse, SecretApproval, SecretRequest, SecretScope, VaultItem, SystemHealthResponse } from "../ui/src/contract.ts";
function withPageQuery(path: string, query?: PageQuery): string {
  const params = new URLSearchParams();
  for (const key of ['limit', 'cursor', 'q', 'actor', 'state', 'type', 'resourceId', 'view'] as const) {
    const value = query?.[key];
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}
import { ProviderError, type DataProvider } from "./provider.ts";
/** Cookies del mismo origen. Sin almacenamiento, redirects ni reintentos automáticos. */
export function createHttpProvider(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): DataProvider {
  async function request<T>(path: string, body?: object, key?: string, method: "GET" | "POST" | "PUT" | "DELETE" = body ? "POST" : "GET"): Promise<T> {
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new ProviderError({ kind: "network", message: "Sin conexión" });
    const mutation = method !== "GET";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), path === "/api/costs" ? 120000 : path.startsWith("/api/secrets/") ? 90000 : 20000);
    let response: Response;
    try {
      response = await fetcher(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      clearTimeout(timeout);
      throw new ProviderError({ kind: "network", ambiguous: mutation, message: "No se pudo confirmar la respuesta del panel" });
    }
    try {
      if (!response.ok) {
        const raw = response.headers.get("Retry-After");
        const seconds = raw === null ? undefined : /^\d+$/.test(raw) ? Number(raw) : Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000));
        const serverMessage = path.startsWith("/api/desktop/boot-preference") || path.startsWith("/api/push/") || path.startsWith("/api/secrets/")
          ? await response.json().then((value: { error?: unknown; message?: unknown }) => typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : null).catch(() => null) : null;
        // Un 5xx puede producirse después de aplicar la mutación, también en un gateway.
        // Los rechazos 4xx conocidos mantienen su semántica y Retry-After.
        throw new ProviderError({ kind: "http", status: response.status, ambiguous: mutation && response.status >= 500, ...(seconds !== undefined && Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}), message: serverMessage ?? (response.status === 401 ? "Tu sesión terminó o las credenciales no son correctas" : response.status === 409 ? "Ya hay una orden activa o la clave pertenece a otra intención" : response.status === 429 ? "Demasiados intentos. Respeta el tiempo de espera." : "El panel no pudo completar la solicitud") });
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ kind: "network", ambiguous: mutation, message: "La respuesta del panel no pudo leerse" });
    } finally { clearTimeout(timeout); }
  }
  return {
    getSession: () => request<AuthUser>("/api/auth/me"),
    login: (username, password) => request<{ name: string }>("/api/auth/login", { username, password }),
    logout: async () => { await request("/api/auth/logout", {}); },
    changePassword: async (current, password) => { await request("/api/auth/password", { current, password }); },
    getResources: () => request<ResourcesSnapshotResponse>("/api/resources"),
    getOperations: query => request<OperationPageResponse>(withPageQuery('/api/operations', query)),
    getActiveOperations: query => request<OperationPageResponse>(withPageQuery('/api/operations/active', query)),
    getReviewOperations: query => request<OperationPageResponse>(withPageQuery('/api/operations/review', query)),
    getCurrentIncidents: query => request<IncidentPageResponse>(withPageQuery('/api/incidents/current', query)),
    getIncidentHistory: query => request<IncidentPageResponse>(withPageQuery('/api/incidents/history', query)),
    getIncidentVersions: (id, query) => request<IncidentHistoryPageResponse>(withPageQuery(`/api/incidents/${encodeURIComponent(id)}/history`, query)),
    getAttentionSummary: () => request<AttentionSummary>('/api/attention/summary'),
    reviewOperation: (id, expectedVersion, reason) => request<Operation>(`/api/operations/${encodeURIComponent(id)}/review`, { expectedVersion, reason }),
    acknowledgeIncident: (id, expectedVersion) => request<OperationalIncident>(`/api/incidents/${encodeURIComponent(id)}/acknowledgment`, { expectedVersion }),
    getResourceExpectation: id => request<ResourceExpectationResponse>(`/api/resources/${encodeURIComponent(id)}/expectation`),
    putResourceExpectation: (id, expectedVersion, mode) => request<ResourceExpectationResponse>(`/api/resources/${encodeURIComponent(id)}/expectation`, { expectedVersion, mode }, undefined, 'PUT'),
    getOperation: id => request<Operation>(`/api/operations/${encodeURIComponent(id)}`),
    getOperationHistory: id => request<OperationHistoryResponse>(`/api/operations/${encodeURIComponent(id)}/history`),
    getSystemHealth: () => request<SystemHealthResponse>("/api/system/health"),
    getSecretRequests: query => request<SecretRequestsPageResponse>(withPageQuery('/api/secrets/requests', query)),
    getPendingSecretRequests: query => request<SecretRequestsPageResponse>(withPageQuery('/api/secrets/requests/pending', query)),
    getSecretRequestCounts: () => request<SecretRequestCountsResponse>('/api/secrets/requests/counts'),
    getSecretRequest: id => request<SecretRequest>(`/api/secrets/requests/${encodeURIComponent(id)}`),
    approveSecret: (id: string, approval: SecretApproval, scope: SecretScope) => request<SecretRequest>(`/api/secrets/requests/${encodeURIComponent(id)}/approve`, { approval, scope }),
    denySecret: id => request<SecretRequest>(`/api/secrets/requests/${encodeURIComponent(id)}/deny`, {}),
    getSecretItems: (project, environment) => request<{ items: VaultItem[] }>(`/api/secrets/items?project=${encodeURIComponent(project)}${environment ? `&environment=${encodeURIComponent(environment)}` : ""}`),
    getSecretGrants: query => request<SecretGrantsPageResponse>(withPageQuery('/api/secrets/grants', query)),
    revokeSecretGrant: id => request<{ revoked: boolean }>(`/api/secrets/grants/${encodeURIComponent(id)}`, undefined, undefined, "DELETE"),
    getSecretAudit: query => request<SecretAuditPageResponse>(withPageQuery('/api/secrets/audit', query)),
    getCatalogServices: () => request<CatalogServicesResponse>("/api/catalog/services"),
    createOperation: (body: OperationRequest, key: string) => request<Operation>("/api/operations", body, key),
    getCosts: () => request<CostReport>("/api/costs"),
    getBootPreference: () => request<BootPreference>("/api/desktop/boot-preference"),
    setBootPreference: (system: BootSystem, expectedVersion: number, key: string) => request<BootPreference>("/api/desktop/boot-preference", { system, confirmed: true, expectedVersion }, key),
    cancelBootPreference: expectedVersion => request<BootPreference>("/api/desktop/boot-preference/pending", { expectedVersion }, undefined, "DELETE"),
    verifyBootPreference: () => request<BootPreference>("/api/desktop/boot-preference/verify"),
    getPushConfig: () => request<PushConfig>("/api/push/config"),
    registerPush: subscription => request<PushDevice>("/api/push/subscriptions", subscription),
    updatePushPreferences: async (id, preferences) => { await request(`/api/push/subscriptions/${encodeURIComponent(id)}/preferences`, preferences, undefined, "PUT"); },
    testPush: async id => { await request(`/api/push/subscriptions/${encodeURIComponent(id)}/test`, {}); },
    removePush: async id => { await request(`/api/push/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, "DELETE"); },
  };
}
