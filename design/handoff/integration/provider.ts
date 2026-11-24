// Interfaz del proveedor de datos. Codex sustituye la IMPLEMENTACIÓN (fixtureProvider -> adaptador HTTP del mismo origen);
// el árbol visual, los tokens y los componentes no cambian. Cada método documenta su endpoint real.
import type {
  AuthUser,
  BootPreference,
  BootSystem,
  CatalogServicesResponse,
  CostReport,
  Operation,
  OperationHistoryResponse,
  OperationRequest,
  PageQuery,
  OperationPageResponse,
  IncidentPageResponse,
  IncidentHistoryPageResponse,
  AttentionSummary,
  ReviewReason,
  OperationalIncident,
  ResourceExpectation,
  ResourceExpectationResponse,
  SecretRequestsPageResponse,
  SecretGrantsPageResponse,
  SecretAuditPageResponse,
  SecretRequestCountsResponse,
  PushConfig,
  PushDevice,
  PushPreferences,
  PushSubscriptionInput,
  ResourcesSnapshotResponse,
  SecretApproval,
  SecretRequest,
  SecretScope,
  VaultItem,
  SystemHealthResponse,
} from "../ui/src/contract.ts";

/** Fallo de transporte o HTTP. `ambiguous` = la solicitud pudo llegar al servidor (timeout/corte de red tras enviar). */
export class ProviderError extends Error {
  readonly kind: "network" | "http";
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly ambiguous: boolean;

  constructor(init: {
    kind: "network" | "http";
    message: string;
    status?: number;
    retryAfterSeconds?: number;
    ambiguous?: boolean;
  }) {
    super(init.message);
    this.name = "ProviderError";
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.ambiguous = init.ambiguous ?? false;
  }
}

export interface DataProvider {
  /** GET /api/auth/me. 401 => ProviderError{status:401}: la app vuelve al acceso y limpia estado privado. */
  getSession(): Promise<AuthUser>;
  /** POST /api/auth/login {username, password}. 401 credenciales, 429 tras 5 fallos/15 min (Retry-After). */
  login(username: string, password: string): Promise<{ name: string }>;
  /** POST /api/auth/logout. */
  logout(): Promise<void>;
  /** POST /api/auth/password {current, password}. Revoca todas las sesiones. 5 intentos/15 min. */
  changePassword(current: string, next: string): Promise<void>;
  /** GET /api/resources. Caché de servidor 60 s: `observedAt` de cada recurso es la verdad, no `fetchedAt`. */
  getResources(): Promise<ResourcesSnapshotResponse>;
  /** GET /api/operations. Sin argumentos conserva el límite legacy del servidor; con query usa su cursor estable. */
  getOperations(query?: PageQuery): Promise<OperationPageResponse>;
  /** GET /api/operations/active. Independiente de la ventana del historial. */
  getActiveOperations(query?: PageQuery): Promise<OperationPageResponse>;
  /** GET /api/operations/review. Revisión pendiente, independiente del resultado histórico. */
  getReviewOperations(query?: PageQuery): Promise<OperationPageResponse>;
  /** GET /api/incidents/current. Episodios actuales, incluidos estados desconocidos. */
  getCurrentIncidents(query?: PageQuery): Promise<IncidentPageResponse>;
  /** GET /api/incidents/history. Historial de episodios. */
  getIncidentHistory(query?: PageQuery): Promise<IncidentPageResponse>;
  /** GET /api/incidents/:id/history. Versiones de un episodio. */
  getIncidentVersions(id: string, query?: PageQuery): Promise<IncidentHistoryPageResponse>;
  /** GET /api/attention/summary. Conteos completos y autorizados del backend. */
  getAttentionSummary(): Promise<AttentionSummary>;
  /** POST /api/operations/:id/review. Solo decisión humana; nunca cambia el resultado de ejecución. */
  reviewOperation(id: string, expectedVersion: number, reason: ReviewReason): Promise<Operation>;
  /** POST /api/incidents/:id/acknowledgment. Reconoce el informe, sin fabricar recuperación. */
  acknowledgeIncident(id: string, expectedVersion: number): Promise<OperationalIncident>;
  /** GET /api/resources/:id/expectation. Lectura local. */
  getResourceExpectation(id: string): Promise<ResourceExpectationResponse>;
  /** PUT /api/resources/:id/expectation. Solo dueño, con control de versión. */
  putResourceExpectation(id: string, expectedVersion: number, mode: ResourceExpectation['mode']): Promise<ResourceExpectationResponse>;
  /** GET /api/operations/:id. */
  getOperation(id: string): Promise<Operation>;
  /** GET /api/operations/:id/history. Eventos durables de la orden; no consulta al proveedor. */
  getOperationHistory(id: string): Promise<OperationHistoryResponse>;
  /** GET /api/system/health. Observadores, cobertura y colas del propio panel; sin sondeos extra. */
  getSystemHealth(): Promise<SystemHealthResponse>;
  /** GET /api/catalog/services. Servicios lógicos con relaciones explícitas (nunca inferidas por nombre). */
  getCatalogServices(): Promise<CatalogServicesResponse>;
  /** GET /api/secrets/requests (solo sesión personal). 503 si el panel no tiene bóveda configurada. */
  getSecretRequests(query?: PageQuery): Promise<SecretRequestsPageResponse>;
  /** GET /api/secrets/requests/pending. Página y conteo pendientes independientes del historial. */
  getPendingSecretRequests(query?: PageQuery): Promise<SecretRequestsPageResponse>;
  /** GET /api/secrets/requests/counts. Solo sesión personal. */
  getSecretRequestCounts(): Promise<SecretRequestCountsResponse>;
  /** GET /api/secrets/requests/:id. */
  getSecretRequest(id: string): Promise<SecretRequest>;
  /** POST /api/secrets/requests/:id/approve. Pegar un valor lo guarda en la bóveda; nunca vuelve a mostrarse. */
  approveSecret(id: string, approval: SecretApproval, scope: SecretScope): Promise<SecretRequest>;
  /** POST /api/secrets/requests/:id/deny. */
  denySecret(id: string): Promise<SecretRequest>;
  /** GET /api/secrets/items. Metadatos de la colección proyecto/entorno, sin valores. */
  getSecretItems(project: string, environment: string | null): Promise<{ items: VaultItem[] }>;
  /** GET /api/secrets/grants. */
  getSecretGrants(query?: PageQuery): Promise<SecretGrantsPageResponse>;
  /** DELETE /api/secrets/grants/:id. No revoca la credencial en el proveedor. */
  revokeSecretGrant(id: string): Promise<{ revoked: boolean }>;
  /** GET /api/secrets/audit. */
  getSecretAudit(query?: PageQuery): Promise<SecretAuditPageResponse>;
  /**
   * POST /api/operations con header Idempotency-Key. HTTP 202 = aceptación; el estado real está en el objeto Operation.
   * Reusar la MISMA `idempotencyKey` solo para recuperar un envío ambiguo de la misma intención.
   */
  createOperation(
    request: OperationRequest,
    idempotencyKey: string,
  ): Promise<Operation>;
  /** GET /api/costs. Caché SQLite 24 h; nunca se fuerza refresco desde la UI. Puede tardar. */
  getCosts(): Promise<CostReport>;
  /** GET /api/desktop/boot-preference. Lee SQLite: no consulta a la PC. */
  getBootPreference(): Promise<BootPreference>;
  /**
   * POST /api/desktop/boot-preference {system, confirmed:true, expectedVersion} con Idempotency-Key.
   * 200 verificado; 202 pendiente o incierto. No enciende ni reinicia la PC.
   */
  setBootPreference(
    system: BootSystem,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<BootPreference>;
  /** DELETE /api/desktop/boot-preference/pending {expectedVersion}. Cancela una intención que aún no se aplicó. */
  cancelBootPreference(expectedVersion: number): Promise<BootPreference>;
  /** GET /api/desktop/boot-preference/verify. Lectura UEFI explícita por SSH autenticado; no escribe ni corrige. */
  verifyBootPreference(): Promise<BootPreference>;
  /** GET /api/push/config. Público: disponibilidad y clave VAPID pública, nunca credenciales. */
  getPushConfig(): Promise<PushConfig>;
  /** POST /api/push/subscriptions. Idempotente por endpoint: repetirlo devuelve el mismo dispositivo con sus preferencias. */
  registerPush(subscription: PushSubscriptionInput): Promise<PushDevice>;
  /** PUT /api/push/subscriptions/:id/preferences. */
  updatePushPreferences(id: string, preferences: PushPreferences): Promise<void>;
  /** POST /api/push/subscriptions/:id/test. Encola una prueba; no confirma que el teléfono la reciba. */
  testPush(id: string): Promise<void>;
  /** DELETE /api/push/subscriptions/:id. */
  removePush(id: string): Promise<void>;
}
