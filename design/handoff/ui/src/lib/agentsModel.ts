// Modelo de Agentes y peticiones de clave. Solo metadatos: ningún dato aquí contiene valores de claves.
import type { SecretGrant, SecretRequest, SecretRequestState, SecretScope } from "../contract.ts";

const MINUTE = 60_000;

export interface Countdown {
  /** false si createdAt/expiresAt no son fechas válidas: nunca se inventa un plazo. */
  known: boolean;
  /** Minutos que quedan, redondeados hacia arriba; 0 si ya venció. */
  minutes: number;
  expired: boolean;
  /** Fracción restante del plazo total (0–1) para el anillo; undefined si no se conoce. */
  fraction: number | undefined;
}

export function countdown(request: Pick<SecretRequest, "createdAt" | "expiresAt">, now: number): Countdown {
  const end = Date.parse(request.expiresAt); const start = Date.parse(request.createdAt);
  if (!Number.isFinite(end)) return { known: false, minutes: 0, expired: false, fraction: undefined };
  const left = end - now;
  const total = Number.isFinite(start) ? end - start : NaN;
  return {
    known: true,
    minutes: Math.max(0, Math.ceil(left / MINUTE)),
    expired: left <= 0,
    fraction: left > 0 && total > 0 ? Math.min(1, left / total) : left > 0 ? undefined : 0,
  };
}

/** «vence en 29 min», «vence en 2 h 5 min», «plazo cumplido» o «plazo sin comprobar». */
export function deadlineText(value: Countdown): string {
  if (!value.known) return "plazo sin comprobar";
  if (value.expired) return "plazo cumplido";
  if (value.minutes < 120) return `vence en ${value.minutes} min`;
  const hours = Math.floor(value.minutes / 60); const rest = value.minutes % 60;
  return rest ? `vence en ${hours} h ${rest} min` : `vence en ${hours} h`;
}

export interface Collection { key: string; project: string; environment: string | null }

/** Colecciones proyecto/entorno vistas en las peticiones y permisos cargados, sin duplicados. */
export function knownCollections(rows: readonly Pick<SecretRequest, "project" | "environment">[]): Collection[] {
  const map = new Map<string, Collection>();
  for (const row of rows) {
    const key = JSON.stringify([row.project, row.environment]);
    if (!map.has(key)) map.set(key, { key, project: row.project, environment: row.environment });
  }
  return [...map.values()].sort((a, b) => a.project.localeCompare(b.project, "es") || (a.environment ?? "").localeCompare(b.environment ?? "", "es"));
}

export interface TokenMachine {
  machine: string;
  /** Agentes que dicen usar el token de este equipo (declarados, no verificados). */
  agents: string[];
  /** Último evento observado de este equipo en lo cargado; null si no hay fecha. */
  lastAt: string | null;
  pending: number;
}

const latest = (values: readonly (string | null)[]): string | null =>
  values.filter((v): v is string => v !== null && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

/** Equipos que aparecen en las peticiones y permisos cargados. No es un inventario de tokens. */
export function tokenMachines(requests: readonly SecretRequest[], grants: readonly SecretGrant[]): TokenMachine[] {
  const machines = new Map<string, { agents: Set<string>; times: (string | null)[]; pending: number }>();
  const entry = (machine: string) => {
    const found = machines.get(machine); if (found) return found;
    const created = { agents: new Set<string>(), times: [] as (string | null)[], pending: 0 }; machines.set(machine, created); return created;
  };
  for (const r of requests) {
    const e = entry(r.machine); e.agents.add(r.agent); e.times.push(r.createdAt, r.decidedAt, r.deliveredAt);
    if (r.state === "pending") e.pending += 1;
  }
  for (const g of grants) { const e = entry(g.machine); e.agents.add(g.agent); e.times.push(g.createdAt); }
  return [...machines.entries()].map(([machine, e]) => ({ machine, agents: [...e.agents].sort((a, b) => a.localeCompare(b, "es")), lastAt: latest(e.times), pending: e.pending }))
    .sort((a, b) => (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0) || a.machine.localeCompare(b.machine, "es"));
}

export type HistoryFilter = "" | SecretRequestState;
const HISTORY_LABELS: readonly { key: HistoryFilter; label: string }[] = [
  { key: "", label: "Todas" },
  { key: "pending", label: "Te espera" },
  { key: "approved", label: "Aprobadas" },
  { key: "delivered", label: "Entregadas" },
  { key: "denied", label: "Denegadas" },
  { key: "expired", label: "Vencidas" },
  { key: "failed", label: "Fallidas" },
];

export interface HistoryChip { key: HistoryFilter; label: string; count: number | undefined }

/**
 * Chips del historial. Los números salen de /api/secrets/requests/counts (totales del servidor); sin conteos
 * o con búsqueda activa no se muestran números. Un estado con 0 se oculta salvo que esté elegido.
 */
export function historyChips(counts: Readonly<Record<string, number>> | null, selected: HistoryFilter, searching: boolean): HistoryChip[] {
  const valid = counts && Object.values(counts).every(n => Number.isSafeInteger(n) && n >= 0) ? counts : null;
  const total = valid ? Object.values(valid).reduce((sum, n) => sum + n, 0) : undefined;
  return HISTORY_LABELS.flatMap(item => {
    const count = item.key === "" ? total : valid ? valid[item.key] ?? 0 : undefined;
    if (valid && item.key !== "" && count === 0 && selected !== item.key) return [];
    return [{ ...item, count: searching ? undefined : count }];
  });
}

export interface ScopeChoice { value: SecretScope; label: string; hint: string }

/** Alcances con una línea cada uno, nombrando el equipo verificado. */
export function scopeChoices(machine: string): ScopeChoice[] {
  return [
    { value: "once", label: "Solo esta vez", hint: "La próxima vez te vuelve a preguntar." },
    { value: "machine_project", label: "Este equipo", hint: `Sin preguntarte, en ${machine} y este proyecto.` },
    { value: "always", label: "Siempre", hint: "Sin preguntarte, desde cualquier equipo, en este proyecto." },
  ];
}

/** Producción pide una confirmación más para cualquier permiso permanente. */
export function needsProductionConfirm(environment: string | null, scope: SecretScope): boolean {
  return scope !== "once" && /^(prod|production|producción)$/i.test(environment ?? "");
}

/** Valor pegado válido: una línea, sin nulos, hasta 8 KB. Nunca se guarda ni se registra. */
export function validPastedValue(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/.test(value) && new TextEncoder().encode(value).length <= 8192;
}
