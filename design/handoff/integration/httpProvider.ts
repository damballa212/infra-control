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
import { ProviderError, type DataProvider } from "./provider.ts";
/** Same-origin cookie only. No bearer, browser storage, automatic retries or cross-origin override. */
export function createHttpProvider(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): DataProvider {
  async function request<T>(
    path: string,
    body?: object,
    key?: string,
    method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET",
  ): Promise<T> {
    if (typeof navigator !== "undefined" && !navigator.onLine)
      throw new ProviderError({ kind: "network", message: "Sin conexión" });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      path === "/api/costs" ? 120000 : 20000,
    );
    let response: Response;
    try {
      response = await fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      clearTimeout(timeout);
      throw new ProviderError({
        kind: "network",
        ambiguous: body !== undefined,
        message: "No se pudo confirmar la respuesta del panel",
      });
    }
    try {
      if (!response.ok) {
        const raw = response.headers.get("Retry-After");
        const seconds =
          raw === null
            ? undefined
            : /^\d+$/.test(raw)
              ? Number(raw)
              : Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000));
        // El arranque predeterminado devuelve mensajes del servidor ya redactados para la persona (409/503 con motivo).
        const serverMessage = path.startsWith("/api/desktop/boot-preference")
          ? await response
              .json()
              .then((value: { error?: unknown; message?: unknown }) =>
                typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : null,
              )
              .catch(() => null)
          : null;
        throw new ProviderError({
          kind: "http",
          status: response.status,
          ...(seconds !== undefined && Number.isFinite(seconds)
            ? { retryAfterSeconds: seconds }
            : {}),
          message:
            serverMessage ??
            (response.status === 401
              ? "Tu sesión terminó o las credenciales no son correctas"
              : response.status === 409
                ? "Ya hay una orden activa o la clave pertenece a otra intención"
                : response.status === 429
                  ? "Demasiados intentos. Respeta el tiempo de espera."
                  : "El panel no pudo completar la solicitud"),
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        kind: "network",
        ambiguous: body !== undefined,
        message: "La respuesta del panel no pudo leerse",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    getSession: () => request<AuthUser>("/api/auth/me"),
    login: (username, password) =>
      request<{ name: string }>("/api/auth/login", { username, password }),
    logout: async () => {
      await request("/api/auth/logout", {});
    },
    changePassword: async (current, password) => {
      await request("/api/auth/password", { current, password });
    },
    getResources: () => request<ResourcesResponse>("/api/resources"),
    getOperations: () => request<OperationsResponse>("/api/operations"),
    getOperation: (id) =>
      request<Operation>(`/api/operations/${encodeURIComponent(id)}`),
    createOperation: (body: OperationRequest, key: string) =>
      request<Operation>("/api/operations", body, key),
    getCosts: () => request<CostReport>("/api/costs"),
    getBootPreference: () =>
      request<BootPreference>("/api/desktop/boot-preference"),
    setBootPreference: (
      system: BootSystem,
      expectedVersion: number,
      key: string,
    ) =>
      request<BootPreference>(
        "/api/desktop/boot-preference",
        { system, confirmed: true, expectedVersion },
        key,
      ),
    cancelBootPreference: (expectedVersion: number) =>
      request<BootPreference>(
        "/api/desktop/boot-preference/pending",
        { expectedVersion },
        undefined,
        "DELETE",
      ),
    verifyBootPreference: () =>
      request<BootPreference>("/api/desktop/boot-preference/verify"),
  };
}
