import type { AttentionSummary, DetailedResource, Operation } from "../contract.ts";
import { describeResourceState, hasServiceProblem, isActiveOperation } from "./status.ts";

/** Estado visual de un equipo en la escena y en la leyenda de Hoy. */
export type FleetStatus = "ok" | "bad" | "off" | "busy" | "unc" | "stale" | "unknown";
export type ZoneName = "AWS" | "Coolify" | "Casa";

export interface FleetNode { id: string; name: string; status: FleetStatus }
export interface FleetZone { name: ZoneName; nodes: FleetNode[] }
export interface FleetCounts { ok: number; bad: number; off: number; busy: number; attention: number; unknown: number; total: number }

const ZONE_ORDER: readonly ZoneName[] = ["AWS", "Coolify", "Casa"];

export function zoneOf(resource: Pick<DetailedResource, "kind">): ZoneName {
  if (resource.kind === "ec2") return "AWS";
  if (resource.kind === "service") return "Coolify";
  return "Casa";
}

/** Una salud funcional con fallo pesa más que «encendida»: un EC2 vivo con su app caída es un fallo. */
export function fleetStatus(resource: DetailedResource, now: number, active: boolean): FleetStatus {
  if (active) return "busy";
  if (hasServiceProblem(resource)) return "bad";
  const view = describeResourceState(resource, now);
  switch (view.tone) {
    case "on": return "ok";
    case "bad": return "bad";
    case "off": return "off";
    case "busy": return "busy";
    case "warn": return view.glyph === "question" ? "unc" : "stale";
    default: return "unknown";
  }
}

export function buildFleet(resources: readonly DetailedResource[], operations: readonly Operation[], now: number): { zones: FleetZone[]; counts: FleetCounts } {
  const activeIds = new Set(operations.filter(isActiveOperation).map(operation => operation.resourceId));
  const byZone = new Map<ZoneName, FleetNode[]>();
  for (const resource of resources) {
    const zone = zoneOf(resource);
    const node: FleetNode = { id: resource.id, name: resource.name, status: fleetStatus(resource, now, activeIds.has(resource.id)) };
    byZone.set(zone, [...(byZone.get(zone) ?? []), node]);
  }
  const zones = ZONE_ORDER.flatMap(name => {
    const nodes = byZone.get(name);
    return nodes?.length ? [{ name, nodes: [...nodes].sort((a, b) => a.name.localeCompare(b.name, "es")) }] : [];
  });
  const all = zones.flatMap(zone => zone.nodes);
  const count = (...statuses: FleetStatus[]) => all.filter(node => statuses.includes(node.status)).length;
  return { zones, counts: { ok: count("ok"), bad: count("bad"), off: count("off"), busy: count("busy"), attention: count("unc", "stale"), unknown: count("unknown"), total: all.length } };
}

export type VerdictKind = "checking" | "unknown" | "attention" | "busy" | "quiet" | "ok";
export interface Verdict { kind: VerdictKind; title: string; total: number | null }

interface VerdictInput {
  summary: AttentionSummary | null;
  summaryError: boolean;
  /** null cuando la persona no puede decidir peticiones (sesión de agente) o la lectura no está confirmada. */
  pendingCount: number | null;
  /** La lectura de peticiones falló (distinto de «todavía cargando»). */
  pendingError?: boolean;
  personal: boolean;
  activeOperations: readonly Operation[];
  fleet: FleetCounts;
  /** El inventario se leyó: sin él, una flota vacía no prueba que esté sana. */
  inventoryReady: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * El veredicto usa los conteos completos del servidor, nunca la longitud de una página.
 * Sin resumen, peticiones, inventario y cobertura confirmados no se declara «Todo en orden».
 */
export function verdict(input: VerdictInput): Verdict {
  const { summary, summaryError, pendingCount, pendingError = false, personal, activeOperations, fleet, inventoryReady } = input;
  if (!summary) return summaryError ? { kind: "unknown", title: "No pude comprobar", total: null } : { kind: "checking", title: "Comprobando…", total: null };
  const pendingKnown = !personal || pendingCount !== null;
  const total = summary.counts.attentionGroups + (personal ? pendingCount ?? 0 : 0);
  if (total > 0) return { kind: "attention", title: total === 1 ? "1 cosa te toca" : `${total} cosas te tocan`, total };
  if (!pendingKnown) return pendingError ? { kind: "unknown", title: "No pude comprobar todo", total: null } : { kind: "checking", title: "Comprobando…", total: null };
  const active = Math.max(summary.counts.active, activeOperations.length);
  if (active > 0) {
    const only = activeOperations.length === 1 ? activeOperations[0]! : null;
    if (only && only.resourceId === "computer:desktop" && only.action !== "stop" && only.action !== "refresh") return { kind: "busy", title: "Encendiendo la PC", total: 0 };
    return { kind: "busy", title: plural(active, "orden en curso", "órdenes en curso"), total: 0 };
  }
  const coverageChecked = summary.coverage.scopes > 0 && summary.counts.coverageProblems === 0;
  const clean = !summaryError && inventoryReady && coverageChecked && fleet.bad === 0 && fleet.attention === 0;
  return clean ? { kind: "ok", title: "Todo en orden", total: 0 } : { kind: "quiet", title: "Nada te toca", total: 0 };
}

/** Línea bajo el veredicto: describe la evidencia sin afirmar más de lo observado. */
export function verdictDetail(v: Verdict, input: Pick<VerdictInput, "pendingCount" | "personal" | "fleet" | "summaryError" | "inventoryReady">): string {
  const { pendingCount, personal, fleet, summaryError, inventoryReady } = input;
  if (v.kind === "checking") return "Leyendo el resumen del panel.";
  if (v.kind === "unknown") return pendingCount === null && personal && !summaryError ? "Las peticiones de clave no respondieron. No lo tomo como «nada pendiente»." : "El resumen no respondió. No lo tomo como «todo bien».";
  const parts: string[] = [];
  if (summaryError) parts.push("según la última lectura del resumen");
  if (personal && pendingCount === null) parts.push("peticiones sin comprobar");
  if (!inventoryReady) parts.push("inventario sin leer");
  else if (fleet.total > 0) parts.push(`${fleet.ok} de ${fleet.total} equipos reportan bien`);
  if (v.kind === "busy") parts.unshift("te aviso cuando termine");
  if (v.kind === "ok") parts.unshift("nada te espera");
  const text = parts.join(" · ");
  return text ? text.charAt(0).toLocaleUpperCase("es") + text.slice(1) + "." : "";
}
