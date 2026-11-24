import type { CatalogServiceRecord, DetailedResource, Operation } from "../contract.ts";
import { age, relatedResource, serviceObservation, servicesForResource } from "./controlModel.ts";
import { fleetStatus } from "./hoyModel.ts";
import { describeResourceState, isActiveOperation } from "./status.ts";
import type { V2Tone } from "../components/v2.tsx";

/**
 * Modelo del inventario v2. Los estados son los mismos que cuenta Hoy (`fleetStatus`), así «1 falla» en Hoy
 * es la misma fila que aparece arriba aquí. `unchecked` es un servicio lógico sin sonda: no es un problema,
 * pero tampoco se pinta como sano.
 */
export type InvStatus = "bad" | "unc" | "stale" | "unknown" | "busy" | "unchecked" | "ok" | "off";

/** Orden de gravedad: fallo, sin confirmar o antiguo, sin datos; luego lo que no pide nada. */
export const SEVERITY: Readonly<Record<InvStatus, number>> = { bad: 0, unc: 1, stale: 1, unknown: 2, busy: 3, unchecked: 4, ok: 4, off: 5 };

export const STATUS_TONE: Readonly<Record<InvStatus, V2Tone>> = { bad: "bad", unc: "unc", stale: "stale", unknown: "neutral", busy: "busy", unchecked: "neutral", ok: "ok", off: "off" };

export function isProblem(status: InvStatus): boolean { return SEVERITY[status] <= 2; }

export type InvShape = "ec2" | "computer" | "router" | "app" | "service";

export interface InvZone { key: string; title: string; sub: string | null }

export interface InvItem {
  key: string;
  id: string;
  kind: "resource" | "service";
  name: string;
  status: InvStatus;
  /** Estado en palabras («Encendida», «Por conectar»). Nunca «apagada» si solo falta señal. */
  label: string;
  /** Una sola cosa útil para la fila. */
  note: string | null;
  observedAt: string | null;
  zone: InvZone;
  shape: InvShape;
  critical: boolean;
}

export function activeResourceIds(operations: readonly Operation[]): Set<string> {
  return new Set(operations.filter(isActiveOperation).map(operation => operation.resourceId));
}

/** Zona física: proveedor, cuenta y región. Se agrupa por nombre de cuenta, no por accountId (puede repetirse). */
export function locationZone(resource: DetailedResource): InvZone {
  const region = resource.catalog?.region ?? resource.location;
  if (resource.kind === "ec2") return { key: `aws|${resource.account}|${region}`, title: `AWS · ${resource.account}`, sub: region };
  if (resource.kind === "service") return { key: `coolify|${resource.account}|${resource.location}`, title: resource.account === "Coolify" ? "Coolify" : `Coolify · ${resource.account}`, sub: resource.location };
  return { key: `local|${resource.account}`, title: resource.account, sub: null };
}

export function projectZone(project: string | null | undefined, environment: string | null | undefined, projectId?: string | null): InvZone {
  return { key: `project|${projectId ?? project ?? "none"}|${environment ?? ""}`, title: project ?? "Sin proyecto", sub: environment ?? null };
}

function shapeOf(resource: DetailedResource): InvShape {
  return resource.kind === "ec2" ? "ec2" : resource.kind === "computer" ? "computer" : resource.kind === "router" ? "router" : "app";
}

function appProblem(resource: DetailedResource): string | null {
  const signals = [resource.health?.service, ...Object.values(resource.serviceSignals ?? {})];
  if (signals.some(signal => signal?.state === "unhealthy")) return "app con fallo";
  if (signals.some(signal => signal?.state === "degraded")) return "app degradada";
  return null;
}

const SYSTEM_NAME = { windows: "Windows", cachyos: "CachyOS" } as const;

function hostedNote(resource: DetailedResource, services: readonly CatalogServiceRecord[], resources: readonly DetailedResource[]): string | null {
  const hosted = servicesForResource(resource, services, resources).filter(s => s.relations.some(r => r.relationType === "hosted_on" && relatedResource(r, resources)?.id === resource.id));
  if (!hosted.length) return null;
  return hosted.length === 1 ? `aloja ${hosted[0]!.name}` : `aloja ${hosted[0]!.name} y ${hosted.length - 1} más`;
}

/** La cosa útil de cada fila, por prioridad: orden en curso, fallo de la app, y lo propio de cada tipo. */
export function resourceNote(resource: DetailedResource, active: boolean, services: readonly CatalogServiceRecord[] = [], resources: readonly DetailedResource[] = []): string | null {
  if (active) return "orden en curso";
  const problem = appProblem(resource);
  if (problem) return problem;
  if (resource.kind === "computer") {
    if (resource.state === "running" && resource.system) return SYSTEM_NAME[resource.system];
    return resource.state === "unconfigured" ? resource.detail : resource.location;
  }
  if (resource.kind === "router") {
    const tunnel = resource.health?.tunnel?.state;
    return tunnel === "available" ? "túnel listo" : tunnel === "unavailable" ? "túnel caído" : resource.location;
  }
  return hostedNote(resource, services, resources) ?? resource.detail;
}

export function resourceItem(resource: DetailedResource, now: number, activeIds: ReadonlySet<string>, services: readonly CatalogServiceRecord[] = [], resources: readonly DetailedResource[] = []): InvItem {
  const active = activeIds.has(resource.id);
  return {
    key: `r:${resource.id}`, id: resource.id, kind: "resource", name: resource.name,
    status: fleetStatus(resource, now, active), label: describeResourceState(resource, now).label,
    note: resourceNote(resource, active, services, resources), observedAt: resource.observedAt,
    zone: locationZone(resource), shape: shapeOf(resource), critical: false,
  };
}

export interface ServiceView { status: InvStatus; label: string; note: string | null; host: DetailedResource | null; observedAt: string | null }

/** Un servicio lógico no tiene salud propia en la API: se dice dónde corre y si algo relacionado falla. */
export function serviceView(service: CatalogServiceRecord, resources: readonly DetailedResource[], now: number, activeIds: ReadonlySet<string> = new Set()): ServiceView {
  const observation = serviceObservation(service, resources, now);
  const relations = service.relations.filter(r => r.active);
  const host = relations.filter(r => r.relationType === "hosted_on").map(r => relatedResource(r, resources)).find((r): r is DetailedResource => !!r) ?? null;
  const base = { host, observedAt: observation.observedAt };
  if (!relations.length) return { ...base, status: "unknown", label: "Sin relaciones", note: null };
  const unresolved = relations.find(r => !relatedResource(r, resources));
  if (unresolved) return { ...base, status: "unknown", label: "Host sin descubrir", note: unresolved.resource?.name ?? unresolved.resourceAlias };
  const ranked = observation.resolved.map(r => ({ r, status: fleetStatus(r, now, activeIds.has(r.id)) })).sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
  const worst = ranked[0];
  if (worst && worst.status === "bad") return { ...base, status: "stale", label: "Por revisar", note: `${worst.r.name} con fallo` };
  if (worst && isProblem(worst.status)) return { ...base, status: "stale", label: "Por revisar", note: `${worst.r.name} ${worst.status === "unknown" ? "sin datos" : "sin confirmar"}` };
  if (worst && worst.status === "busy") return { ...base, status: "busy", label: "Orden en curso", note: worst.r.name };
  return { ...base, status: "unchecked", label: "Sin sonda", note: host ? `en ${host.name}` : null };
}

export function serviceItem(service: CatalogServiceRecord, resources: readonly DetailedResource[], now: number, activeIds: ReadonlySet<string> = new Set(), mode: "project" | "location" = "project"): InvItem {
  const view = serviceView(service, resources, now, activeIds);
  const zone = mode === "location" && view.host ? locationZone(view.host) : mode === "location" ? { ...projectZone(service.project, service.environment, service.projectId), key: `catalog|${service.projectId ?? service.project ?? "none"}`, title: `Servicios · ${service.project ?? "sin proyecto"}` } : projectZone(service.project, service.environment, service.projectId);
  return {
    key: `s:${service.id}`, id: service.id, kind: "service", name: service.name, status: view.status, label: view.label, note: view.note,
    observedAt: view.observedAt, zone, shape: "service", critical: service.criticality === "critical",
  };
}

/** Nodos del mapa: recursos y servicios lógicos, por ubicación física o por proyecto declarado. */
export function mapItems(resources: readonly DetailedResource[], services: readonly CatalogServiceRecord[], mode: "location" | "project", now: number, activeIds: ReadonlySet<string>): InvItem[] {
  const fromResources = resources.map(resource => {
    const item = resourceItem(resource, now, activeIds, services, resources);
    return mode === "project" ? { ...item, zone: projectZone(resource.catalog?.project, resource.catalog?.environment, resource.catalog?.projectId) } : item;
  });
  return [...fromResources, ...services.filter(s => s.active).map(service => serviceItem(service, resources, now, activeIds, mode))];
}

export function bySeverity(a: InvItem, b: InvItem): number {
  return SEVERITY[a.status] - SEVERITY[b.status] || a.name.localeCompare(b.name, "es");
}

export function worstStatus(items: readonly InvItem[]): InvStatus {
  return items.reduce<InvStatus>((worst, item) => SEVERITY[item.status] < SEVERITY[worst] ? item.status : worst, "off");
}

export interface InvGroup { zone: InvZone; items: InvItem[]; status: InvStatus; freshest: string | null }

/** Grupos por zona, el peor primero; dentro, por gravedad. Lo que falla nunca queda al fondo. */
export function groupItems(items: readonly InvItem[]): InvGroup[] {
  const groups = new Map<string, InvItem[]>();
  for (const item of items) groups.set(item.zone.key, [...(groups.get(item.zone.key) ?? []), item]);
  return [...groups.values()].map(list => {
    const sorted = [...list].sort(bySeverity);
    const times = sorted.flatMap(item => item.observedAt && Number.isFinite(Date.parse(item.observedAt)) ? [item.observedAt] : []);
    return { zone: sorted[0]!.zone, items: sorted, status: worstStatus(sorted), freshest: times.length ? times.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : null };
  }).sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.zone.title.localeCompare(b.zone.title, "es"));
}

export interface ProblemCounts { bad: number; review: number; unknown: number; total: number }

export function problemCounts(items: readonly InvItem[]): ProblemCounts {
  const bad = items.filter(i => i.status === "bad").length;
  const review = items.filter(i => i.status === "unc" || i.status === "stale").length;
  const unknown = items.filter(i => i.status === "unknown").length;
  return { bad, review, unknown, total: bad + review + unknown };
}

/** «1 falla · 4 sin datos». Vacío si no hay nada que revisar. */
export function problemSummary(counts: ProblemCounts): string {
  return [
    counts.bad ? `${counts.bad} ${counts.bad === 1 ? "falla" : "fallas"}` : null,
    counts.review ? `${counts.review} por revisar` : null,
    counts.unknown ? `${counts.unknown} sin datos` : null,
  ].filter(Boolean).join(" · ");
}

/** Edad corta para chips del mapa: «40 s», «6 min». */
export function shortAge(at: string | null | undefined, now: number): string {
  const text = age(at, now);
  return text.startsWith("hace ") ? text.slice(5) : text;
}

/** Texto corto del estado para el chip del mapa: lo que falla se nombra; lo sano muestra su edad. */
export function chipNote(item: InvItem, now: number): string {
  switch (item.status) {
    case "bad": return item.note?.startsWith("app") ? item.note : "falla";
    case "unc": return "sin confirmar";
    case "stale": return "por revisar";
    case "unknown": return "sin datos";
    case "busy": return "en curso";
    case "off": return item.label.toLocaleLowerCase("es");
    default: return item.observedAt ? shortAge(item.observedAt, now) : "";
  }
}

export function isProduction(environment: string | null | undefined): boolean {
  return /^(prod|production|producción)$/i.test(environment ?? "");
}

/** Titular del estado: si falla la app, eso va primero; el encendido queda como dato secundario. */
export function headline(item: Pick<InvItem, "status" | "label" | "note">): { pill: string; rest: string | null } {
  if (item.status === "bad" && item.note?.startsWith("app")) return { pill: item.note.charAt(0).toLocaleUpperCase("es") + item.note.slice(1), rest: item.label };
  return { pill: item.label, rest: item.note };
}
