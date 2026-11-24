import { useId, type CSSProperties, type ReactElement } from "react";
import type { FleetStatus, FleetZone } from "../lib/hoyModel.ts";

/** Proyección isométrica determinista: x = (gx − gy)·TW/2, y = (gx + gy)·TH/2 − z. */
const TW = 30;
const TH = 15;
const PLATFORM_H = 5;
const SERVER_H = 17;
const SERVER_SIZE = 0.62;
const ZONE_GAP = 1.4;
/** Más allá de este número, una zona apila el resto en un bloque «+N»; los fallos van primero y, si alguno queda apilado, el bloque se enciende en rojo. */
const MAX_PER_ZONE = 12;

type Pt = readonly [number, number];
const pt = (gx: number, gy: number, z = 0): Pt => [(gx - gy) * TW / 2, (gx + gy) * TH / 2 - z];
const poly = (points: readonly Pt[]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function prism(gx0: number, gy0: number, gx1: number, gy1: number, z0: number, h: number) {
  const a = pt(gx0, gy0, z0 + h), b = pt(gx1, gy0, z0 + h), c = pt(gx1, gy1, z0 + h), d = pt(gx0, gy1, z0 + h);
  const b0 = pt(gx1, gy0, z0), c0 = pt(gx1, gy1, z0), d0 = pt(gx0, gy1, z0);
  return { top: poly([a, b, c, d]), left: poly([d, c, c0, d0]), right: poly([b, c, c0, b0]) };
}

interface PlacedZone { zone: FleetZone; gx: number; gy: number; cols: number; rows: number; shown: FleetZone["nodes"]; hidden: number }

/** Las zonas se colocan de dos en dos por fila; dentro de cada zona, rejilla casi cuadrada. */
export function placeZones(zones: readonly FleetZone[]): PlacedZone[] {
  const sized = zones.map(zone => {
    const problems = zone.nodes.filter(node => node.status === "bad");
    const rest = zone.nodes.filter(node => node.status !== "bad");
    const visible = zone.nodes.length > MAX_PER_ZONE ? [...problems, ...rest].slice(0, MAX_PER_ZONE - 1) : zone.nodes;
    const slots = visible.length + (zone.nodes.length > visible.length ? 1 : 0);
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(slots * 1.5))));
    return { zone, shown: visible, hidden: zone.nodes.length - visible.length, cols, rows: Math.max(1, Math.ceil(slots / cols)) };
  });
  const placed: PlacedZone[] = [];
  let gy = 0;
  for (let i = 0; i < sized.length; i += 2) {
    const first = sized[i]!; const second = sized[i + 1];
    placed.push({ ...first, gx: 0, gy });
    if (second) placed.push({ ...second, gx: first.cols + ZONE_GAP, gy: gy - 0.3 });
    gy += Math.max(first.rows, second?.rows ?? 0) + ZONE_GAP;
  }
  return placed;
}

const LED: Record<FleetStatus, string> = { ok: "var(--fleet-ok)", bad: "var(--fleet-bad)", off: "var(--fleet-off)", busy: "var(--fleet-busy)", unc: "var(--fleet-unc)", stale: "var(--fleet-stale)", unknown: "var(--fleet-unknown)" };

interface FleetSceneProps {
  zones: readonly FleetZone[];
  /** Ancho en píxeles del dibujo; el alto sale de la proporción. */
  width: number;
  /** Etiquetas de zona («AWS · 6»). */
  labels?: boolean;
  /** Muestra el nombre de los equipos con fallo junto a su luz. */
  callouts?: boolean;
  /** Pantalla de acceso: luces de marca, sin estados reales. */
  decorative?: boolean;
}

export function FleetScene({ zones, width, labels = true, callouts = false, decorative = false }: FleetSceneProps) {
  const glow = useId().replace(/:/g, "");
  const placed = placeZones(zones);
  const xs: number[] = []; const ys: number[] = [];
  const track = (...points: Pt[]) => { for (const [x, y] of points) { xs.push(x); ys.push(y); } };
  const shapes: ReactElement[] = [];
  placed.forEach((z, zi) => {
    const x0 = z.gx - 0.25, y0 = z.gy - 0.25, x1 = z.gx + z.cols + 0.05, y1 = z.gy + z.rows + 0.05;
    const p = prism(x0, y0, x1, y1, 0, PLATFORM_H);
    track(pt(x0, y0, PLATFORM_H), pt(x1, y1), pt(x0, y1), pt(x1, y0));
    shapes.push(<g key={`z${zi}`} className="fleet__plat"><polygon points={p.left} className="fleet__l" /><polygon points={p.right} className="fleet__r" /><polygon points={p.top} className="fleet__t" /></g>);
    const slots: { status: FleetStatus | "stack"; name: string; id: string; alarm?: boolean }[] = z.shown.map(node => ({ status: node.status, name: node.name, id: node.id }));
    const shownIds = new Set(z.shown.map(node => node.id));
    if (z.hidden > 0) slots.push({ status: "stack", name: `+${z.hidden}`, id: `${z.zone.name}-stack`, alarm: z.zone.nodes.some(node => node.status === "bad" && !shownIds.has(node.id)) });
    const cells = slots.map((slot, index) => ({ slot, dx: index % z.cols, dy: Math.floor(index / z.cols) })).sort((a, b) => a.dx + a.dy - (b.dx + b.dy));
    for (const { slot, dx, dy } of cells) {
      const gx = z.gx + dx + 0.15, gy = z.gy + dy + 0.15;
      const off = slot.status === "off";
      const height = slot.status === "stack" ? SERVER_H * 0.6 : SERVER_H;
      const s = prism(gx, gy, gx + SERVER_SIZE, gy + SERVER_SIZE, PLATFORM_H, height);
      const [lx, ly] = pt(gx + SERVER_SIZE, gy + SERVER_SIZE / 2, PLATFORM_H + height * 0.55);
      const [tx, ty] = pt(gx + SERVER_SIZE / 2, gy + SERVER_SIZE / 2, PLATFORM_H + height);
      const status: FleetStatus | "stack" = decorative && slot.status !== "off" ? "ok" : slot.status;
      const color = decorative ? "var(--fleet-brand)" : status === "stack" ? (slot.alarm ? LED.bad : "var(--fleet-off)") : LED[status];
      const lit = status !== "off" && status !== "unknown" && (status !== "stack" || !!slot.alarm);
      if (callouts && status === "bad") track([tx + 14 + slot.name.length * 7.5, ty - 24]);
      shapes.push(<g key={slot.id} className={`fleet__srv${off ? " fleet__srv--off" : ""}`}>
        <polygon points={s.left} className="fleet__l" /><polygon points={s.right} className="fleet__r" /><polygon points={s.top} className="fleet__t" />
        {lit && <circle cx={lx} cy={ly} r={status === "bad" ? 6.5 : 4.5} fill={color} opacity={status === "bad" ? 0.55 : 0.35} filter={`url(#${glow})`} />}
        {status === "unknown" ? <circle cx={lx} cy={ly} r={2} fill="none" stroke={color} strokeWidth={1} /> : status !== "stack" && <circle cx={lx} cy={ly} r={2} fill={color} />}
        {status === "stack" && <text x={tx} y={ty - 4} textAnchor="middle" className="fleet__stack">{slot.name}</text>}
        {status === "bad" && <ellipse cx={tx} cy={ty} rx={14} ry={7} fill="none" stroke={color} strokeWidth={1.2} className="fleet__pulse" />}
        {status === "busy" && <ellipse cx={tx} cy={ty} rx={12} ry={6} fill="none" stroke={color} strokeWidth={1.4} strokeDasharray="4 3" className="fleet__spin" />}
        {callouts && status === "bad" && <text x={tx + 14} y={ty - 12} className="fleet__callout">{slot.name}</text>}
        {status === "stack" && slot.alarm && <circle cx={lx} cy={ly} r={2} fill={color} />}
      </g>);
    }
    if (labels && !decorative) {
      const [lx, ly] = pt(x1, y1);
      shapes.push(<text key={`l${zi}`} x={lx} y={ly + 18} textAnchor="middle" className="fleet__label">{z.zone.name} · {z.zone.nodes.length}</text>);
      track([lx - 40, ly + 22], [lx + 40, ly + 22]);
    }
  });
  if (!xs.length) return null;
  const pad = 12;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - 30, w = Math.max(...xs) + pad - minX, h = Math.max(...ys) + pad - minY;
  // El texto se escala con el dibujo: se compensa para que mida lo mismo en pantalla a cualquier ancho.
  const unit = w / width;
  const style = { "--fleet-u": unit.toFixed(3) } as CSSProperties;
  return <svg className={`fleet${decorative ? " fleet--decorative" : ""}`} style={style} viewBox={`${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`} width={width} height={Math.round(width * h / w)} aria-hidden="true" focusable="false">
    <defs><filter id={glow} x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="3.2" /></filter></defs>
    {shapes}
  </svg>;
}

/** Escena de la pantalla de acceso: siempre la misma forma, sin ningún dato del inventario. */
export const DECORATIVE_ZONES: readonly FleetZone[] = [
  { name: "AWS", nodes: ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, name: id, status: i === 2 || i === 5 ? "off" as const : "ok" as const })) },
  { name: "Coolify", nodes: ["g", "h", "i"].map(id => ({ id, name: id, status: "ok" as const })) },
  { name: "Casa", nodes: ["j", "k", "l"].map((id, i) => ({ id, name: id, status: i === 0 ? "off" as const : "ok" as const })) },
];
