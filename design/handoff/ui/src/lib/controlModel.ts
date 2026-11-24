import type { Action, CatalogServiceRecord, CatalogServiceRelation, CostAccount, DetailedResource, Operation, OperationState, Resource, SecretRequestState } from "../contract.ts";
import { describeResourceState, hasServiceProblem, isActiveOperation, isStale, needsAttention, type OperationView } from "./status.ts";
import { formatAgo } from "./format.ts";
import { STATE_VIEWS } from "./secrets.ts";
import { reasonLabel } from "./insight.ts";
export function age(at: string | null | undefined, now: number): string { return at && Number.isFinite(Date.parse(at)) ? formatAgo(at, now) : "sin observación"; }
const TIME_FMT = new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const DAY_YEAR_FMT = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
/** Fecha y hora locales legibles: «hoy 10:10 p. m.», «ayer 9:02 a. m.», «12 nov 8:15 p. m.». */
export function dateTime(at: string | null | undefined, now: number = Date.now()): string {
  if (!at || !Number.isFinite(Date.parse(at))) return "Sin fecha";
  const date = new Date(at); const today = new Date(now);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / 86400000);
  const time = TIME_FMT.format(date);
  if (days === 0) return `hoy ${time}`;
  if (days === 1) return `ayer ${time}`;
  return `${(date.getFullYear() === today.getFullYear() ? DAY_FMT : DAY_YEAR_FMT).format(date).replace(".", "")} ${time}`;
}
export function normalized(value: string): string { return value.trim().toLocaleLowerCase("es"); }
export function matchesText(query: string, ...values: (string | null | undefined)[]): boolean { return normalized(values.filter(Boolean).join(" ")).includes(normalized(query)); }
export function operationView(state: string): OperationView {
  const views: Record<OperationState, OperationView> = { accepted: { label: "Registrada", tone: "busy", glyph: "ellipsis", stage: 1, final: false }, running: { label: "En curso", tone: "busy", glyph: "half", stage: 2, final: false }, succeeded: { label: "Confirmada", tone: "on", glyph: "check", stage: 3, final: true }, failed: { label: "Falló", tone: "bad", glyph: "cross", stage: 3, final: true }, uncertain: { label: "Sin confirmar", tone: "warn", glyph: "question", stage: 3, final: true } };
  return Object.hasOwn(views, state) ? views[state as OperationState] : { label: "Estado desconocido", tone: "unk", glyph: "question", stage: 1, final: false };
}
export function secretView(state: string) { return Object.hasOwn(STATE_VIEWS, state) ? STATE_VIEWS[state as SecretRequestState] : { label: "Estado desconocido", tone: "unk" as const, glyph: "question" as const }; }
export function relatedResource(relation: CatalogServiceRelation, resources: readonly DetailedResource[]): DetailedResource | undefined { if (!relation.active || !relation.resolved) return undefined; const catalogId = relation.resource?.catalogId; if (catalogId) return resources.find(r => r.catalog?.catalogId === catalogId); if (!relation.resourceId) return undefined; return resources.find(r => r.id === relation.resourceId || r.catalog?.catalogId === relation.resourceId); }
export function servicesForResource(resource: Resource, services: readonly CatalogServiceRecord[], resources: readonly DetailedResource[]) { return services.filter(s => s.active && s.relations.some(r => relatedResource(r, resources)?.id === resource.id)); }
export function serviceObservation(service: CatalogServiceRecord, resources: readonly DetailedResource[], now: number) {
  const relations = service.relations.filter(r => r.active); const resolved = relations.flatMap(r => { const resource = relatedResource(r, resources); return resource ? [resource] : []; }); const unresolved = relations.length - resolved.length; const problems = resolved.filter(r => needsAttention(r, now)).length;
  const times = resolved.flatMap(r => r.observedAt && Number.isFinite(Date.parse(r.observedAt)) ? [r.observedAt] : []); const observedAt = times.length ? times.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null;
  return { label: unresolved ? "Relaciones sin resolver" : problems ? "Recursos relacionados requieren atención" : "Salud del servicio sin comprobar", tone: unresolved ? "unk" as const : problems ? "warn" as const : "unk" as const, glyph: unresolved ? "question" as const : problems ? "bang" as const : "question" as const, problem: unresolved > 0 || problems > 0 || relations.length === 0, unresolved, resolved, observedAt };
}
export function resourceGroup(resource: Resource, mode: "location" | "project" = "location"): { key: string; title: string } {
  const c = resource.catalog;
  if (mode === "project") return { key: JSON.stringify([c?.projectId ?? c?.project ?? null, c?.environment ?? null]), title: [c?.project ?? "Sin proyecto", c?.environment].filter(Boolean).join(" · ") };
  const provider = c?.provider ?? (resource.kind === "ec2" ? "aws" : resource.kind === "service" ? "coolify" : "local");
  return { key: JSON.stringify([provider, c?.accountId ?? resource.account, c?.region ?? resource.location]), title: [provider === "local" ? resource.account : provider.toUpperCase() + " · " + resource.account, c?.region ?? resource.location].filter(Boolean).join(" · ") };
}
export function groupedResources(resources: readonly DetailedResource[], mode: "location" | "project" = "location") {
  const groups = new Map<string, { key: string; title: string; resources: DetailedResource[] }>();
  for (const resource of resources) { const meta = resourceGroup(resource, mode); const group = groups.get(meta.key) ?? { ...meta, resources: [] }; group.resources.push(resource); groups.set(meta.key, group); }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, "es"));
}
export function resourceAxes(resources: readonly DetailedResource[], now: number) { return { available: resources.filter(r => describeResourceState(r, now).tone === "on").length, healthKnown: resources.filter(r => [r.health?.service, ...Object.values(r.serviceSignals ?? {})].some(signal => signal && signal.state !== "unknown")).length, healthProblems: resources.filter(r => hasServiceProblem(r) || describeResourceState(r, now).tone === "bad").length, stale: resources.filter(r => isStale(r, now)).length, observed: resources.filter(r => r.observedAt !== null).length, total: resources.length }; }
export interface WriteContext { online: boolean; visible: boolean; canWrite: boolean; sending: boolean; ambiguous: boolean; now: number; retryAt: number; inventory: { loading: boolean; error: unknown; data: unknown }; operations: { error: unknown; data: unknown } }
export function actionBlocker(resource: DetailedResource, action: Action, app: WriteContext, operations: readonly Operation[]): string | null {
  if (!app.online) return "Sin conexión. No se envían órdenes ni se dejan en cola."; if (!app.visible) return "Vuelve a la app para enviar la orden."; if (app.ambiguous) return "Recupera el mismo envío pendiente antes de dar otra orden."; if (app.sending) return "Hay un envío en curso."; if (app.now < app.retryAt) return "Respeta la espera indicada por el servidor.";
  if (app.inventory.loading || app.inventory.error || !app.inventory.data || app.operations.error || !app.operations.data) return "Primero comprueba el inventario y la actividad.";
  if (operations.some(o => o.resourceId === resource.id && isActiveOperation(o))) return "Hay una orden activa para este recurso.";
  if (!resource.actions.includes(action)) return reasonLabel(resource.actionAvailability?.[action]?.reasonCode) ?? "El proveedor no ofrece esta acción para el estado y los permisos actuales.";
  const availability = resource.actionAvailability?.[action]; if (availability?.allowed === false) return reasonLabel(availability.reasonCode) ?? "Acción no disponible en la última observación."; if (!app.canWrite) return "Las escrituras no están disponibles ahora."; return null;
}
export function money(value: number | null, currency: string): string { if (value === null || !Number.isFinite(value)) return "—"; return `${currency === "USD" ? "US$" : currency} ${value.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
export function dailyCosts(accounts: readonly CostAccount[], currency = "USD") {
  const usable = accounts.filter(a => a.status === "available" && a.currency === currency && a.net !== null && Number.isFinite(a.net)); if (!usable.length) return [];
  const dates = [...new Set(usable.flatMap(a => a.daily.map(d => d.date)))].sort();
  return dates.map(date => { const amounts = usable.map(a => a.daily.find(d => d.date === date)?.amount); return { date, amount: amounts.every(n => n !== undefined && Number.isFinite(n)) ? amounts.reduce<number>((sum, n) => sum + (n as number), 0) : null }; });
}
export interface MapBounds { x: number; y: number; width: number; height: number }
interface MapEntry { key: string; id: string; name: string; kind: "resource" | "service"; group: string; groupTitle: string; problem: boolean; height: number }
export interface MapNode extends MapEntry { x: number; y: number; labelLines: string[]; labelWidth: number; labelHeight: number; bounds: MapBounds }
/** Líneas completas, incluidas palabras largas. El renderer usa el mismo tamaño de fuente y cajas. */
export function mapLabel(text: string) {
  const chars = Array.from(text); const lines: string[] = [];
  for (let index = 0; index < chars.length; index += 18) lines.push(chars.slice(index, index + 18).join(""));
  if (!lines.length) lines.push("");
  return { lines, width: Math.max(140, ...lines.map(line => Array.from(line).length * 13 + 24)), height: lines.length * 18 + 12 };
}
export function mapLayout(resources: readonly DetailedResource[], services: readonly CatalogServiceRecord[], mode: "location" | "project", now: number, query = "", problemsOnly = false, maxZoneColumns = 3) {
  const entries: MapEntry[] = resources.map(r => {
    const group = resourceGroup(r, mode);
    const location = mode === "location" && r.catalog?.provider === "host" ? { key: JSON.stringify(["host", r.catalog.accountId, r.catalog.region]), title: `Host · ${r.account}` } : mode === "location" ? { key: JSON.stringify([r.catalog?.provider ?? (r.kind === "ec2" ? "aws" : r.kind === "service" ? "coolify" : "local"), r.catalog?.accountId ?? r.account, r.kind === "ec2" ? r.catalog?.region ?? r.location : null]), title: r.kind === "ec2" ? `AWS · ${r.account} · ${r.catalog?.region ?? r.location}` : r.kind === "service" ? `Coolify · ${r.account}` : r.account } : group;
    return { key: "r:" + r.id, id: r.id, name: r.name, kind: "resource", group: location.key, groupTitle: location.title, problem: needsAttention(r, now), height: r.kind === "ec2" ? 50 : r.kind === "router" ? 12 : r.kind === "computer" ? 36 : 28 };
  });
  for (const service of services.filter(s => s.active)) {
    const title = [service.project ?? "Sin proyecto", service.environment].filter(Boolean).join(" · ");
    const host = service.relations.filter(relation => relation.relationType === "hosted_on").map(relation => relatedResource(relation, resources)).find(Boolean);
    const hostEntry = mode === "location" && host ? entries.find(entry => entry.kind === "resource" && entry.id === host.id) : undefined;
    entries.push({ key: "s:" + service.id, id: service.id, name: service.name, kind: "service", group: hostEntry?.group ?? (mode === "project" ? JSON.stringify([service.projectId ?? service.project, service.environment]) : "catalog:" + JSON.stringify([service.projectId ?? service.project, service.environment])), groupTitle: hostEntry?.groupTitle ?? (mode === "project" ? title : "Servicios · " + title), problem: serviceObservation(service, resources, now).problem, height: 24 });
  }
  const filtered = entries.filter(n => matchesText(query, n.name, n.id, n.groupTitle) && (!problemsOnly || n.problem)); const groups = [...new Set(filtered.map(n => n.group))].sort();
  const zoneColumns = Math.min(Math.max(1, maxZoneColumns), Math.max(1, Math.ceil(Math.sqrt(groups.length))));
  const locals = groups.map(key => {
    const members = filtered.filter(n => n.group === key).sort((a, b) => a.name.localeCompare(b.name, "es")); const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(members.length)))); const rows = Math.ceil(members.length / columns);
    const labels = members.map(member => mapLabel(member.name));
    const widest = Math.max(...labels.map(label => label.width)); const tallest = Math.max(...members.map((member, index) => member.height + labels[index]!.height + 47));
    // Vecinos diagonales se separan en X; nodos con igual X se separan en Y. Se conserva la proyección 2:1.
    const step = Math.max(widest, tallest) + 24;
    const nodes = members.map((member, index): MapNode => {
      const u = index % columns - (columns - 1) / 2; const v = Math.floor(index / columns) - (rows - 1) / 2;
      const x = (u - v) * step; const y = (u + v) * step / 2; const label = labels[index]!;
      return { ...member, x, y, labelLines: label.lines, labelWidth: label.width, labelHeight: label.height, bounds: { x: x - label.width / 2, y: y - member.height - 28 - label.height, width: label.width, height: member.height + label.height + 47 } };
    });
    const radius = Math.max(120, (columns + rows - 2) * step / 2 + 54);
    const title = members[0]!.groupTitle; const titleLabel = mapLabel(title);
    const titleY = Math.max(radius / 2, ...nodes.map(node => node.bounds.y + node.bounds.height)) + 26;
    const left = Math.min(-radius, -titleLabel.width / 2, ...nodes.map(node => node.bounds.x)); const right = Math.max(radius, titleLabel.width / 2, ...nodes.map(node => node.bounds.x + node.bounds.width));
    const top = Math.min(-radius / 2, ...nodes.map(node => node.bounds.y)); const bottom = titleY + titleLabel.height;
    return { key, title, nodes, radius, titleLines: titleLabel.lines, titleY, left, top, width: right - left, height: bottom - top };
  });
  const colWidths: number[] = []; const rowHeights: number[] = [];
  locals.forEach((zone, index) => { const col = index % zoneColumns; const row = Math.floor(index / zoneColumns); colWidths[col] = Math.max(colWidths[col] ?? 0, zone.width); rowHeights[row] = Math.max(rowHeights[row] ?? 0, zone.height); });
  const gap = 36; const padding = 32; const nodes: MapNode[] = [];
  const zones: { key: string; title: string; x: number; y: number; radius: number; count: number; titleLines: string[]; titleY: number; bounds: MapBounds }[] = [];
  locals.forEach((zone, index) => {
    const col = index % zoneColumns; const row = Math.floor(index / zoneColumns);
    const left = padding + colWidths.slice(0, col).reduce((sum, width) => sum + width + gap, 0); const top = padding + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gap, 0);
    const dx = left - zone.left; const dy = top - zone.top;
    zones.push({ key: zone.key, title: zone.title, x: dx, y: dy, radius: zone.radius, count: zone.nodes.length, titleLines: zone.titleLines, titleY: dy + zone.titleY, bounds: { x: left, y: top, width: zone.width, height: zone.height } });
    nodes.push(...zone.nodes.map(node => ({ ...node, x: node.x + dx, y: node.y + dy, bounds: { ...node.bounds, x: node.bounds.x + dx, y: node.bounds.y + dy } })));
  });
  const index = new Map(nodes.map(node => [node.key, node]));
  const edges = services.filter(s => s.active).flatMap(s => s.relations.flatMap((relation, i) => { const resource = relatedResource(relation, resources); const from = index.get("s:" + s.id); const to = resource ? index.get("r:" + resource.id) : undefined; return from && to ? [{ key: `${s.id}:${i}`, from, to, type: relation.relationType, evidence: relation.evidence }] : []; }));
  return { nodes, zones, edges, width: Math.max(420, colWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, colWidths.length - 1) * gap + padding * 2), height: Math.max(400, rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rowHeights.length - 1) * gap + padding * 2) };
}
