import type { DetailedResource, Operation, OperationState, Resource } from "../contract.ts";

/** El inventario incluye `health` aunque el tipo base no lo declare. */
export type ObservedResource = DetailedResource;

/** Plazo por defecto cuando la fuente no declara `freshUntil`. */
export const STALE_MS = 3 * 60 * 1000;

/** Tratamiento visual semántico. Siempre va con texto + símbolo; el color nunca basta solo. */
export type Tone = "on" | "off" | "busy" | "unk" | "warn" | "none" | "bad";
export type GlyphName =
  | "dot"
  | "square"
  | "half"
  | "threeQuarter"
  | "ring"
  | "question"
  | "bang"
  | "check"
  | "cross"
  | "ellipsis"
  | "arrowRight"
  | "arrowLeft"
  | "caretDown"
  | "bolt"
  | "info";

export interface StateView {
  label: string;
  glyph: GlyphName;
  tone: Tone;
  /** Aclaración que no debe perderse (p. ej. salud sin verificar). */
  hint: string | null;
}

function rawResourceState(
  resource: Pick<Resource, "kind" | "state">,
): StateView {
  const { kind, state } = resource;
  if (state === "unconfigured")
    return { label: "Por conectar", glyph: "ring", tone: "none", hint: null };
  if (state === "unknown")
    return { label: "Sin datos", glyph: "question", tone: "unk", hint: null };
  if (kind === "computer" && state === "asleep")
    return {
      label: "En reposo",
      glyph: "ring",
      tone: "none",
      hint: "Anunciado por el equipo; no confirma la suspensión",
    };
  if (kind === "computer" && state === "unreachable")
    return { label: "Sin señal", glyph: "question", tone: "unk", hint: "No confirma que esté apagada" };
  if (kind === "router") {
    if (state === "reporting")
      return { label: "Reportando", glyph: "dot", tone: "on", hint: null };
    if (state === "stale")
      return {
        label: "Reporte atrasado",
        glyph: "bang",
        tone: "warn",
        hint: null,
      };
  }
  if (kind === "service") {
    if (state.startsWith("exited") || state === "stopped")
      return { label: "Detenido", glyph: "square", tone: "off", hint: null };
    if (state === "running:healthy")
      return { label: "Saludable", glyph: "dot", tone: "on", hint: null };
    if (state.startsWith("running") && !state.includes("unhealthy"))
      return {
        label: "En ejecución",
        glyph: "threeQuarter",
        tone: "unk",
        hint: "Salud de la app sin verificar",
      };
    if (
      state.startsWith("exited") ||
      state.includes("unhealthy") ||
      state.startsWith("degraded")
    ) {
      return { label: "Con fallo", glyph: "cross", tone: "bad", hint: null };
    }
    return { label: "Sin datos", glyph: "question", tone: "unk", hint: null };
  }
  switch (state) {
    case "running":
      return {
        label: "Encendida",
        glyph: "dot",
        tone: "on",
        hint: kind === "ec2" ? "No verifica sus aplicaciones" : null,
      };
    case "stopped":
      return { label: "Detenida", glyph: "square", tone: "off", hint: null };
    case "pending":
      return { label: "Iniciando…", glyph: "half", tone: "busy", hint: null };
    case "stopping":
      return {
        label: "Deteniéndose…",
        glyph: "half",
        tone: "busy",
        hint: null,
      };
    default:
      return { label: "Sin datos", glyph: "question", tone: "unk", hint: null };
  }
}

/** Un estado observado antiguo no acredita disponibilidad actual. */
export function describeResourceState(
  resource: Pick<ObservedResource, "kind" | "state"> & Partial<Pick<ObservedResource, "observedAt" | "health">>,
  now = Date.now(),
): StateView {
  const view = rawResourceState(resource);
  if (view.tone === "on" && resource.observedAt !== undefined &&
    (resource.observedAt === null || resource.health?.presence?.state === "unknown" ||
      isStale({ observedAt: resource.observedAt, health: resource.health, kind: resource.kind }, now))) {
    return { label: `Último estado: ${view.label.toLocaleLowerCase("es")}`, glyph: "ring", tone: "none", hint: "Sin confirmación reciente" };
  }
  return view;
}

export interface OperationView {
  label: string;
  glyph: GlyphName;
  tone: Tone;
  /** 1..3: posición en Registrada → En curso → Resultado. */
  stage: 1 | 2 | 3;
  final: boolean;
}

const OPERATION_VIEWS: Readonly<Record<OperationState, OperationView>> = {
  accepted: {
    label: "Registrada",
    glyph: "ellipsis",
    tone: "busy",
    stage: 1,
    final: false,
  },
  running: {
    label: "En curso",
    glyph: "half",
    tone: "busy",
    stage: 2,
    final: false,
  },
  succeeded: {
    label: "Confirmada",
    glyph: "check",
    tone: "on",
    stage: 3,
    final: true,
  },
  uncertain: {
    label: "Sin confirmar",
    glyph: "question",
    tone: "warn",
    stage: 3,
    final: true,
  },
  failed: {
    label: "Falló",
    glyph: "cross",
    tone: "bad",
    stage: 3,
    final: true,
  },
};

export function describeOperation(state: OperationState): OperationView {
  return OPERATION_VIEWS[state];
}

export function isActiveOperation(
  operation: Pick<Operation, "state">,
): boolean {
  return operation.state === "accepted" || operation.state === "running";
}

export function needsReview(
  operation: Pick<Operation, "state" | "action">,
): boolean {
  return (
    operation.action !== "refresh" &&
    (operation.state === "uncertain" || operation.state === "failed")
  );
}

/** La lista `actions` es la autoridad: nunca se infiere un botón del tipo, color o nombre. */
export function can(
  resource: Pick<Resource, "actions">,
  action: Resource["actions"][number],
): boolean {
  return resource.actions.includes(action);
}

export function powerAction(
  resource: Pick<Resource, "actions">,
): "start" | "stop" | null {
  if (can(resource, "stop")) return "stop";
  if (can(resource, "start")) return "start";
  return null;
}

/** Lectura antigua: respeta `freshUntil` de la fuente; si no lo hay, usa STALE_MS sobre observedAt. */
export function isStale(
  resource: Pick<ObservedResource, "observedAt" | "health"> & Partial<Pick<ObservedResource, "kind">>,
  now: number,
): boolean {
  const presence = resource.health?.presence;
  if (presence?.state === "stale") return true;
  if (presence?.freshUntil) return !Number.isFinite(Date.parse(presence.freshUntil)) || now > Date.parse(presence.freshUntil);
  if (resource.observedAt === null) return false;
  const observed = Date.parse(resource.observedAt);
  const validity = resource.kind === "ec2" ? 20 * 60 * 1000 : resource.kind === "service" ? 4 * 60 * 1000 : resource.kind === "computer" ? 45 * 1000 : STALE_MS;
  return !Number.isFinite(observed) || observed - now > 5 * 60 * 1000 || now - observed > validity;
}

/** Salud funcional comprobada con fallo o degradación. */
export function hasServiceProblem(resource: Pick<ObservedResource, "health"> & Partial<Pick<ObservedResource, "serviceSignals" | "state" | "monitoring">>): boolean {
  if (resource.monitoring?.expectedState && resource.state && ["asleep", "stopped"].includes(resource.state)) return false;
  return [resource.health?.service, ...Object.values(resource.serviceSignals ?? {})]
    .some(signal => signal?.state === "unhealthy" || signal?.state === "degraded");
}

/**
 * Común a Inicio, filtros y detalle. Combina disponibilidad (state), salud funcional (health.service)
 * y, si se pasa `now`, frescura de la lectura. Sin `now` no se puede juzgar la frescura.
 */
export function needsAttention(
  resource: Pick<ObservedResource, "kind" | "state"> & Partial<Pick<ObservedResource, "observedAt" | "health" | "monitoring" | "serviceSignals">>,
  now?: number,
): boolean {
  if (resource.state === "unconfigured") return false;
  if (resource.monitoring?.expectedState && ["asleep", "stopped"].includes(resource.state)) return false;
  // La ausencia de un equipo personal no establece por sí sola una obligación incumplida.
  if (resource.kind === "computer") return hasServiceProblem(resource);
  const view = describeResourceState(resource, now);
  if (view.tone === "unk" || view.tone === "warn" || view.tone === "bad") return true;
  if (hasServiceProblem(resource)) return true;
  return now !== undefined && isStale({ observedAt: resource.observedAt ?? null, health: resource.health, kind: resource.kind }, now);
}

/**
 * Aplica un evento SSE `resource`: sustituye por id, o por catalogId sólo si ambos lo tienen y coinciden.
 * Un evento con observación anterior a la fila actual no la reemplaza.
 */
export function mergeResourceEvent<T extends Resource>(rows: readonly T[], resource: T): T[] {
  const catalogId = resource.catalog?.catalogId;
  const matches = (row: T) =>
    row.id === resource.id || (catalogId !== undefined && row.catalog?.catalogId === catalogId);
  const newer = (row: T) =>
    !row.observedAt || !resource.observedAt || Date.parse(resource.observedAt) >= Date.parse(row.observedAt);
  return rows.map((row) => (matches(row) && newer(row) ? resource : row));
}

export function providerOf(kind: Resource["kind"]): string {
  switch (kind) {
    case "ec2":
      return "AWS";
    case "router":
      return "el router";
    case "service":
      return "Coolify";
    case "computer":
      return "el equipo";
  }
}

export function kindLabel(resource: Pick<Resource, "kind" | "detail" | "state">): string {
  switch (resource.kind) {
    case "ec2":
      return "EC2 · AWS";
    case "router":
      return "ROUTER · ACS";
    case "service":
      return `COOLIFY · ${resource.detail.toUpperCase()}`;
    case "computer":
      return resource.state === "unconfigured" ? "EQUIPO · POR CONECTAR" : "EQUIPO · ACCESO REMOTO";
  }
}

export const HERMES_ID_NAME = "orchestrator";

export const HERMES_REPORTER_SOURCE = "hermes-systemd-reporter";

/**
 * Host que aloja Hermes: lo acredita el backend con su reporter systemd; el nombre de la EC2 queda como
 * compatibilidad legacy. Identifica el host, no prueba que el servicio Hermes esté disponible.
 */
export function isHermes(resource: Pick<ObservedResource, "name"> & Partial<Pick<ObservedResource, "health">>): boolean {
  return resource.health?.service?.source === HERMES_REPORTER_SOURCE || resource.name === HERMES_ID_NAME;
}

/** Estado del servicio lógico Hermes, separado del encendido de su EC2. */
export function hermesServiceView(resource: Pick<ObservedResource, "health">): { label: string; tone: Tone; glyph: GlyphName } {
  const signal = resource.health?.service;
  if (signal?.source !== HERMES_REPORTER_SOURCE) return { label: "Servicio sin reporte", tone: "unk", glyph: "question" };
  switch (signal.state) {
    case "healthy":
      return { label: "Servicio activo", tone: "on", glyph: "dot" };
    case "degraded":
      return { label: "Reporte atrasado", tone: "warn", glyph: "bang" };
    case "unhealthy":
      return { label: "Servicio con fallo", tone: "bad", glyph: "cross" };
    default:
      return { label: "Servicio sin reporte", tone: "unk", glyph: "question" };
  }
}

/** Nombre del host; si aloja Hermes se indica sin sustituir la identidad física. */
export function displayName(resource: Pick<ObservedResource, "name"> & Partial<Pick<ObservedResource, "health">>): string {
  return isHermes(resource) ? `${resource.name} · Hermes` : resource.name;
}

export interface ObservedAgent {
  actor: string;
  orders: number;
  lastAt: string;
}

/** Agentes vistos en el registro de órdenes: hechos observados, no un inventario de tokens o permisos. */
export function observedAgents(operations: readonly Pick<Operation, "actor" | "updatedAt">[]): ObservedAgent[] {
  const byActor = new Map<string, ObservedAgent>();
  for (const o of operations) {
    if (o.actor === "admin") continue;
    const prev = byActor.get(o.actor);
    const lastAt = prev && Date.parse(prev.lastAt) > Date.parse(o.updatedAt) ? prev.lastAt : o.updatedAt;
    byActor.set(o.actor, { actor: o.actor, orders: (prev?.orders ?? 0) + 1, lastAt });
  }
  return [...byActor.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

export function actorLabel(actor: string): {
  who: string;
  long: string;
  agent: boolean;
} {
  const agent = actor !== "admin";
  if (!agent) return { who: "Admin", long: "ORDEN DE ADMIN", agent };
  const name = actor === "hermes" ? "Hermes" : actor;
  return {
    who: `${name} · agente`,
    long: `ORDEN DE ${name.toUpperCase()} (AGENTE)`,
    agent,
  };
}

export function operationTitle(
  operation: Pick<Operation, "action" | "resourceName">,
  kind: Resource["kind"] | null,
): string {
  const verb =
    operation.action === "stop"
      ? "Apagar"
      : operation.action === "boot-windows"
        ? "Reiniciar en Windows"
        : operation.action === "boot-cachyos"
          ? "Reiniciar en CachyOS"
          : operation.action === "start"
        ? "Encender"
        : kind === "router"
          ? "Leer"
          : "Consultar";
  return `${verb} ${operation.resourceName}`;
}

const EXPECTED_STATE: Partial<Record<Operation["action"], string>> = { start: "running", stop: "stopped" };

/**
 * Órdenes fallidas o inciertas que siguen pidiendo revisión, la más reciente por recurso.
 * Sólo se dan por reconciliadas con evidencia: una orden posterior de la misma acción confirmada, o una
 * transición observada (stateChangedAt) posterior hacia el estado que la orden buscaba. Ni una lectura
 * cualquiera ni el paso del tiempo resuelven una orden ambigua.
 */
export function unresolvedOrders(
  operations: readonly Operation[],
  resources: readonly Pick<Resource, "id" | "state" | "stateChangedAt">[],
): Operation[] {
  const reconciled = (o: Operation) => {
    const orderAt = Date.parse(o.updatedAt);
    const confirmedLater = operations.some(
      (n) => n.resourceId === o.resourceId && n.action === o.action && n.state === "succeeded" && Date.parse(n.updatedAt) > orderAt,
    );
    if (confirmedLater) return true;
    const target = resources.find((r) => r.id === o.resourceId);
    const expected = EXPECTED_STATE[o.action];
    return Boolean(
      target && expected && target.state === expected && target.stateChangedAt && Date.parse(target.stateChangedAt) > orderAt,
    );
  };
  const pending = operations
    .filter((o) => needsReview(o) && !reconciled(o))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return pending.filter((o, i) => pending.findIndex((n) => n.resourceId === o.resourceId) === i);
}
