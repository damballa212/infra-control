// Presentación humana de capacidades que el backend ya expone (evaluación 2026-11-11, «Añadir con prioridad»).
// Todo dato llega con etiqueta en español; los códigos crudos solo aparecen en «Datos técnicos».
import type {
  Action,
  CatalogServiceRecord,
  DetailedResource,
  HostMetricsSnapshot,
  Operation,
  OperationHistoryEvent,
  OperationState,
  ResourceHealth,
} from "../contract.ts";
import type { Tone } from "./status.ts";

const SIGNAL_LABELS: Readonly<Record<keyof ResourceHealth, string>> = {
  presence: "Presencia",
  control: "Control remoto",
  service: "Salud de la app",
  telemetry: "Métricas",
  tunnel: "Túnel",
  cwmp: "Gestión ACS",
  wanLink: "Enlace WAN",
  internetProbe: "Prueba de Internet",
};
const SIGNAL_ORDER = Object.keys(SIGNAL_LABELS) as (keyof ResourceHealth)[];

const STATE_VIEWS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  fresh: { label: "Al día", tone: "on" },
  stale: { label: "Atrasada", tone: "warn" },
  available: { label: "Disponible", tone: "on" },
  healthy: { label: "Saludable", tone: "on" },
  degraded: { label: "Degradada", tone: "warn" },
  unavailable: { label: "No disponible", tone: "bad" },
  unhealthy: { label: "Con fallo", tone: "bad" },
  unknown: { label: "Sin comprobar", tone: "unk" },
};

const REASONS: Readonly<Record<string, string>> = {
  application_health_not_probed: "La salud de la app no se comprueba",
  command_path_not_probed: "El canal de órdenes no se ha probado en esta lectura",
  connection_unavailable: "La conexión con el proveedor no está disponible",
  control_not_confirmed: "El control remoto no está confirmado",
  device_offline: "El equipo no está en línea",
  identity_confirmed: "Identidad del equipo confirmada",
  identity_not_confirmed: "La identidad del equipo no está confirmada",
  identity_unverified: "En línea, pero sin identidad verificada",
  no_hermes_report: "Hermes no ha enviado reportes",
  no_observation: "Aún no hay observación",
  not_in_legacy_allowlist: "Este panel no tiene permiso para controlarlo",
  not_measured: "No se mide",
  observation_stale: "La última lectura es antigua; consulta antes de actuar",
  probe_not_run: "La sonda aún no se ha ejecutado",
  probe_result_stale: "El resultado de la sonda es antiguo",
  probe_target_unobserved: "El destino de la sonda no se ha observado",
  resource_not_active: "El recurso no aparece activo en el último barrido",
  router_check_failed: "La última comprobación falló",
  router_check_succeeded: "La última comprobación fue correcta",
  scope_unavailable: "La cuenta o región no se pudo leer",
  stale_event: "El último aviso es antiguo",
  telemetry_not_received: "No llegan métricas",
  telemetry_stale: "Las métricas están atrasadas",
  transition_in_progress: "Hay un cambio de estado en curso",
};

export function reasonLabel(code: string | undefined): string | null {
  if (!code) return null;
  return REASONS[code] ?? "Motivo sin descripción en esta versión";
}

export interface SignalRow {
  key: keyof ResourceHealth;
  label: string;
  state: string;
  tone: Tone;
  reason: string | null;
  observedAt: string | null;
}

/** Señales separadas: disponibilidad, salud funcional, frescura y cobertura no se mezclan en una sola. */
export function healthRows(health: ResourceHealth | undefined): SignalRow[] {
  if (!health) return [];
  return SIGNAL_ORDER.flatMap((key) => {
    const signal = health[key];
    if (!signal) return [];
    const view = STATE_VIEWS[signal.state] ?? STATE_VIEWS.unknown!;
    return [{ key, label: SIGNAL_LABELS[key], state: view.label, tone: view.tone, reason: reasonLabel(signal.reasonCode), observedAt: signal.observedAt }];
  });
}

const ACTION_LABELS: Readonly<Record<Action, string>> = {
  start: "Encender",
  stop: "Apagar",
  refresh: "Consultar",
  "boot-windows": "Iniciar Windows",
  "boot-cachyos": "Iniciar CachyOS",
};
/** Motivos obvios por el propio estado (ya encendida, etc.) no aportan y se omiten. */
const OBVIOUS = new Set(["available", "already_running", "state_mismatch", "state_does_not_allow_action"]);

export function blockedActions(resource: Pick<DetailedResource, "actionAvailability">): { action: string; reason: string }[] {
  const entries = Object.entries(resource.actionAvailability ?? {}) as [Action, { allowed: boolean; reasonCode: string }][];
  return entries
    .filter(([, value]) => !value.allowed && !OBVIOUS.has(value.reasonCode))
    .map(([action, value]) => ({ action: ACTION_LABELS[action] ?? action, reason: reasonLabel(value.reasonCode)! }));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("es", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

export interface MetricRow {
  label: string;
  value: string;
  observedAt: string;
}

/** Métricas del host tal como llegan; cada una conserva su hora de observación. */
export function metricRows(metrics: HostMetricsSnapshot | undefined): MetricRow[] {
  if (!metrics) return [];
  const pct = (n: number) => `${Math.round(n)} %`;
  const rows: MetricRow[] = [];
  if (metrics.cpu) rows.push({ label: "CPU", value: pct(metrics.cpu.percent), observedAt: metrics.cpu.observedAt });
  if (metrics.memory) {
    const m = metrics.memory;
    const used = m.utilizationPercent !== null ? pct(m.utilizationPercent) : "—";
    const detail = m.usedBytes !== null && m.totalBytes !== null ? ` · ${formatBytes(m.usedBytes)} de ${formatBytes(m.totalBytes)}` : "";
    rows.push({ label: "Memoria", value: `${used}${detail}`, observedAt: m.observedAt });
  }
  for (const fs of metrics.filesystems ?? [])
    rows.push({ label: `Disco ${fs.mountpoint}`, value: pct(fs.utilizationPercent), observedAt: fs.observedAt });
  return rows;
}

const STATE_LABELS: Readonly<Record<OperationState, string>> = {
  accepted: "Registrada",
  running: "En curso",
  succeeded: "Confirmada",
  failed: "Falló",
  uncertain: "Sin confirmar",
};

export interface HistoryStep {
  id: number;
  label: string;
  at: string;
  message: string | null;
}

/** Pasos con su hora real según el registro durable; repite estado solo si cambió el mensaje. */
export function historySteps(events: readonly OperationHistoryEvent[]): HistoryStep[] {
  const steps: HistoryStep[] = [];
  for (const event of events) {
    const payload = event.payload as Partial<Operation>;
    const state = payload.state;
    if (!state || !(state in STATE_LABELS)) continue;
    const message = typeof payload.message === "string" && payload.message ? payload.message : null;
    const prev = steps[steps.length - 1];
    if (prev && prev.label === STATE_LABELS[state] && prev.message === message) continue;
    steps.push({ id: event.id, label: STATE_LABELS[state], at: event.createdAt, message });
  }
  return steps;
}

export interface ServiceGroup {
  key: string;
  title: string;
  services: CatalogServiceRecord[];
}

/** Agrupa por proyecto y entorno declarados; sin proyecto va al final, nunca se deduce por nombre. */
export function groupServices(services: readonly CatalogServiceRecord[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const service of services.filter((s) => s.active)) {
    const project = service.project ?? "Sin proyecto";
    const key = `${service.projectId ?? "none"}|${service.environment ?? ""}`;
    const title = service.environment ? `${project} · ${service.environment}` : project;
    const group = groups.get(key) ?? { key, title, services: [] };
    groups.set(key, { ...group, services: [...group.services, service] });
  }
  return [...groups.values()].sort((a, b) =>
    a.key.startsWith("none") === b.key.startsWith("none") ? a.title.localeCompare(b.title, "es") : a.key.startsWith("none") ? 1 : -1,
  );
}

export const RELATION_LABELS = { hosted_on: "Se aloja en", depends_on: "Depende de" } as const;
export const CRITICALITY_LABELS = { critical: "crítica", high: "alta", normal: "normal", low: "baja" } as const;
