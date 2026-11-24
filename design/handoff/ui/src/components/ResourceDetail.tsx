import type { CatalogServiceRecord, DetailedResource } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { age, dateTime, servicesForResource } from "../lib/controlModel.ts";
import { describeResourceState } from "../lib/status.ts";
import { healthRows, metricRows, formatBytes } from "../lib/insight.ts";
import { activeResourceIds, serviceItem } from "../lib/invModel.ts";
import { Card, Facts, Rows } from "./v2.tsx";
import { DesktopControls } from "./DesktopControls.tsx";
import { ResourceActions } from "./inv-actions.tsx";
import { InvRow } from "./inv-rows.tsx";

/** Acciones del recurso: la PC usa el mismo control que Hoy; el resto, consultar y energía. */
export function ResourceControls({ resource, critical = false }: { resource: DetailedResource; critical?: boolean }) {
  return resource.id === "computer:desktop" ? <DesktopControls resource={resource} /> : <ResourceActions resource={resource} critical={critical} />;
}

/** Señales separadas: disponibilidad, salud de la app, cada señal con su edad. Nunca se infiere salud del encendido. */
export function SignalsCard({ resource }: { resource: DetailedResource }) {
  const app = useAppState();
  const view = describeResourceState(resource, app.now);
  const signals = healthRows(resource.health);
  const items = [
    { label: "Disponibilidad", value: view.label, age: age(resource.observedAt, app.now) },
    ...(signals.some(s => s.key === "service") ? [] : [{ label: "Salud de la app", value: "Sin comprobar", age: "" }]),
    ...signals.map(signal => ({ label: signal.label, value: <><span className={`inv-tone inv-tone--${signal.tone}`}>{signal.state}</span>{signal.reason && <span className="inv-fact-sub">{signal.reason}</span>}</>, age: age(signal.observedAt, app.now) })),
    ...(resource.stateChangedAt ? [{ label: "Último cambio", value: dateTime(resource.stateChangedAt, app.now), age: "" }] : []),
  ];
  return <Card title="Señales" id="inv-signals"><Facts items={items} /></Card>;
}

export function MetricsCard({ resource }: { resource: DetailedResource }) {
  const app = useAppState();
  const metrics = metricRows(resource.hostMetrics);
  const network = resource.hostMetrics?.network ?? [];
  if (!metrics.length && !network.length) return null;
  const percent = (value: string) => { const n = Number.parseFloat(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; };
  return <Card title="Métricas" meta="última muestra" id="inv-metrics">
    <ul className="inv-meters">{metrics.map(metric => { const p = percent(metric.value); return <li key={metric.label}>
      <span className="inv-meters__label">{metric.label}</span><span className="inv-meters__value">{metric.value}</span><span className="t-age">{age(metric.observedAt, app.now)}</span>
      {p !== null && <span className={`inv-meters__bar${p >= 90 ? " is-high" : p >= 75 ? " is-mid" : ""}`} aria-hidden="true"><span style={{ width: `${p}%` }} /></span>}
    </li>; })}
    {network.map(net => <li key={net.device}><span className="inv-meters__label">Red {net.device}</span><span className="inv-meters__value">↓ {formatBytes(net.receivedBytes)} · ↑ {formatBytes(net.sentBytes)}</span><span className="t-age">{age(net.observedAt, app.now)}</span></li>)}</ul>
  </Card>;
}

export function RelatedServicesCard({ resource, services, resources }: { resource: DetailedResource; services: readonly CatalogServiceRecord[]; resources: readonly DetailedResource[] }) {
  const app = useAppState();
  const linked = servicesForResource(resource, services, resources);
  if (!linked.length) return null;
  const activeIds = activeResourceIds(app.operations.data?.operations ?? []);
  return <Card flush title="Lo usan" meta={String(linked.length)} id="inv-related"><Rows label="Servicios relacionados">{linked.map(service => { const item = serviceItem(service, resources, app.now, activeIds); return <li key={item.key}><InvRow item={item} /></li>; })}</Rows></Card>;
}

export function TechnicalCard({ resource }: { resource: DetailedResource }) {
  const facts = [
    { label: "ID", value: resource.id }, { label: "Cuenta", value: resource.account }, { label: "Ubicación", value: resource.location }, { label: "Tipo", value: resource.detail }, { label: "Estado recibido", value: resource.state },
    ...(resource.catalog ? [{ label: "Catálogo", value: resource.catalog.catalogId }, { label: "Proveedor", value: resource.catalog.provider.toUpperCase() }, { label: "Ciclo de vida", value: resource.catalog.lifecycle === "active" ? "Activo" : resource.catalog.lifecycle === "retired" ? "Retirado" : "Posible baja" }] : []),
    ...(resource.note ? [{ label: "Nota", value: resource.note }] : []),
  ];
  return <details className="v2-card inv-disclosure"><summary>Datos técnicos</summary><Facts items={facts} /></details>;
}
