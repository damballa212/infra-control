// Proveedor de datos de PROTOTIPO. Simula el ciclo de vida de las órdenes (accepted → running → resultado) con
// temporizadores; nunca toca AWS, ACS, Coolify ni la red. Codex lo sustituye por el adaptador HTTP real
// (ver integration/MAPPING.md) implementando la misma interfaz `DataProvider`.
import type {
  AuthUser,
  BootPreference,
  BootSystem,
  CostReport,
  Operation,
  OperationRequest,
  OperationsResponse,
  Resource,
  ResourcesResponse,
} from "../ui/src/contract.ts";
import {
  makeCosts,
  makeOperations,
  makeResources,
} from "../states/fixtures.ts";
import { getScenario, type Scenario } from "../states/scenarios.ts";
import { ProviderError, type DataProvider } from "./provider.ts";

export interface FixtureProviderOptions {
  scenarioId?: string | null;
  /** Ancla temporal (por defecto Date.now()). Las capturas congelan el reloj para que sea determinista. */
  anchorMs?: number;
  /** Latencia simulada de cada llamada. */
  latencyMs?: number;
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
  let operations: Operation[] = config.operations(
    makeOperations(anchor),
    anchor,
  );
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

  const nowIso = (): string => new Date().toISOString();
  const requireSession = (): void => {
    if (!signedIn)
      throw new ProviderError({
        kind: "http",
        status: 401,
        message: "Sesión caducada",
      });
  };

  function patchOperation(id: string, patch: Partial<Operation>): void {
    operations = operations.map((operation) =>
      operation.id === id
        ? { ...operation, ...patch, updatedAt: nowIso() }
        : operation,
    );
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

    async getResources(): Promise<ResourcesResponse> {
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
      };
    },

    async getOperations(): Promise<OperationsResponse> {
      await delay(latency);
      requireSession();
      return { operations: operations.map((operation) => ({ ...operation })) };
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
      return { ...found };
    },

    async createOperation(
      request: OperationRequest,
      idempotencyKey: string,
    ): Promise<Operation> {
      await delay(latency);
      requireSession();
      const previous = keyToOperation.get(idempotencyKey);
      if (previous !== undefined)
        return {
          ...(operations.find((operation) => operation.id === previous.id) ??
            previous),
        };
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
      return { ...created };
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
