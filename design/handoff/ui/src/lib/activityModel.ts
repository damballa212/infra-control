import type { OperationalIncident, OperationState, PageQuery, SecretAuditEvent } from "../contract.ts";
import type { V2Tone } from "../components/v2.tsx";

/** Modelo puro de Actividad: colecciones, chips de estado (filtros del servidor), grupos por día y tonos. */

export type ActivityKind = "orders" | "keys" | "incidents";
export type ActivityFilters = Omit<PageQuery, "cursor" | "limit">;

export interface StateChip { key: string; label: string; query: ActivityFilters }

/** Cada chip se traduce a un filtro del servidor; nunca se filtra la página recibida en el cliente. */
export const STATE_CHIPS: Readonly<Record<ActivityKind, readonly StateChip[]>> = {
  orders: [
    { key: "all", label: "Todas", query: {} },
    { key: "active", label: "En curso", query: { view: "active" } },
    { key: "uncertain", label: "Sin confirmar", query: { state: "uncertain" } },
    { key: "failed", label: "Fallidas", query: { state: "failed" } },
    { key: "succeeded", label: "Confirmadas", query: { state: "succeeded" } },
    { key: "review", label: "Por revisar", query: { view: "review" } },
  ],
  keys: [
    { key: "all", label: "Todas", query: {} },
    { key: "created", label: "Solicitadas", query: { type: "created" } },
    { key: "delivered", label: "Entregadas", query: { type: "delivered" } },
    { key: "denied", label: "Denegadas", query: { type: "denied" } },
    { key: "expired", label: "Vencidas", query: { type: "expired" } },
    { key: "failed", label: "Fallidas", query: { type: "failed" } },
  ],
  incidents: [
    { key: "all", label: "Todos", query: {} },
    { key: "open", label: "Abiertos", query: { state: "open" } },
    { key: "unknown", label: "Desconocidos", query: { state: "unknown" } },
    { key: "resolved", label: "Resueltos", query: { state: "resolved" } },
    { key: "information", label: "Informativos", query: { state: "information" } },
  ],
};

export const ORDER_TYPES: readonly { value: string; label: string }[] = [
  { value: "power", label: "Energía" }, { value: "start", label: "Encender" }, { value: "stop", label: "Apagar" },
  { value: "refresh", label: "Comprobar" }, { value: "boot-windows", label: "Iniciar Windows" }, { value: "boot-cachyos", label: "Iniciar CachyOS" },
];

export const INCIDENT_KINDS: Readonly<Record<OperationalIncident["kind"], string>> = {
  application: "La app falla", observability: "Sin observación", availability: "Debería estar encendido",
  coverage: "Fuente con problemas", budget: "Presupuesto", change: "Cambio externo",
};

export interface MoreFilters { actor: string; type: string }

/** Qué filtros extra admite cada colección: autor (órdenes y claves) y tipo (órdenes e incidentes). */
export function moreFields(kind: ActivityKind): { actor: boolean; type: boolean } {
  return { actor: kind !== "incidents", type: kind !== "keys" };
}

export function activityQuery(kind: ActivityKind, chipKey: string, q: string, more: MoreFilters): ActivityFilters {
  const chip = STATE_CHIPS[kind].find(item => item.key === chipKey) ?? STATE_CHIPS[kind][0]!;
  const fields = moreFields(kind);
  const actor = fields.actor ? more.actor.trim() : "";
  const type = fields.type ? more.type.trim() : "";
  const query: ActivityFilters = { ...chip.query };
  if (q.trim()) query.q = q.trim();
  if (actor) query.actor = actor;
  if (type) query.type = type;
  return query;
}

export function activeMoreCount(kind: ActivityKind, more: MoreFilters): number {
  const fields = moreFields(kind);
  return (fields.actor && more.actor.trim() ? 1 : 0) + (fields.type && more.type.trim() ? 1 : 0);
}

/** Une la primera página (refrescada) con las siguientes: sin duplicados y en el orden del servidor. */
export function mergeRows<T>(first: readonly T[], later: readonly (readonly T[])[], key: (row: T) => string): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const row of [...first, ...later.flat()]) { const id = key(row); if (seen.has(id)) continue; seen.add(id); out.push(row); }
  return out;
}

const TIME_FMT = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const CLOCK_FMT = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const WEEKDAY_FMT = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric" });
const DATE_FMT = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "short" });
const DATE_YEAR_FMT = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const valid = (at: string | null | undefined): at is string => !!at && Number.isFinite(Date.parse(at));

/** Hora local corta («08:40»). */
export function localTime(at: string | null | undefined): string { return valid(at) ? TIME_FMT.format(new Date(at)) : "sin hora"; }
/** Hora local con segundos para líneas de tiempo («22:40:02»). */
export function localClock(at: string | null | undefined): string { return valid(at) ? CLOCK_FMT.format(new Date(at)) : "sin hora"; }

function dayStart(ms: number): number { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

export interface DayGroup<T> { key: string; label: string; meta: string | null; rows: T[] }

/** Agrupa por día local conservando el orden recibido del servidor: «Hoy», «Ayer», «lunes 10 nov». */
export function dayGroups<T>(rows: readonly T[], at: (row: T) => string | null | undefined, now: number): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  const today = dayStart(now);
  for (const row of rows) {
    const value = at(row);
    let key = "unknown", label = "Sin fecha", meta: string | null = null;
    if (valid(value)) {
      const date = new Date(value); const start = dayStart(date.getTime());
      const days = Math.round((today - start) / 86400000);
      key = String(start);
      if (days === 0) { label = "Hoy"; meta = WEEKDAY_FMT.format(date); }
      else if (days === 1) { label = "Ayer"; meta = WEEKDAY_FMT.format(date); }
      else label = (date.getFullYear() === new Date(now).getFullYear() ? DATE_FMT : DATE_YEAR_FMT).format(date).replace(".", "");
      label = label.charAt(0).toLocaleUpperCase("es") + label.slice(1);
    }
    const group = groups.get(key) ?? { key, label, meta, rows: [] };
    group.rows.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}

export function orderTone(state: OperationState | string): V2Tone {
  return state === "succeeded" ? "ok" : state === "failed" ? "bad" : state === "uncertain" ? "unc" : state === "accepted" || state === "running" ? "busy" : "neutral";
}

export function incidentView(incident: Pick<OperationalIncident, "status" | "actionable" | "kind">): { label: string; tone: V2Tone } {
  if (incident.status === "resolved") return { label: "Resuelto", tone: "ok" };
  if (incident.status === "information") return { label: "Informativo", tone: "neutral" };
  if (incident.status === "unknown") return { label: "Desconocido", tone: "unc" };
  return { label: "Abierto", tone: incident.actionable && (incident.kind === "application" || incident.kind === "availability") ? "bad" : "stale" };
}

const AUDIT_TONES: Readonly<Record<string, V2Tone>> = { created: "key", approved: "busy", auto_approved: "busy", delivered: "ok", failed: "bad", denied: "off", expired: "stale", grant_revoked: "off" };
export function auditTone(event: SecretAuditEvent["event"]): V2Tone { return AUDIT_TONES[event] ?? "neutral"; }
