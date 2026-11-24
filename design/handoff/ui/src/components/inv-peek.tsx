import type { ReactNode } from "react";
import type { CatalogServiceRecord, DetailedResource } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { Link } from "../lib/router.tsx";
import { age, operationView, relatedResource, servicesForResource } from "../lib/controlModel.ts";
import { CRITICALITY_LABELS, RELATION_LABELS, healthRows, metricRows } from "../lib/insight.ts";
import { describeResourceState } from "../lib/status.ts";
import { STATUS_TONE, headline, type InvItem } from "../lib/invModel.ts";
import { Facts, Pill } from "./v2.tsx";
import { Icon } from "./ui.tsx";
import { useResourceActions } from "./inv-actions.tsx";
import { itemRoute } from "./inv-rows.tsx";

interface Fact { label: ReactNode; value: ReactNode; age?: ReactNode }

/** Lo esencial de un recurso en 4 datos como mucho; el resto vive en el detalle. */
export function resourceFacts(resource: DetailedResource, services: readonly CatalogServiceRecord[], resources: readonly DetailedResource[], now: number): Fact[] {
  const signals = healthRows(resource.health);
  const app = signals.find(signal => signal.key === "service");
  const facts: Fact[] = [{ label: "Salud de la app", value: app ? <span className={`inv-tone inv-tone--${app.tone}`}>{app.state}</span> : "Sin comprobar", age: app ? age(app.observedAt, now) : undefined }];
  for (const signal of signals.filter(s => s.key !== "service").slice(0, 2)) facts.push({ label: signal.label, value: <span className={`inv-tone inv-tone--${signal.tone}`}>{signal.state}</span>, age: age(signal.observedAt, now) });
  const hosted = servicesForResource(resource, services, resources);
  if (hosted.length) facts.push({ label: "Lo usa", value: hosted.map(s => s.name).join(", ") });
  const metrics = metricRows(resource.hostMetrics).slice(0, 2);
  if (metrics.length) facts.push({ label: "Métricas", value: metrics.map(m => `${m.label} ${m.value.split(" · ")[0]}`).join(" · "), age: age(metrics[0]!.observedAt, now) });
  return facts.slice(0, 4);
}

export function serviceFacts(service: CatalogServiceRecord, resources: readonly DetailedResource[], now: number): Fact[] {
  const facts: Fact[] = service.relations.filter(r => r.active).slice(0, 3).map(relation => {
    const target = relatedResource(relation, resources);
    return { label: RELATION_LABELS[relation.relationType], value: target ? `${target.name} · ${describeResourceState(target, now).label.toLocaleLowerCase("es")}` : `${relation.resource?.name ?? relation.resourceAlias} · sin descubrir`, age: target ? age(target.observedAt, now) : undefined };
  });
  facts.push({ label: "Prioridad", value: CRITICALITY_LABELS[service.criticality] });
  return facts;
}

interface InvPeekProps {
  item: InvItem;
  resources: readonly DetailedResource[];
  services: readonly CatalogServiceRecord[];
  onClose?: () => void;
}

/** Inspector (escritorio) y hoja inferior (móvil): resumen, estado, edad y «Ver detalle». */
export function InvPeek({ item, resources, services, onClose }: InvPeekProps) {
  const app = useAppState();
  const resource = item.kind === "resource" ? resources.find(r => r.id === item.id) : undefined;
  const service = item.kind === "service" ? services.find(s => s.id === item.id) : undefined;
  const facts = resource ? resourceFacts(resource, services, resources, app.now) : service ? serviceFacts(service, resources, app.now) : [];
  const eyebrow = [item.zone.title, item.zone.sub].filter(Boolean).join(" · ");
  const head = headline(item);
  return <div className="inv-peek">
    <div className="inv-peek__head">
      <div className="inv-peek__text"><p className="v2-eyebrow">{eyebrow}</p><h2 className="inv-peek__title">{item.name}</h2></div>
      {onClose && <button type="button" className="inv-icon-btn" aria-label="Cerrar resumen" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>}
    </div>
    <div className="inv-peek__state"><Pill tone={STATUS_TONE[item.status]}>{head.pill}</Pill>{head.rest && <span className="inv-peek__note">{head.rest}</span>}<span className="t-age">{age(item.observedAt, app.now)}</span></div>
    <div className="inv-peek__actions">
      {resource && resource.id !== "computer:desktop" && resource.actions.includes("refresh") && <PeekRefresh resource={resource} />}
      <Link className="btn btn--primary inv-btn" to={itemRoute(item)}>Ver detalle</Link>
    </div>
    {facts.length > 0 && <Facts items={facts} />}
  </div>;
}

function PeekRefresh({ resource }: { resource: DetailedResource }) {
  const actions = useResourceActions(resource);
  if (actions.active) return <Link className="btn inv-btn" to={{ name: "operation", id: actions.active.id }}><span className="inv-spin" aria-hidden="true" />{operationView(actions.active.state).label}</Link>;
  return <><button type="button" className="btn inv-btn" disabled={actions.refreshReason !== null} onClick={actions.refresh}><Icon name="refresh" />{resource.kind === "router" ? "Leer ahora" : "Consultar ahora"}</button>{actions.refreshReason && <p className="inv-reason inv-reason--full">{actions.refreshReason}</p>}</>;
}
