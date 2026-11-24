import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CatalogServiceRecord, DetailedResource } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useMediaQuery } from "../hooks/usePlatform.ts";
import { age, matchesText } from "../lib/controlModel.ts";
import { activeResourceIds, bySeverity, SEVERITY, chipNote, isProblem, mapItems, problemSummary, STATUS_TONE, type InvItem } from "../lib/invModel.ts";
import { buildMap, labelWidth, placeLabels, clampCamera, cubeFaces, fitCamera, lerpCamera, minZoom, NODE_LEVEL_K, toScreen, zoomAt, CUBE_HALF, type Camera, type MapLayout, type MapZone, type View } from "../lib/invMap.ts";
import { Chip, Empty, Row, Rows, Segmented } from "./v2.tsx";
import { InvDot } from "./inv-rows.tsx";
import { InvPeek } from "./inv-peek.tsx";

export type MapMode = "location" | "project";

interface InfrastructureMapProps {
  resources: readonly DetailedResource[];
  services: readonly CatalogServiceRecord[];
  query: string;
  problems: boolean;
  onProblems: (next: boolean) => void;
}

const FALLBACK_VIEW: View = { w: 360, h: 420 };
const DRAG_SLOP = 6;
const DOUBLE_TAP_MS = 300;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Mapa con gestos de verdad: arrastrar mueve, pellizcar o la rueda acercan, doble toque amplía. La página no se desplaza. */
export function InfrastructureMap({ resources, services, query, problems, onProblems }: InfrastructureMapProps) {
  const app = useAppState();
  const wide = useMediaQuery("(min-width: 1101px)");
  const [mode, setMode] = useState<MapMode>("location");
  const activeIds = activeResourceIds(app.operations.data?.operations ?? []);
  const items = mapItems(resources, services, mode, app.now, activeIds)
    .filter(item => matchesText(query, item.name, item.id, item.zone.title))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const signature = `${mode}|${wide ? 3 : 2}|${items.map(i => i.key).sort().join(",")}`;
  // La posición depende solo de qué nodos hay y de la vista: un cambio de estado no mueve el plano.
  const layout = useMemo(() => buildMap(items, services, resources, wide ? 3 : 2), [signature, app.now]);
  const layoutRef = useRef(layout); layoutRef.current = layout;

  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FALLBACK_VIEW);
  const viewRef = useRef(view); viewRef.current = view;
  const fit = fitCamera(layout.bounds, view);
  const [camera, setCameraState] = useState<Camera>(fit);
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const fitted = useRef(true);
  const animation = useRef<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoneKey, setZoneKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const limits = { min: minZoom(fit) };
  const apply = useCallback((next: Camera, user = true) => {
    if (animation.current !== null) { cancelAnimationFrame(animation.current); animation.current = null; }
    if (user) fitted.current = false;
    setCameraState(clampCamera(next, layoutRef.current.bounds, viewRef.current));
  }, []);
  const animateTo = useCallback((target: Camera, user = true) => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    if (user) fitted.current = false;
    const from = cameraRef.current; const goal = clampCamera(target, layoutRef.current.bounds, viewRef.current);
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") { setCameraState(goal); return; }
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, Math.max(0, (performance.now() - start) / 260));
      setCameraState(lerpCamera(from, goal, t, viewRef.current));
      animation.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    animation.current = requestAnimationFrame(step);
  }, []);
  const fitAll = useCallback(() => { fitted.current = true; setZoneKey(null); animateTo(fitCamera(layoutRef.current.bounds, viewRef.current), false); }, [animateTo]);

  // Tamaño real del lienzo; al cambiar (hoja, giro) se conserva el centro o se reencuadra si no se tocó.
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      const previous = viewRef.current;
      if (next.w === previous.w && next.h === previous.h) return;
      viewRef.current = next; setView(next);
      if (fitted.current) setCameraState(fitCamera(layoutRef.current.bounds, next));
      else setCameraState(c => ({ k: c.k, x: c.x + (next.w - previous.w) / 2, y: c.y + (next.h - previous.h) / 2 }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Cambia el conjunto de nodos (modo, búsqueda, nueva lectura): se reencuadra, y solo se olvida lo que ya no existe.
  useEffect(() => {
    const keys = new Set(layoutRef.current.nodes.map(n => n.item.key)); const zones = new Set(layoutRef.current.zones.map(z => z.key));
    setSelected(key => key && keys.has(key) ? key : null); setZoneKey(key => key && zones.has(key) ? key : null);
    if (fitted.current) setCameraState(fitCamera(layoutRef.current.bounds, viewRef.current));
  }, [signature]);
  useEffect(() => { fitted.current = true; setSelected(null); setZoneKey(null); setCameraState(fitCamera(layoutRef.current.bounds, viewRef.current)); }, [mode, query]);
  useEffect(() => () => { if (animation.current !== null) cancelAnimationFrame(animation.current); }, []);

  const focusZone = useCallback((key: string) => {
    const zone = layoutRef.current.zones.find(z => z.key === key);
    if (!zone) return;
    setZoneKey(key); setSelected(null); setCollapsed(false);
    const target = fitCamera(zone.bounds, viewRef.current, 20);
    const k = Math.min(1.5, Math.max(target.k, NODE_LEVEL_K + 0.08));
    const cx = zone.bounds.x + zone.bounds.w / 2; const cy = zone.bounds.y + zone.bounds.h / 2;
    animateTo({ k, x: viewRef.current.w / 2 - cx * k, y: viewRef.current.h / 2 - cy * k });
  }, [animateTo]);
  const select = useCallback((key: string, pan = false) => {
    setSelected(key); setCollapsed(false);
    const node = layoutRef.current.nodes.find(n => n.item.key === key);
    if (!node) return;
    setZoneKey(node.zone);
    const cam = cameraRef.current; const [sx, sy] = toScreen(cam, node.x, node.y);
    const v = viewRef.current;
    if (pan || cam.k < NODE_LEVEL_K || sx < 40 || sx > v.w - 40 || sy < 60 || sy > v.h - 20) {
      const k = Math.max(cam.k, NODE_LEVEL_K + 0.2);
      animateTo({ k, x: v.w / 2 - node.x * k, y: v.h / 2 - (node.y - node.h / 2) * k });
    }
  }, [animateTo]);
  const zoomBy = (factor: number) => animateTo(zoomAt(cameraRef.current, viewRef.current.w / 2, viewRef.current.h / 2, factor, limits.min));

  /* ---------- Gestos ---------- */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: Camera; p0: { x: number; y: number }; dist0: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const local = (event: { clientX: number; clientY: number }) => { const rect = stage.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const startGesture = () => {
    const points = [...pointers.current.values()];
    if (points.length >= 2) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = { start: cameraRef.current, p0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), moved: true };
    } else if (points.length === 1) gesture.current = { start: cameraRef.current, p0: points[0]!, dist0: 0, moved: gesture.current?.moved ?? false };
    else gesture.current = null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (pointers.current.size === 0) suppressClick.current = false;
    if (animation.current !== null) { cancelAnimationFrame(animation.current); animation.current = null; }
    pointers.current.set(event.pointerId, local(event));
    if (pointers.current.size === 2) { for (const id of pointers.current.keys()) { try { stage.current?.setPointerCapture(id); } catch { /* puntero ya liberado */ } } }
    startGesture();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, local(event));
    const g = gesture.current; const points = [...pointers.current.values()];
    if (points.length >= 2) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const zoomed = zoomAt(g.start, g.p0.x, g.p0.y, dist / g.dist0, limits.min);
      apply({ k: zoomed.k, x: zoomed.x + mid.x - g.p0.x, y: zoomed.y + mid.y - g.p0.y });
      return;
    }
    const p = points[0]!; const dx = p.x - g.p0.x; const dy = p.y - g.p0.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!g.moved) { g.moved = true; try { stage.current?.setPointerCapture(event.pointerId); } catch { /* sin captura */ } }
    apply({ k: g.start.k, x: g.start.x + dx, y: g.start.y + dy });
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const moved = gesture.current?.moved ?? false;
    const point = pointers.current.get(event.pointerId)!;
    pointers.current.delete(event.pointerId);
    if (moved) suppressClick.current = true;
    if (pointers.current.size > 0) { startGesture(); return; }
    gesture.current = null;
    if (moved || event.type === "pointercancel" || event.pointerType === "mouse") return;
    const now = performance.now(); const previous = lastTap.current;
    if (previous && now - previous.t < DOUBLE_TAP_MS && Math.hypot(point.x - previous.x, point.y - previous.y) < 30) {
      lastTap.current = null; suppressClick.current = true;
      animateTo(zoomAt(cameraRef.current, point.x, point.y, 2, limits.min));
    } else lastTap.current = { t: now, x: point.x, y: point.y };
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
      apply(zoomAt(cameraRef.current, event.clientX - rect.left, event.clientY - rect.top, factor, minZoom(fitCamera(layoutRef.current.bounds, viewRef.current))));
    };
    const block = (event: Event) => event.preventDefault();
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", block); element.addEventListener("gesturechange", block);
    return () => { element.removeEventListener("wheel", wheel); element.removeEventListener("gesturestart", block); element.removeEventListener("gesturechange", block); };
  }, [apply]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const pan: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
    const offset = pan[event.key];
    if (offset) { event.preventDefault(); apply({ ...cameraRef.current, x: cameraRef.current.x + offset[0], y: cameraRef.current.y + offset[1] }); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoomBy(0.8); }
    else if (event.key === "0") { event.preventDefault(); fitAll(); }
  };

  const nodeLevel = camera.k >= NODE_LEVEL_K;
  const zoom = Math.round(camera.k / fit.k * 100);
  const selectedItem = items.find(item => item.key === selected) ?? null;
  const background = Math.max(12, 30 * camera.k);
  const clicked = (handler: () => void) => () => { if (suppressClick.current) { suppressClick.current = false; return; } handler(); };

  return <div className={`inv-mapview${collapsed ? " is-collapsed" : ""}`}>
    <div className="inv-maptools">
      <Segmented label="Agrupar mapa" value={mode} onChange={setMode} items={[{ key: "location", label: "Ubicación" }, { key: "project", label: "Proyecto" }]} />
      <Chip pressed={problems} onClick={() => onProblems(!problems)} dot="bad">Solo problemas</Chip>
      <span className="inv-maptools__meta">{layout.nodes.length} nodos · {layout.zones.length} zonas</span>
    </div>
    <div className="inv-mapview__body">
      <div ref={stage} className={`inv-map${nodeLevel ? " inv-map--nodes" : " inv-map--zones"}${problems ? " inv-map--problems" : ""}`} data-level={nodeLevel ? "nodes" : "zones"} data-zoom={zoom}
        role="application" tabIndex={0} aria-label="Mapa de equipos. Flechas para mover, + y − para acercar o alejar, 0 para encuadrar." aria-describedby="inv-map-zoom"
        style={{ backgroundSize: `${background}px ${background}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onKeyDown={onKeyDown}
        onDoubleClick={event => { const p = local(event); animateTo(zoomAt(cameraRef.current, p.x, p.y, 2, limits.min)); }}
        onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.stopPropagation(); event.preventDefault(); } }}
        onClick={event => { if (event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.dataset.bg)) setSelected(null); }}>
        <span id="inv-map-zoom" className="visually-hidden" aria-live="polite">Zoom {zoom} %</span>
        <MapScene layout={layout} camera={camera} view={view} selected={selected} nodeLevel={nodeLevel} problems={problems} onZone={focusZone} onNode={key => select(key)} />
        <MapLabels layout={layout} camera={camera} width={view.w} selected={selected} nodeLevel={nodeLevel} problems={problems} now={app.now} onZone={key => clicked(() => focusZone(key))()} onNode={key => select(key)} onFar={key => { const node = layout.nodes.find(n => n.item.key === key); if (node && cameraRef.current.k < NODE_LEVEL_K) focusZone(node.zone); }} />
        {!layout.nodes.length && <div className="inv-map__empty"><Empty title={query ? `Nada coincide con «${query}»` : "No hay equipos en el inventario visible."} /></div>}
        <div className="inv-map__ctrls">
          <button type="button" className="inv-ctrl" aria-label="Acercar mapa" onClick={() => zoomBy(1.25)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
          <button type="button" className="inv-ctrl" aria-label="Alejar mapa" onClick={() => zoomBy(0.8)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" /></svg></button>
          <button type="button" className="inv-ctrl" aria-label="Encuadrar" onClick={fitAll}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" /></svg></button>
        </div>
        {wide && <span className="inv-map__zoom" aria-hidden="true">{zoom} %</span>}
      </div>
      <aside className="inv-sheet" aria-label="Inspector del mapa">
        {!wide && <button type="button" className="inv-sheet__handle" aria-expanded={!collapsed} aria-label={collapsed ? "Mostrar lista" : "Ocultar lista"} onClick={() => setCollapsed(c => !c)}><span /></button>}
        <div className="inv-sheet__body">
          {selectedItem ? <InvPeek item={selectedItem} resources={resources} services={services} onClose={() => setSelected(null)} />
            : zoneKey && layout.zones.some(z => z.key === zoneKey) ? <ZoneNodes zone={layout.zones.find(z => z.key === zoneKey)!} onBack={fitAll} onSelect={key => select(key, true)} />
              : <ZoneList zones={layout.zones} onSelect={focusZone} />}
        </div>
      </aside>
    </div>
  </div>;
}

interface SceneProps { layout: MapLayout; camera: Camera; view: View; selected: string | null; nodeLevel: boolean; problems: boolean; onZone: (key: string) => void; onNode: (key: string) => void }

function MapScene({ layout, camera, view, selected, nodeLevel, problems, onZone, onNode }: SceneProps) {
  return <svg className="inv-map__svg" width={view.w} height={view.h} aria-hidden="true" focusable="false">
    <rect data-bg="true" x={0} y={0} width={view.w} height={view.h} fill="transparent" />
    <g transform={`translate(${camera.x.toFixed(1)} ${camera.y.toFixed(1)}) scale(${camera.k.toFixed(4)})`}>
      {layout.zones.map(zone => <polygon key={zone.key} className={`inv-floor inv-floor--${STATUS_TONE[zone.status]}`} points={zone.floor.map(p => p.join(",")).join(" ")} onClick={() => { if (!nodeLevel) onZone(zone.key); }} />)}
      {nodeLevel && layout.edges.map(edge => <path key={edge.key} className={`inv-edge${edge.type === "depends_on" ? " inv-edge--dep" : ""}${edge.affected ? " inv-edge--bad" : ""}`} d={`M${edge.from.x} ${edge.from.y - edge.from.h} Q${(edge.from.x + edge.to.x) / 2} ${Math.min(edge.from.y, edge.to.y) - 120} ${edge.to.x} ${edge.to.y - edge.to.h}`} />)}
      {[...layout.nodes].sort((a, b) => a.y - b.y).map(node => {
        const faces = cubeFaces(node.x, node.y, node.h);
        const tone = STATUS_TONE[node.item.status];
        const dim = problems && !isProblem(node.item.status);
        return <g key={node.item.key} className={`inv-node inv-node--${tone}${selected === node.item.key ? " is-selected" : ""}${dim ? " is-dim" : ""}${node.item.kind === "service" ? " inv-node--svc" : ""}`} onClick={() => nodeLevel ? onNode(node.item.key) : onZone(node.zone)}>
          {(node.item.status === "bad" || node.item.status === "unc" || selected === node.item.key) && <polygon className="inv-node__base" points={faces.base} />}
          <polygon className="inv-node__l" points={faces.left} /><polygon className="inv-node__r" points={faces.right} /><polygon className="inv-node__t" points={faces.top} />
          <circle className="inv-node__led" cx={node.x + CUBE_HALF * 0.5} cy={node.y - node.h * 0.45 + 4} r={5} />
        </g>;
      })}
    </g>
  </svg>;
}

interface LabelProps { layout: MapLayout; camera: Camera; width: number; selected: string | null; nodeLevel: boolean; problems: boolean; now: number; onZone: (key: string) => void; onNode: (key: string) => void; onFar: (key: string) => void }

/** Etiquetas en píxeles de pantalla (12–13 px reales a cualquier zoom). Son botones reales: teclado y lector. */
function MapLabels({ layout, camera, width, selected, nodeLevel, problems, now, onZone, onNode, onFar }: LabelProps) {
  const zoneBoxes = layout.zones.map(zone => { const [x, y] = toScreen(camera, zone.cx, zone.top); const meta = zoneMeta(zone); return { key: zone.key, x, y: y - 10, w: labelWidth(zone.title, meta), h: 34, priority: SEVERITY[zone.status] * 100 - zone.counts.total }; });
  const nodeBoxes = layout.nodes.map(node => { const [x, y] = toScreen(camera, node.x, node.y - node.h - CUBE_HALF / 2); return { key: node.item.key, x, y: y - 8, w: labelWidth(node.item.name, chipNote(node.item, now)), h: 30, priority: node.item.key === selected ? -10 : SEVERITY[node.item.status] }; });
  // Las etiquetas no se salen del lienzo: se acercan al borde sin cortarse.
  const inside = <T extends { x: number; w: number }>(box: T): T => ({ ...box, x: Math.min(Math.max(box.x, box.w / 2 + 6), width - box.w / 2 - 6) });
  const zoneBoxesIn = zoneBoxes.map(inside); const nodeBoxesIn = nodeBoxes.map(inside);
  const shown = placeLabels(nodeLevel ? nodeBoxesIn : zoneBoxesIn);
  const zoneX = new Map(zoneBoxesIn.map(b => [b.key, b.x])); const nodeX = new Map(nodeBoxesIn.map(b => [b.key, b.x]));
  return <div className="inv-map__labels">
    {!nodeLevel && layout.zones.map(zone => {
      const [x, y] = toScreen(camera, zone.cx, zone.top);
      // Dos zonas con el mismo nombre (misma cuenta en otra región) se distinguen por su región.
      const twin = layout.zones.some(other => other.key !== zone.key && other.title === zone.title);
      const summary = problemSummary(zone.counts);
      return <button key={zone.key} type="button" className={`inv-chip inv-chip--zone inv-chip--${STATUS_TONE[zone.status]}${shown.has(zone.key) ? "" : " is-far"}`} style={{ left: zoneX.get(zone.key) ?? x, top: y - 10 }} aria-label={`Acercar a ${zone.title}${zone.sub ? ` ${zone.sub}` : ""}: ${zone.items.length} nodos${summary ? `, ${summary}` : ""}`} onClick={() => onZone(zone.key)}>
        <InvDot status={zone.status} /><span className="inv-chip__name">{zone.title}{twin && zone.sub ? ` · ${zone.sub}` : ""}</span><span className="inv-chip__meta">{zoneMeta(zone)}</span>
      </button>;
    })}
    {nodeLevel && layout.zones.map(zone => { const [x, y] = toScreen(camera, zone.cx, zone.bottom); return <span key={zone.key} className="inv-zone-title" style={{ left: x, top: y + 10 }} aria-hidden="true">{zone.title}{zone.sub && <i> {zone.sub}</i>}</span>; })}
    {layout.nodes.map(node => {
      const [x, y] = toScreen(camera, node.x, node.y - node.h - CUBE_HALF / 2);
      const item = node.item; const note = chipNote(item, now);
      const dim = problems && !isProblem(item.status);
      return <button key={item.key} type="button" className={`inv-chip inv-chip--${STATUS_TONE[item.status]}${nodeLevel && shown.has(item.key) ? "" : " is-far"}${dim ? " is-dim" : ""}`} style={{ left: nodeX.get(item.key) ?? x, top: y - 8 }} aria-label={`Seleccionar ${item.name}`} aria-pressed={selected === item.key} tabIndex={0}
        onFocus={() => { if (!nodeLevel) onFar(item.key); }} onClick={() => onNode(item.key)}>
        <InvDot status={item.status} /><span className="inv-chip__name">{item.name}</span>{note && <span className="inv-chip__meta">{note}</span>}
      </button>;
    })}
  </div>;
}

/** Lo peor de la zona en una palabra; si nada falla, cuántos nodos tiene. */
function zoneMeta(zone: MapZone): string {
  return problemSummary(zone.counts).split(" · ")[0] || String(zone.items.length);
}

function ZoneList({ zones, onSelect }: { zones: readonly MapZone[]; onSelect: (key: string) => void }) {
  const app = useAppState();
  const sorted = [...zones].sort((a, b) => a.counts.bad - b.counts.bad !== 0 ? b.counts.bad - a.counts.bad : b.counts.total - a.counts.total || a.title.localeCompare(b.title, "es"));
  if (!zones.length) return null;
  return <section className="inv-sheet__section" aria-labelledby="inv-zones-title">
    <h2 className="inv-sheet__title" id="inv-zones-title"><span>Zonas</span><span className="v2-card__meta">peor estado primero</span></h2>
    <Rows label="Zonas del mapa">{sorted.map(zone => {
      const worst = [...zone.items].sort(bySeverity)[0]!;
      const summary = problemSummary(zone.counts);
      const freshest = zone.items.map(i => i.observedAt).filter((t): t is string => !!t && Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
      return <li key={zone.key}><Row onClick={() => onSelect(zone.key)} lead={<InvDot status={zone.status} />} title={zone.sub ? <>{zone.title} <span className="inv-muted">{zone.sub}</span></> : zone.title} sub={`${zone.items.length} ${zone.items.length === 1 ? "nodo" : "nodos"}${summary ? ` · ${isProblem(worst.status) ? `${worst.name} ${chipNote(worst, app.now)}` : summary}` : ""}`} age={freshest ? age(freshest, app.now) : undefined} /></li>;
    })}</Rows>
  </section>;
}

function ZoneNodes({ zone, onBack, onSelect }: { zone: MapZone; onBack: () => void; onSelect: (key: string) => void }) {
  const app = useAppState();
  return <section className="inv-sheet__section" aria-labelledby="inv-zone-title">
    <div className="inv-sheet__bar"><button type="button" className="v2-back inv-sheet__back" onClick={onBack}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>Zonas</button></div>
    <h2 className="inv-sheet__title" id="inv-zone-title"><span>{zone.title}{zone.sub && <span className="inv-muted"> {zone.sub}</span>}</span><span className="v2-card__meta">{zone.items.length} {zone.items.length === 1 ? "nodo" : "nodos"}</span></h2>
    <Rows label={`Nodos de ${zone.title}`}>{[...zone.items].sort(bySeverity).map((item: InvItem) => <li key={item.key}><Row onClick={() => onSelect(item.key)} lead={<InvDot status={item.status} />} title={item.name} sub={item.note ? `${item.label} · ${item.note}` : item.label} age={age(item.observedAt, app.now)} /></li>)}</Rows>
  </section>;
}
