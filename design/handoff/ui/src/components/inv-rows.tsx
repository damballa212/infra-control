import type { Operation, ResourceKind } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { Link, type Route } from "../lib/router.tsx";
import { age, operationView } from "../lib/controlModel.ts";
import { operationTitle, type Tone } from "../lib/status.ts";
import { STATUS_TONE, type InvItem, type InvStatus } from "../lib/invModel.ts";
import { Pill, Row, type V2Tone } from "./v2.tsx";

/** Tono v2 de una orden: «sin confirmar» es violeta, nunca verde ni rojo. */
export function opTone(tone: Tone): V2Tone {
  return tone === "on" ? "ok" : tone === "bad" ? "bad" : tone === "busy" ? "busy" : tone === "warn" ? "unc" : "neutral";
}

export function InvDot({ status }: { status: InvStatus }) {
  return <span className={`v2-dot v2-dot--${STATUS_TONE[status]} inv-dot`} aria-hidden="true" />;
}

export function itemRoute(item: Pick<InvItem, "id">): Route { return { name: "resource", id: item.id }; }

interface InvRowProps {
  item: InvItem;
  /** En escritorio la fila selecciona (inspector); en móvil abre el detalle. */
  onSelect?: () => void;
}

/** Fila del inventario: estado, edad y una sola cosa útil. */
export function InvRow({ item, onSelect }: InvRowProps) {
  const app = useAppState();
  const title = <>{item.name}{item.critical && <span className="inv-tag">crítico</span>}</>;
  const sub = item.note ? `${item.label} · ${item.note}` : item.label;
  const common = { lead: <InvDot status={item.status} />, title, sub, age: age(item.observedAt, app.now), dataId: item.key };
  return onSelect ? <Row {...common} onClick={onSelect} /> : <Row {...common} to={itemRoute(item)} />;
}

/** Orden en una línea: qué, cómo terminó y cuándo. El mensaje va en la línea de abajo. */
export function InvOpRow({ operation, kind }: { operation: Operation; kind: ResourceKind | null }) {
  const app = useAppState();
  const view = operationView(operation.state);
  return <Row to={{ name: "operation", id: operation.id }} lead={<span className={`v2-dot v2-dot--${opTone(view.tone)} inv-dot`} aria-hidden="true" />} title={operationTitle(operation, kind)} sub={operation.message} age={age(operation.updatedAt, app.now)} trailing={<Pill tone={opTone(view.tone)}>{view.label}</Pill>} />;
}

/** Progreso de una orden en el sitio: Registrada → En curso → Resultado, con su mensaje y detalle. */
export function InvProgress({ operation }: { operation: Operation }) {
  const view = operationView(operation.state);
  return <div className="inv-steps" role="status" aria-label={`Orden ${view.label}`}>
    <div className="inv-steps__bars" aria-hidden="true">{[1, 2, 3].map(n => <span key={n} className={n < view.stage ? "is-done" : n === view.stage ? "is-now" : ""} />)}</div>
    <div className="inv-steps__labels" aria-hidden="true"><span>Registrada</span><span>En curso</span><span>Resultado</span></div>
    <div className="inv-steps__foot"><span>{operation.message}</span><Link to={{ name: "operation", id: operation.id }} className="v2-pill">Detalle</Link></div>
  </div>;
}
