import type { Operation, OperationState, Resource } from "../contract.ts";

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

export function describeResourceState(
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

export function needsAttention(
  resource: Pick<Resource, "kind" | "state">,
): boolean {
  if (resource.state === "unconfigured") return false;
  const view = describeResourceState(resource);
  return view.tone === "unk" || view.tone === "warn" || view.tone === "bad";
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

/** Hermes es la EC2 `orchestrator`; el panel vive en otro servidor y sigue disponible al apagarla. */
export function isHermes(resource: Pick<Resource, "name">): boolean {
  return resource.name === HERMES_ID_NAME;
}

export function displayName(resource: Pick<Resource, "name">): string {
  return isHermes(resource) ? "Hermes" : resource.name;
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
