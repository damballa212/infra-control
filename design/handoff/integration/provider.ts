// Interfaz del proveedor de datos. Codex sustituye la IMPLEMENTACIÓN (fixtureProvider -> adaptador HTTP del mismo origen);
// el árbol visual, los tokens y los componentes no cambian. Cada método documenta su endpoint real.
import type {
  AuthUser,
  BootPreference,
  BootSystem,
  CostReport,
  Operation,
  OperationRequest,
  OperationsResponse,
  ResourcesResponse,
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
  getResources(): Promise<ResourcesResponse>;
  /** GET /api/operations (hasta 100 más recientes). Lectura de SQLite, sin llamadas al proveedor. */
  getOperations(): Promise<OperationsResponse>;
  /** GET /api/operations/:id. */
  getOperation(id: string): Promise<Operation>;
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
}
