// Modelo de «Tú · Estado del sistema». Nada desconocido se presenta como sano ni como cero.
import type { DetailedResource } from "../contract.ts";
import type { V2Tone } from "../components/v2.tsx";

const MINUTE = 60_000;

/** Cadencia del descubrimiento compartido del servidor (AGENTS.md: AWS 15 min, Coolify 120 s). */
const SOURCES = {
  aws: { label: "AWS", every: "cada 15 min", staleAfterMs: 20 * MINUTE },
  coolify: { label: "Coolify", every: "cada 2 min", staleAfterMs: 6 * MINUTE },
  host: { label: "Host", every: "cada 60 s", staleAfterMs: 3 * MINUTE },
} as const;
type SourceProvider = keyof typeof SOURCES;

export interface InventorySource {
  key: string;
  title: string;
  sub: string;
  every: string;
  /** Lectura más reciente de esa fuente entre los recursos visibles; null si nunca se observó. */
  lastAt: string | null;
  tone: V2Tone;
  status: string;
}

function providerOf(resource: DetailedResource): SourceProvider | null {
  const p = resource.catalog?.provider ?? (resource.kind === "ec2" ? "aws" : resource.kind === "service" ? "coolify" : null);
  return p === "aws" || p === "coolify" || p === "host" ? p : null;
}

const valid = (at: string | null | undefined): at is string => !!at && Number.isFinite(Date.parse(at));

/**
 * Una fila por fuente (proveedor · cuenta). La cuenta es la etiqueta visible del recurso: así un mismo «agents»
 * con y sin metadatos de catálogo no sale dos veces. Las regiones van en la línea secundaria.
 */
export function inventorySources(resources: readonly DetailedResource[], now: number): InventorySource[] {
  const groups = new Map<string, { provider: SourceProvider; account: string; places: Set<string>; rows: DetailedResource[] }>();
  for (const resource of resources) {
    const provider = providerOf(resource); if (!provider) continue;
    const key = JSON.stringify([provider, provider === "host" ? resource.catalog?.accountId ?? resource.account : resource.account]);
    const group = groups.get(key) ?? { provider, account: resource.account, places: new Set<string>(), rows: [] };
    group.places.add(resource.catalog?.region ?? resource.location); group.rows.push(resource); groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => {
    const meta = SOURCES[g.provider];
    const sameLabel = g.account.trim().toLocaleLowerCase("es") === meta.label.toLocaleLowerCase("es");
    const places = [...g.places].filter(Boolean).sort((a, b) => a.localeCompare(b, "es"));
    const title = `${meta.label} · ${sameLabel ? places.join(", ") || g.account : g.account}`;
    const count = `${g.rows.length} ${g.rows.length === 1 ? "recurso" : "recursos"}`;
    const sub = sameLabel ? count : [places.join(", "), count].filter(Boolean).join(" · ");
    const times = g.rows.map(r => r.observedAt).filter(valid).sort((a, b) => Date.parse(b) - Date.parse(a));
    const lastAt = times[0] ?? null;
    const coverage = g.rows.map(r => r.coverage?.state).filter(Boolean);
    const unobserved = g.rows.length - times.length;
    let tone: V2Tone; let status: string;
    if (coverage.includes("failed")) { tone = "bad"; status = "falló"; }
    else if (!lastAt) { tone = "unc"; status = "sin datos"; }
    else if (coverage.includes("partial") || unobserved > 0) { tone = "unc"; status = unobserved > 0 ? `${unobserved} sin datos` : "parcial"; }
    else if (now - Date.parse(lastAt) >= meta.staleAfterMs || g.provider === "host" && g.rows.some(r => !r.observedAt || now - Date.parse(r.observedAt) >= meta.staleAfterMs)) { tone = "stale"; status = "antigua"; }
    else { tone = "ok"; status = "lee bien"; }
    return { key, title, sub, every: meta.every, lastAt, tone, status };
  }).sort((a, b) => a.title.localeCompare(b.title, "es"));
}

/** Bloques opcionales de /api/system/health que el contrato de la UI no tipa. Solo se usan si llegan bien formados. */
export interface HealthExtras {
  push?: { enabled: boolean; subscriptions: number; pending: number; dead: number };
  costCache?: { configuredAccounts: number; uncachedAccounts: number; earliestExpiry: string | null };
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function healthExtras(health: unknown): HealthExtras {
  if (!health || typeof health !== "object") return {};
  const raw = health as Record<string, unknown>; const result: HealthExtras = {};
  const push = raw.push as Record<string, unknown> | undefined;
  if (push && typeof push === "object" && typeof push.enabled === "boolean" && count(push.subscriptions) && count(push.pending) && count(push.dead))
    result.push = { enabled: push.enabled, subscriptions: push.subscriptions, pending: push.pending, dead: push.dead };
  const cost = raw.costCache as Record<string, unknown> | undefined;
  if (cost && typeof cost === "object" && count(cost.configuredAccounts) && count(cost.uncachedAccounts) && (cost.earliestExpiry === null || valid(cost.earliestExpiry as string)))
    result.costCache = { configuredAccounts: cost.configuredAccounts, uncachedAccounts: cost.uncachedAccounts, earliestExpiry: cost.earliestExpiry as string | null };
  return result;
}

export const PANEL_STATES: Readonly<Record<string, { label: string; tone: V2Tone }>> = {
  healthy: { label: "Funcionando", tone: "ok" },
  degraded: { label: "Con fallos recientes", tone: "stale" },
  disabled: { label: "Desactivado", tone: "off" },
  idle: { label: "En espera", tone: "neutral" },
  running: { label: "Leyendo ahora", tone: "busy" },
};
export function panelState(state: string): { label: string; tone: V2Tone } {
  return Object.hasOwn(PANEL_STATES, state) ? PANEL_STATES[state]! : { label: "Estado sin descripción", tone: "unc" };
}
