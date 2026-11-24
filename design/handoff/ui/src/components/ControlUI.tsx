import type { ReactNode } from "react";
import type { CatalogServiceRecord, DetailedResource, Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { Link } from "../lib/router.tsx";
import { age, dateTime, operationView, serviceObservation } from "../lib/controlModel.ts";
import { describeResourceState, displayName, operationTitle } from "../lib/status.ts";
import { Pill } from "./Pill.tsx";
import { Chevron, StatusDot, dotTone } from "./ui.tsx";

export function KV({ label, children, at }: { label: string; children: ReactNode; at?: string | null }) {
  const app = useAppState();
  return <div className="kv"><dt className="kv__k">{label}</dt><dd className="kv__v">{children}</dd>{at !== undefined && <dd className="t-age">{age(at, app.now)}</dd>}</div>;
}
export function ReadNotice({ read, label }: { read: { data: unknown; error: unknown; loading: boolean; retryAt: number; refresh: () => void }; label: string }) {
  const app = useAppState();
  if (!app.online) return <p className="note" role="status">Sin conexión. {read.data ? "Ves la última lectura de esta sesión, con su edad." : `No hay una lectura de ${label} en esta sesión.`}</p>;
  if (read.error) return <div className="banner banner--warn" role="status"><span aria-hidden="true">!</span><div className="stack gap-8"><p>No se pudo actualizar {label}. {read.data ? "Se conserva la lectura anterior." : "No se interpreta como una lista vacía."}</p><button type="button" className="btn btn--sm" disabled={read.loading || app.now < read.retryAt} onClick={read.refresh}>Volver a consultar</button>{app.now < read.retryAt && <p className="t-small">El servidor pidió esperar hasta {dateTime(new Date(read.retryAt).toISOString())}.</p>}</div></div>;
  if (!read.data) return <p className="empty" role="status">Leyendo {label}…</p>;
  return null;
}
export function ResourceLine({ resource }: { resource: DetailedResource }) {
  const app = useAppState();
  const view = describeResourceState(resource, app.now);
  return <Link className="row" to={{ name: "resource", id: resource.id }}><StatusDot tone={dotTone(view.tone, view.glyph)} /><span><span className="row__title">{displayName(resource)}</span><span className="row__sub">{view.label}{view.hint ? ` · ${view.hint}` : ""}{resource.health?.service ? ` · salud: ${resource.health.service.state === "healthy" ? "saludable" : resource.health.service.state === "unknown" ? "sin comprobar" : "con problemas"}` : ""}</span></span><span className="t-age">{age(resource.observedAt, app.now)}</span><Chevron /></Link>;
}
export function ServiceLine({ service, resources }: { service: CatalogServiceRecord; resources: readonly DetailedResource[] }) {
  const app = useAppState();
  const view = serviceObservation(service, resources, app.now);
  return <Link className="row" to={{ name: "resource", id: service.id }}><StatusDot tone={dotTone(view.tone, view.glyph)} /><span><span className="row__title">{service.name}</span><span className="row__sub">{view.label} · prioridad {service.criticality === "critical" ? "crítica" : service.criticality === "high" ? "alta" : service.criticality === "low" ? "baja" : "normal"}</span></span><span className="t-age">{age(view.observedAt, app.now)}</span><Chevron /></Link>;
}
export function OperationLine({ operation }: { operation: Operation }) {
  const app = useAppState();
  const view = operationView(operation.state);
  const resource = app.inventory.data?.resources.find(r => r.id === operation.resourceId);
  return <Link to={{ name: "operation", id: operation.id }} className="row sc-operation-row"><StatusDot tone={dotTone(view.tone, view.glyph)} /><span><span className="row__title">{operationTitle(operation, resource?.kind ?? null)}</span><span className="row__sub">{operation.actor} · {dateTime(operation.createdAt)}</span><span className="row__sub">{operation.message}</span></span><span className="stack gap-8 sc-result"><Pill tone={view.tone} glyph={view.glyph}>{view.label}</Pill><span className="t-age">{age(operation.updatedAt, app.now)}</span></span><Chevron /></Link>;
}
