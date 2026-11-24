import type { CatalogServiceRecord, DetailedResource } from "../contract.ts";
import { relatedResource } from "./controlModel.ts";
import { problemCounts, worstStatus, type InvItem, type InvShape, type InvStatus, type ProblemCounts } from "./invModel.ts";

/**
 * Plano isométrico del inventario: posición determinista (zona → orden de gravedad), sin dibujar a mano.
 * Coordenadas de mundo; la cámara las lleva a píxeles. Las etiquetas se dibujan en píxeles de pantalla.
 */
export const STEP_X = 90;
export const STEP_Y = 45;
export const CUBE_HALF = 34;
const FLOOR_MARGIN = 0.72;
const ZONE_GAP = 70;
const LABEL_SPACE = 64;
const TITLE_SPACE = 44;

export const SHAPE_HEIGHT: Readonly<Record<InvShape, number>> = { ec2: 54, computer: 40, router: 18, app: 32, service: 26 };

export interface Box { x: number; y: number; w: number; h: number }
export interface MapNode { item: InvItem; x: number; y: number; h: number; zone: string }
export interface MapZone {
  key: string; title: string; sub: string | null; items: InvItem[]; status: InvStatus; counts: ProblemCounts;
  /** Esquinas del suelo (arriba, derecha, abajo, izquierda). */
  floor: [number, number][];
  cx: number; cy: number; top: number; bottom: number; bounds: Box;
}
export interface MapEdge { key: string; from: MapNode; to: MapNode; type: "hosted_on" | "depends_on"; affected: boolean }
export interface MapLayout { nodes: MapNode[]; zones: MapZone[]; edges: MapEdge[]; bounds: Box }

const iso = (i: number, j: number): [number, number] => [(i - j) * STEP_X, (i + j) * STEP_Y];

interface LocalZone { key: string; items: InvItem[]; cols: number; rows: number; floor: [number, number][]; box: Box; maxH: number }

function localZone(key: string, items: InvItem[]): LocalZone {
  const cols = Math.max(1, Math.ceil(Math.sqrt(items.length)));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const m = FLOOR_MARGIN;
  const floor: [number, number][] = [iso(-m, -m), iso(cols - 1 + m, -m), iso(cols - 1 + m, rows - 1 + m), iso(-m, rows - 1 + m)];
  const maxH = Math.max(...items.map(item => SHAPE_HEIGHT[item.shape]));
  const xs = floor.map(p => p[0]); const ys = floor.map(p => p[1]);
  const top = Math.min(...ys) - maxH - LABEL_SPACE; const bottom = Math.max(...ys) + TITLE_SPACE;
  return { key, items, cols, rows, floor, maxH, box: { x: Math.min(...xs), y: top, w: Math.max(...xs) - Math.min(...xs), h: bottom - top } };
}

/**
 * `items` ya filtrados. Las zonas se ordenan por título (posición estable entre lecturas); dentro de la zona,
 * el orden recibido (gravedad) pone lo que falla en la esquina superior, siempre a la vista.
 */
export function buildMap(items: readonly InvItem[], services: readonly CatalogServiceRecord[], resources: readonly DetailedResource[], columns: number): MapLayout {
  const byZone = new Map<string, InvItem[]>();
  for (const item of items) byZone.set(item.zone.key, [...(byZone.get(item.zone.key) ?? []), item]);
  const keys = [...byZone.keys()].sort((a, b) => byZone.get(a)![0]!.zone.title.localeCompare(byZone.get(b)![0]!.zone.title, "es") || a.localeCompare(b));
  const locals = keys.map(key => localZone(key, byZone.get(key)!));
  const cols = Math.max(1, Math.min(columns, locals.length));
  const colW: number[] = []; const rowH: number[] = [];
  locals.forEach((zone, index) => { const c = index % cols; const r = Math.floor(index / cols); colW[c] = Math.max(colW[c] ?? 0, zone.box.w); rowH[r] = Math.max(rowH[r] ?? 0, zone.box.h); });
  const nodes: MapNode[] = []; const zones: MapZone[] = [];
  locals.forEach((zone, index) => {
    const c = index % cols; const r = Math.floor(index / cols);
    const left = colW.slice(0, c).reduce((sum, w) => sum + w + ZONE_GAP, 0) + ((colW[c] ?? 0) - zone.box.w) / 2;
    const top = rowH.slice(0, r).reduce((sum, h) => sum + h + ZONE_GAP, 0);
    const dx = left - zone.box.x; const dy = top - zone.box.y;
    const floor = zone.floor.map(([x, y]) => [x + dx, y + dy] as [number, number]);
    zone.items.forEach((item, i) => {
      const [x, y] = iso(i % zone.cols, Math.floor(i / zone.cols));
      nodes.push({ item, x: x + dx, y: y + dy, h: SHAPE_HEIGHT[item.shape], zone: zone.key });
    });
    const first = zone.items[0]!;
    zones.push({
      key: zone.key, title: first.zone.title, sub: first.zone.sub, items: zone.items, status: worstStatus(zone.items), counts: problemCounts(zone.items), floor,
      cx: (floor[1]![0] + floor[3]![0]) / 2, cy: (floor[0]![1] + floor[2]![1]) / 2, top: floor[0]![1] - zone.maxH, bottom: floor[2]![1],
      bounds: { x: zone.box.x + dx, y: zone.box.y + dy, w: zone.box.w, h: zone.box.h },
    });
  });
  const index = new Map(nodes.map(node => [node.item.key, node]));
  const edges = services.filter(s => s.active).flatMap(service => service.relations.flatMap((relation, i) => {
    const target = relatedResource(relation, resources); const from = index.get(`s:${service.id}`); const to = target ? index.get(`r:${target.id}`) : undefined;
    return from && to ? [{ key: `${service.id}:${i}`, from, to, type: relation.relationType, affected: to.item.status === "bad" }] : [];
  }));
  const width = colW.reduce((sum, w) => sum + w, 0) + Math.max(0, colW.length - 1) * ZONE_GAP;
  const height = rowH.reduce((sum, h) => sum + h, 0) + Math.max(0, rowH.length - 1) * ZONE_GAP;
  return { nodes, zones, edges, bounds: { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) } };
}

/** Caras de un cubo isométrico centrado en (x, y) del suelo. */
export function cubeFaces(x: number, y: number, h: number, half = CUBE_HALF) {
  const q = half / 2;
  const pts = (list: [number, number][]) => list.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  return {
    top: pts([[x, y - q - h], [x + half, y - h], [x, y + q - h], [x - half, y - h]]),
    left: pts([[x - half, y - h], [x, y + q - h], [x, y + q], [x - half, y]]),
    right: pts([[x + half, y - h], [x, y + q - h], [x, y + q], [x + half, y]]),
    base: pts([[x, y - q - 6], [x + half + 12, y], [x, y + q + 6], [x - half - 12, y]]),
  };
}

/* ---------------- Cámara ---------------- */

export interface Camera { k: number; x: number; y: number }
export interface View { w: number; h: number }

/** Por debajo de esta escala se ven zonas (con conteo y fallos); por encima, nodos con su nombre. */
export const NODE_LEVEL_K = 0.62;
export const MAX_K = 2.6;

export function fitCamera(box: Box, view: View, pad = 28): Camera {
  const w = Math.max(1, view.w - pad * 2); const h = Math.max(1, view.h - pad * 2);
  const k = Math.min(MAX_K, Math.max(0.05, Math.min(w / Math.max(1, box.w), h / Math.max(1, box.h))));
  return { k, x: view.w / 2 - (box.x + box.w / 2) * k, y: view.h / 2 - (box.y + box.h / 2) * k };
}

export function minZoom(fit: Camera): number { return Math.max(0.05, Math.min(fit.k * 0.7, 0.5)); }

/** Amplía `factor` veces manteniendo fijo el punto de pantalla (sx, sy). */
export function zoomAt(camera: Camera, sx: number, sy: number, factor: number, min: number, max = MAX_K): Camera {
  const k = Math.min(max, Math.max(min, camera.k * factor));
  const wx = (sx - camera.x) / camera.k; const wy = (sy - camera.y) / camera.k;
  return { k, x: sx - wx * k, y: sy - wy * k };
}

/** El contenido nunca sale del todo de la vista: queda al menos `keep` px dentro. */
export function clampCamera(camera: Camera, box: Box, view: View, keep = 80): Camera {
  const left = box.x * camera.k + camera.x; const right = (box.x + box.w) * camera.k + camera.x;
  const top = box.y * camera.k + camera.y; const bottom = (box.y + box.h) * camera.k + camera.y;
  const kx = Math.min(keep, (right - left) / 2); const ky = Math.min(keep, (bottom - top) / 2);
  let x = camera.x; let y = camera.y;
  if (right < kx) x += kx - right; if (left > view.w - kx) x -= left - (view.w - kx);
  if (bottom < ky) y += ky - bottom; if (top > view.h - ky) y -= top - (view.h - ky);
  return { k: camera.k, x, y };
}

export function toScreen(camera: Camera, x: number, y: number): [number, number] { return [x * camera.k + camera.x, y * camera.k + camera.y]; }

/** Interpola el centro del mundo y la escala en logaritmo: el zoom animado se siente uniforme. */
export function lerpCamera(a: Camera, b: Camera, t: number, view: View): Camera {
  const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * e);
  const cx = view.w / 2; const cy = view.h / 2;
  const ax = (cx - a.x) / a.k; const ay = (cy - a.y) / a.k; const bx = (cx - b.x) / b.k; const by = (cy - b.y) / b.k;
  return { k, x: cx - (ax + (bx - ax) * e) * k, y: cy - (ay + (by - ay) * e) * k };
}

/* ---------------- Etiquetas sin solaparse ---------------- */

export interface LabelBox { key: string; x: number; y: number; w: number; h: number; priority: number }

/** Ancho aproximado de una etiqueta (13 px sans + meta mono), sin medir el DOM. */
export function labelWidth(name: string, meta: string, max = 190): number {
  return Math.min(max, 34 + Math.min(name.length, 22) * 7.3 + (meta ? 8 + meta.length * 7 : 0));
}

/**
 * Coloca etiquetas por prioridad (lo que falla primero) y oculta las que chocarían. Cajas ancladas
 * abajo-centro (x, y) como el CSS. Devuelve las claves visibles.
 */
export function placeLabels(boxes: readonly LabelBox[], gap = 4): Set<string> {
  const placed: LabelBox[] = []; const visible = new Set<string>();
  for (const box of [...boxes].sort((a, b) => a.priority - b.priority)) {
    const l = box.x - box.w / 2, r = box.x + box.w / 2, t = box.y - box.h, b = box.y;
    const hit = placed.some(p => l < p.x + p.w / 2 + gap && r > p.x - p.w / 2 - gap && t < p.y + gap && b > p.y - p.h - gap);
    if (!hit) { placed.push(box); visible.add(box.key); }
  }
  return visible;
}
