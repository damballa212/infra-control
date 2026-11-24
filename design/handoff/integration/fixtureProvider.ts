// Proveedor de datos de PROTOTIPO. Simula el ciclo de vida de las órdenes (accepted → running → resultado) con
// temporizadores; nunca toca AWS, ACS, Coolify ni la red. Codex lo sustituye por el adaptador HTTP real
// (ver integration/MAPPING.md) implementando la misma interfaz `DataProvider`.
import type {
  AuthUser,
  BootPreference,
  BootSystem,
  PushDevice,
  PushPreferences,
  CatalogServicesResponse,
  CostReport,
  Operation,
  OperationHistoryEvent,
  OperationHistoryResponse,
  OperationRequest,
  Resource,
  ResourcesSnapshotResponse,
  SecretApproval,
  SecretAuditEvent,
  SecretGrant,
  SecretRequest,
  SecretScope,
  SystemHealthResponse,
  VaultItem,
} from "../ui/src/contract.ts";
import {
  makeCosts,
  makeOperations,
  makeResources,
  makeSecretRequests,
  makeServices,
} from "../states/fixtures.ts";
import { getScenario, type Scenario } from "../states/scenarios.ts";
import { ProviderError, type DataProvider } from "./provider.ts";
import { createFixtureCollections, type FixtureCollectionSeed } from './fixtureCollections.ts';

export interface FixtureProviderOptions {
  scenarioId?: string | null;
  /** Ancla temporal (por defecto Date.now()). Las capturas congelan el reloj para que sea determinista. */
  anchorMs?: number;
  /** Latencia simulada de cada llamada. */
  latencyMs?: number;
  /** Datos explícitos de prototipo para probar colecciones; nunca se consultan proveedores externos. */
  data?: FixtureCollectionSeed;
}

const POWER_DONE_MS = 7000;
const REFRESH_DONE_MS = 3600;
const RUNNING_AFTER_MS = 1400;

function delay(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function createFixtureProvider(
  options: FixtureProviderOptions = {},
): DataProvider {
  const scenario: Scenario = getScenario(options.scenarioId);
  const config = scenario.config;
  const anchor = options.anchorMs ?? Date.now();
  const latency = options.latencyMs ?? 120;

  let signedIn = config.session === "authed";
  let resources: Resource[] = config.resources(makeResources(anchor), anchor);
  let operations: Operation[] = structuredClone(options.data?.operations ?? config.operations(makeOperations(anchor), anchor));
  let resourcesCalls = 0;
  const keyToOperation = new Map<string, Operation>();
  // Arranque predeterminado del prototipo: el firmware dice CachyOS, verificado. Cada cambio sube la versión.
  let boot: BootPreference = {
    desired: "cachyos",
    effective: "cachyos",
    state: "applied",
    version: 1,
    observedAt: new Date(anchor).toISOString(),
    verifiedAt: new Date(anchor).toISOString(),
  };
  const bootKeys = new Map<string, BootPreference>();
  const defaultPushPreferences: PushPreferences = { operations: true, devices: true, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true };
  let push: { device: PushDevice | null } = { device: null };

  const nowIso = (): string => new Date().toISOString();
  const requireSession = (): void => {
    if (!signedIn)
      throw new ProviderError({
        kind: "http",
        status: 401,
        message: "Sesión caducada",
      });
  };

  // Secretos de prototipo: la fixture nunca guarda ni devuelve valores.
  let secretRequests: SecretRequest[] = structuredClone(options.data?.requests ?? makeSecretRequests(anchor));
  let secretGrants: SecretGrant[] = structuredClone(options.data?.grants ?? []);
  let secretAudit: SecretAuditEvent[] = structuredClone(options.data?.audit ?? secretRequests.map((r, i) => ({ id: i + 1, at: r.createdAt, requestId: r.id, event: 'created', actor: r.agent })));
  const secretItems: VaultItem[] = [
    { itemRef: "item-fixture-1", name: "OPENAI_API_KEY", updatedAt: new Date(anchor - 5 * 86400_000).toISOString() },
  ];
  const patchSecret = (id: string, patch: Partial<SecretRequest>): SecretRequest => {
    operational.expireRequests();
    const found = secretRequests.find((r) => r.id === id);
    if (!found) throw new ProviderError({ kind: "http", status: 404, message: "Solicitud no encontrada" });
    if (found.state !== "pending") throw new ProviderError({ kind: "http", status: 409, message: "La solicitud ya no está pendiente." });
    const next = { ...found, ...patch };
    secretRequests = secretRequests.map((r) => (r.id === id ? next : r));
    return next;
  };

  const operational = createFixtureCollections({
    seed: options.data,
    ready: async () => { await delay(latency); requireSession(); },
    resources: () => resources,
    operations: () => operations,
    requests: () => secretRequests,
    setRequests: value => { secretRequests = value; },
    grants: () => secretGrants,
    audit: () => secretAudit,
    setAudit: value => { secretAudit = value; },
    record: value => recordHistory(value, nowIso()),
  });

  // Historial simulado: las órdenes iniciales tienen registro y resultado; las nuevas añaden cada cambio.
  let history: OperationHistoryEvent[] = [];
  let historyId = 0;
  function recordHistory(operation: Operation, at: string): void {
    historyId += 1;
    history = [...history, { id: historyId, type: "operation", aggregateId: `operation:${operation.id}`, payload: { ...operation }, createdAt: at }];
  }
  for (const operation of operations) {
    recordHistory({ ...operation, state: "accepted", message: "Orden registrada.", updatedAt: operation.createdAt }, operation.createdAt);
    if (operation.state !== "accepted") recordHistory(operation, operation.updatedAt);
  }

  function patchOperation(id: string, patch: Partial<Operation>): void {
    operations = operations.map((operation) =>
      operation.id === id
        ? { ...operation, ...patch, updatedAt: nowIso() }
        : operation,
    );
    const patched = operations.find((operation) => operation.id === id);
    operational.observe();
    if (patched) recordHistory(operational.decorate(patched), patched.updatedAt);
  }

  function applyPowerResult(request: OperationRequest): void {
    resources = resources.map((resource) => {
      if (resource.id !== request.resourceId) return resource;
      const next =
        request.action === "stop"
          ? {
              state: "stopped",
              actions: ["start", "refresh"] as Resource["actions"],
            }
          : {
              state: "running",
              actions: ["stop", "refresh"] as Resource["actions"],
            };
      return { ...resource, ...next, observedAt: nowIso() };
    });
  }

  function simulateLifecycle(
    operation: Operation,
    request: OperationRequest,
  ): void {
    const power = request.action !== "refresh";
    globalThis.setTimeout(
      () =>
        patchOperation(operation.id, {
          state: "running",
          message: power
            ? "Orden enviada. El panel comprueba AWS cada 15 s, hasta 3 min."
            : "Consultando. Se respeta la caché compartida de 60 s.",
        }),
      RUNNING_AFTER_MS,
    );
    globalThis.setTimeout(
      () => {
        const outcome = power ? config.powerOutcome : "succeeded";
        if (outcome === "succeeded" && power) applyPowerResult(request);
        const messages: Record<Operation["state"], string> = {
          accepted: operation.message,
          running: operation.message,
          succeeded:
            request.action === "stop"
              ? "AWS confirmó la instancia detenida."
              : request.action === "start"
                ? "AWS confirmó la instancia encendida. La salud de sus aplicaciones no se ha comprobado."
                : "Estado consultado. Se respeta la caché compartida de 60 s.",
          uncertain:
            "AWS no confirmó la recepción de la orden. Comprueba el estado antes de repetir.",
          failed:
            "El panel no completó ni verificó la orden. Comprueba el estado antes de decidir otra acción.",
        };
        patchOperation(operation.id, {
          state: outcome,
          message: messages[outcome],
        });
      },
      power ? POWER_DONE_MS : REFRESH_DONE_MS,
    );
  }

  return {
    ...operational.methods,
    async getSession(): Promise<AuthUser> {
      await delay(latency);
      requireSession();
      return { name: "Admin" };
    },

    async login(
      _username: string,
      _password: string,
    ): Promise<{ name: string }> {
      await delay(latency);
      if (config.login === "rate-limited") {
        throw new ProviderError({
          kind: "http",
          status: 429,
          retryAfterSeconds: 900,
          message: "Demasiados intentos",
        });
      }
      if (config.login === "bad-credentials") {
        throw new ProviderError({
          kind: "http",
          status: 401,
          message: "Usuario o contraseña incorrectos",
        });
      }
      signedIn = true;
      return { name: "Admin" };
    },

    async logout(): Promise<void> {
      await delay(latency);
      signedIn = false;
    },

    async changePassword(_current: string, _next: string): Promise<void> {
      await delay(latency);
      requireSession();
      if (config.changePassword === "bad-current")
        throw new ProviderError({
          kind: "http",
          status: 401,
          message: "La contraseña actual no es correcta",
        });
      if (config.changePassword === "rate-limited")
        throw new ProviderError({
          kind: "http",
          status: 429,
          retryAfterSeconds: 900,
          message: "Demasiados intentos",
        });
      signedIn = false;
    },

    async getResources(): Promise<ResourcesSnapshotResponse> {
      resourcesCalls += 1;
      await delay(config.resourcesLatencyMs[resourcesCalls] ?? latency);
      const failure = config.resourcesFailure;
      if (failure !== null && resourcesCalls >= failure.fromCall) {
        if (failure.error.status === 401) signedIn = false;
        throw new ProviderError(failure.error);
      }
      requireSession();
      return {
        resources: resources.map((resource) => ({ ...resource })),
        fetchedAt: nowIso(),
        refreshSeconds: 60,
        cursor: 0,
      };
    },

    async getOperationHistory(id: string): Promise<OperationHistoryResponse> {
      await delay(latency);
      requireSession();
      return { events: history.filter((event) => event.aggregateId === `operation:${id}`) };
    },

    async getSystemHealth(): Promise<SystemHealthResponse> {
      await delay(latency);
      requireSession();
      const now = nowIso();
      const stale = resources.filter((r) => !r.observedAt || Date.parse(now) - Date.parse(r.observedAt) > 20 * 60_000).length;
      return {
        panel: { state: "healthy", observedAt: now, eventStreams: 1 },
        catalog: { resources: resources.length, observed: resources.filter((r) => r.observedAt !== null).length, stale, scopes: 4, healthyScopes: 3, failedScopes: 0, partialScopes: 1 },
        operations: {
          visible: operations.length,
          active: operations.filter((o) => o.state === "accepted" || o.state === "running").length,
          uncertain: operations.filter((o) => o.state === "uncertain").length,
          failed: operations.filter((o) => o.state === "failed").length,
        },
        cloud: { enabled: true, state: "healthy", lastCompletedAt: now, consecutiveFailures: 0, resourcesObserved: resources.filter((r) => r.kind === "ec2" && r.observedAt).length, unknownResources: resources.filter((r) => r.state === "unknown").length },
      };
    },

    async getSecretRequest(id: string): Promise<SecretRequest> {
      await delay(latency);
      requireSession();
      operational.expireRequests();
      const found = secretRequests.find((r) => r.id === id);
      if (!found) throw new ProviderError({ kind: "http", status: 404, message: "Solicitud no encontrada" });
      return found;
    },

    async approveSecret(id: string, approval: SecretApproval, scope: SecretScope): Promise<SecretRequest> {
      await delay(latency);
      requireSession();
      if (approval.mode === "paste" && !approval.value.trim())
        throw new ProviderError({ kind: "http", status: 400, message: "El valor debe ser una sola línea de hasta 8 KB." });
      const at = new Date().toISOString();
      const next = patchSecret(id, { state: "approved", scope, decidedAt: at });
      secretAudit = [...secretAudit, { id: secretAudit.length + 1, at, requestId: id, event: "approved", actor: "Admin" }];
      if (scope !== "once")
        secretGrants = [...secretGrants, { id: `grant-${secretGrants.length + 1}`, agent: next.agent, machine: next.machine, project: next.project, environment: next.environment, name: next.name, scope, createdAt: at }];
      return next;
    },

    async denySecret(id: string): Promise<SecretRequest> {
      await delay(latency);
      requireSession();
      const at = new Date().toISOString();
      const next = patchSecret(id, { state: "denied", decidedAt: at });
      secretAudit = [...secretAudit, { id: secretAudit.length + 1, at, requestId: id, event: "denied", actor: "Admin" }];
      return next;
    },

    async getSecretItems(_project: string, _environment: string | null): Promise<{ items: VaultItem[] }> {
      await delay(latency);
      requireSession();
      return { items: secretItems };
    },

    async revokeSecretGrant(id: string): Promise<{ revoked: boolean }> {
      await delay(latency);
      requireSession();
      return operational.revokeGrant(id);
    },

    async getCatalogServices(): Promise<CatalogServicesResponse> {
      await delay(latency);
      requireSession();
      return { services: makeServices(anchor), fetchedAt: nowIso() };
    },

    async getOperation(id: string): Promise<Operation> {
      await delay(latency);
      requireSession();
      const found = operations.find((operation) => operation.id === id);
      if (found === undefined)
        throw new ProviderError({
          kind: "http",
          status: 404,
          message: "La orden no existe",
        });
      return operational.decorate(found);
    },

    async createOperation(
      request: OperationRequest,
      idempotencyKey: string,
    ): Promise<Operation> {
      await delay(latency);
      requireSession();
      const previous = keyToOperation.get(idempotencyKey);
      if (previous !== undefined)
        return operational.decorate(operations.find(operation => operation.id === previous.id) ?? previous);
      if (config.createOperation === "conflict") {
        throw new ProviderError({
          kind: "http",
          status: 409,
          message: "Ya hay una orden activa para este equipo",
        });
      }
      const target = resources.find(
        (resource) => resource.id === request.resourceId,
      );
      if (target === undefined || !target.actions.includes(request.action)) {
        throw new ProviderError({
          kind: "http",
          status: 400,
          message: "Acción no disponible para este equipo",
        });
      }
      if (request.action !== "refresh" && request.confirmed !== true) {
        throw new ProviderError({
          kind: "http",
          status: 400,
          message: "La orden de energía requiere confirmación",
        });
      }
      const created: Operation = {
        id: `op_${Math.random().toString(36).slice(2, 8)}`,
        resourceId: target.id,
        resourceName: target.name,
        action: request.action,
        actor: "admin",
        state: "accepted",
        message:
          "El panel registró la orden. Aún no se ha enviado al proveedor.",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      operations = [created, ...operations];
      recordHistory(created, created.createdAt);
      keyToOperation.set(idempotencyKey, created);
      simulateLifecycle(created, request);
      if (config.createOperation === "ambiguous") {
        // La orden SÍ llegó al servidor, pero la respuesta se perdió: reenviar la MISMA clave devuelve esta orden.
        throw new ProviderError({
          kind: "network",
          ambiguous: true,
          message: "Se perdió la conexión después de enviar la orden",
        });
      }
      return operational.decorate(created);
    },

    async getPushConfig() {
      await delay(latency);
      return { enabled: true, vapidPublicKey: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    },
    async registerPush(): Promise<PushDevice> {
      await delay(latency);
      requireSession();
      push = { ...push, device: push.device ?? { id: "00000000-0000-4000-8000-000000000001", createdAt: nowIso(), lastSuccessAt: null, preferences: defaultPushPreferences } };
      return { ...push.device! };
    },
    async updatePushPreferences(_id: string, preferences: PushPreferences): Promise<void> {
      await delay(latency);
      requireSession();
      if (push.device) push = { ...push, device: { ...push.device, preferences } };
    },
    async testPush(): Promise<void> {
      await delay(latency);
      requireSession();
    },
    async removePush(): Promise<void> {
      await delay(latency);
      requireSession();
      push = { device: null };
    },

    async getBootPreference(): Promise<BootPreference> {
      await delay(latency);
      requireSession();
      return { ...boot };
    },

    async setBootPreference(
      system: BootSystem,
      expectedVersion: number,
      idempotencyKey: string,
    ): Promise<BootPreference> {
      await delay(latency * 3);
      requireSession();
      const replay = bootKeys.get(idempotencyKey);
      if (replay !== undefined) return { ...replay };
      if (expectedVersion !== boot.version)
        throw new ProviderError({
          kind: "http",
          status: 409,
          message:
            "La preferencia cambió desde la última lectura. Actualiza el estado antes de volver a elegir.",
        });
      boot = {
        desired: system,
        effective: system,
        state: "applied",
        version: boot.version + 1,
        observedAt: nowIso(),
        verifiedAt: nowIso(),
        message: `Firmware verificó ${system === "windows" ? "Windows" : "CachyOS"} como predeterminado. La PC no se reinició.`,
      };
      bootKeys.set(idempotencyKey, { ...boot });
      return { ...boot };
    },

    async cancelBootPreference(expectedVersion: number): Promise<BootPreference> {
      await delay(latency);
      requireSession();
      if (expectedVersion !== boot.version || boot.state !== "pending")
        throw new ProviderError({
          kind: "http",
          status: 409,
          message: "Ya no hay un cambio pendiente que cancelar.",
        });
      boot = { ...boot, desired: boot.effective, state: "applied", version: boot.version + 1 };
      return { ...boot };
    },

    async verifyBootPreference(): Promise<BootPreference> {
      await delay(latency * 4);
      requireSession();
      boot = { ...boot, observedAt: nowIso(), verifiedAt: nowIso() };
      return { ...boot };
    },

    async getCosts(): Promise<CostReport> {
      if (config.costsPending) return new Promise<CostReport>(() => undefined);
      await delay(latency * 2);
      requireSession();
      return config.costs(makeCosts(anchor), anchor);
    },
  };
}
