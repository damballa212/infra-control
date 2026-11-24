import { useEffect, useState } from "react";
import type { CatalogServiceRecord, DetailedResource, Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { useRead } from "../hooks/useRead.ts";
import { usePagedRead } from "../hooks/usePagedRead.ts";
import { useOperationalRefresh } from "./Activity.tsx";
import { isActiveOperation, describeResourceState } from "../lib/status.ts";
import { operationCanAdvance } from "../lib/liveState.ts";
import { age, dateTime, relatedResource, servicesForResource } from "../lib/controlModel.ts";
import { CRITICALITY_LABELS, RELATION_LABELS } from "../lib/insight.ts";
import { activeResourceIds, headline, locationZone, resourceItem, serviceView, STATUS_TONE } from "../lib/invModel.ts";
import { Link } from "../lib/router.tsx";
import { Card, Facts, Hint, Pill, Row, Rows, ScreenHead, Skeleton } from "../components/v2.tsx";
import { ReadNotice } from "../components/ControlUI.tsx";
import { ResourcePolicy } from "../components/ResourcePolicy.tsx";
import { MetricsCard, RelatedServicesCard, ResourceControls, SignalsCard, TechnicalCard } from "../components/ResourceDetail.tsx";
import { InvDot, InvOpRow, InvRow } from "../components/inv-rows.tsx";

const ACTIVITY_SIZE = 5;
const KIND_LABEL = { ec2: "instancia EC2", service: "app de Coolify", router: "router", computer: "equipo" } as const;

export function ResourceScreen({ id }: { id: string }) {
  const app = useAppState();
  const { expire } = useSession();
  const catalog = useRead(provider.getCatalogServices, true, 60000, expire);
  const resources = app.inventory.data?.resources ?? [];
  const services = catalog.data?.services ?? [];
  const resource = resources.find(r => r.id === id);
  const service = resource ? undefined : services.find(s => s.id === id);
  if (resource) return <ResourceView resource={resource} resources={resources} services={services} catalogRead={catalog} />;
  if (service) return <ServiceView service={service} resources={resources} />;
  return <div className="page inv-detail">
    <ScreenHead back={{ to: { name: "inventory", view: "devices" }, label: "Inventario" }} title="Detalle" />
    <ReadNotice read={app.inventory} label="el inventario" /><ReadNotice read={catalog} label="el catálogo de servicios" />
    {app.inventory.data && catalog.data ? <div className="v2-card inv-empty" role="status"><h2 className="inv-empty__title">No está en el inventario que puedes ver.</h2></div> : <Skeleton rows={3} />}
  </div>;
}

interface ResourceViewProps { resource: DetailedResource; resources: readonly DetailedResource[]; services: readonly CatalogServiceRecord[]; catalogRead: { data: unknown; error: unknown; loading: boolean; retryAt: number; refresh: () => void } }

function ResourceView({ resource, resources, services, catalogRead }: ResourceViewProps) {
  const app = useAppState();
  const activeIds = activeResourceIds(app.operations.data?.operations ?? []);
  const item = resourceItem(resource, app.now, activeIds, services, resources);
  const zone = locationZone(resource);
  const linked = servicesForResource(resource, services, resources);
  const critical = linked.some(s => s.criticality === "critical" || s.criticality === "high");
  const since = resource.stateChangedAt ? `desde ${dateTime(resource.stateChangedAt, app.now)}` : null;
  return <div className="page inv-detail">
    <ScreenHead back={{ to: { name: "inventory", view: "devices" }, label: "Equipos" }} eyebrow={[zone.title, zone.sub, KIND_LABEL[resource.kind]].filter(Boolean).join(" · ")} title={resource.name} />
    <div className="inv-detail__state"><Pill tone={STATUS_TONE[item.status]}><InvDot status={item.status} />{headline(item).pill}</Pill>{headline(item).rest && <span>{headline(item).rest}</span>}<span className="t-age">{since ?? age(resource.observedAt, app.now)}</span></div>
    <ReadNotice read={app.inventory} label="el inventario" /><ReadNotice read={catalogRead} label="las relaciones de servicios" />
    <div className="v2-grid v2-grid--2">
      <div className="v2-stack">
        <ResourceControls resource={resource} critical={critical} />
        <SignalsCard resource={resource} />
        <MetricsCard resource={resource} />
      </div>
      <div className="v2-stack">
        <RelatedServicesCard resource={resource} services={services} resources={resources} />
        <ResourcePolicy key={resource.id} resourceId={resource.id} />
        <ResourceActivity resource={resource} />
        <TechnicalCard resource={resource} />
      </div>
    </div>
  </div>;
}

/** Últimas órdenes del recurso; la historia completa vive en Actividad. Sin paginador. */
function ResourceActivity({ resource }: { resource: DetailedResource }) {
  const app = useAppState(); const { expire } = useSession();
  const activity = usePagedRead(provider.getOperations, { resourceId: resource.id }, { identity: `resource-operations:${resource.id}`, onUnauthorized: expire, pageSize: ACTIVITY_SIZE });
  const shared = app.operations.data?.operations ?? [];
  const page: Operation[] = (activity.data?.operations ?? []).map(operation => { const live = shared.find(row => row.id === operation.id); return live && operationCanAdvance(operation, live) ? live : operation; });
  // Una orden recién aceptada aparece ya, sin esperar a la siguiente lectura de la página.
  const newest = page.reduce((max, op) => Math.max(max, Date.parse(op.createdAt) || 0), 0);
  const fresh = activity.data ? shared.filter(op => op.resourceId === resource.id && !page.some(row => row.id === op.id) && Date.parse(op.createdAt) > newest) : [];
  const operations = [...fresh, ...page].slice(0, ACTIVITY_SIZE);
  const [executing, setExecuting] = useState(false);
  useEffect(() => { setExecuting(operations.some(isActiveOperation)); }, [activity.data, app.operations.data]);
  useOperationalRefresh(activity, executing ? 5000 : 60000);
  return <Card flush title="Actividad" id="inv-activity" action={<Link to={{ name: "activity" }}>Ver todas en Actividad ›</Link>}>
    <ReadNotice read={activity} label="la actividad del recurso" />
    {operations.length ? <Rows label="Últimas órdenes">{operations.map(op => <li key={op.id}><InvOpRow operation={op} kind={resource.kind} /></li>)}</Rows> : activity.data && <p className="inv-card-empty">Sin órdenes todavía.</p>}
  </Card>;
}

function ServiceView({ service, resources }: { service: CatalogServiceRecord; resources: readonly DetailedResource[] }) {
  const app = useAppState();
  const activeIds = activeResourceIds(app.operations.data?.operations ?? []);
  const view = serviceView(service, resources, app.now, activeIds);
  const relations = service.relations.filter(r => r.active);
  return <div className="page inv-detail">
    <ScreenHead back={{ to: { name: "inventory", view: "services" }, label: "Servicios" }} eyebrow={[service.project ?? "Sin proyecto", service.environment, `prioridad ${CRITICALITY_LABELS[service.criticality]}`].filter(Boolean).join(" · ")} title={service.name} />
    <div className="inv-detail__state"><Pill tone={STATUS_TONE[view.status]}><InvDot status={view.status} />{view.label}</Pill>{view.note && <span>{view.note}</span>}{view.observedAt && <span className="t-age">{age(view.observedAt, app.now)}</span>}</div>
    <div className="v2-grid v2-grid--2">
      <div className="v2-stack">
        <Card flush title="Relaciones" meta={String(relations.length)} id="inv-relations">
          {relations.length ? <Rows label="Relaciones del servicio">{relations.map((relation, index) => {
            const target = relatedResource(relation, resources);
            const verb = RELATION_LABELS[relation.relationType];
            return <li key={`${relation.resourceAlias}:${index}`}>{target
              ? <InvRow item={{ ...resourceItem(target, app.now, activeIds), label: verb, note: describeResourceState(target, app.now).label.toLocaleLowerCase("es") }} />
              : <Row lead={<InvDot status="unknown" />} title={relation.resource?.name ?? relation.resourceAlias} sub={`${verb} · ${relation.resolved ? "fuera del inventario visible" : "sin descubrir"}`} />}</li>;
          })}</Rows> : <p className="inv-card-empty">Sin relaciones declaradas.</p>}
        </Card>
        <Hint>Para consultar o encender, abre el equipo relacionado.</Hint>
      </div>
      <div className="v2-stack">
        <Card title="Catálogo" id="inv-catalog"><Facts items={[
          { label: "Prioridad", value: CRITICALITY_LABELS[service.criticality] },
          { label: "Evidencia", value: relations.some(r => r.evidence === "operator_confirmed") ? "Confirmada por ti" : "Metadatos del proveedor" },
          { label: "Relación vista", value: relations.length ? dateTime(relations.map(r => r.lastSeen).sort().at(-1), app.now) : "—" },
          { label: "Clave", value: service.key }, { label: "Fuente", value: service.source },
        ]} /></Card>
      </div>
    </div>
  </div>;
}
