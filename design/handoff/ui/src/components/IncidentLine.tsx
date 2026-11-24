import { useState } from "react";
import type { OperationalIncident } from "../contract.ts";
import { provider } from "../app/providers.ts";
import { useSession } from "../app/Session.tsx";
import { useAppState } from "../app/AppState.tsx";
import { Link } from "../lib/router.tsx";
import { age, dateTime } from "../lib/controlModel.ts";
import { reasonLabel } from "../lib/insight.ts";
import { displayName } from "../lib/status.ts";
import { INCIDENT_KINDS, incidentView } from "../lib/activityModel.ts";
import { useFeed } from "../lib/activityFeed.ts";
import { Facts, Row, Rows } from "./v2.tsx";
import { LoadMore, ReadState, ResultTag, StateTile } from "./act-ui.tsx";

/**
 * Un episodio de incidente como fila. Tocarla despliega su evidencia y sus versiones (con «Cargar más»).
 * Un reconocimiento se muestra como tal y nunca cambia el estado: un episodio abierto sigue abierto.
 */
export function IncidentLine({ incident }: { incident: OperationalIncident }) {
  const app = useAppState();
  const [open, setOpen] = useState(false);
  const resource = app.inventory.data?.resources.find(row => row.id === incident.resourceId || row.id === incident.canonicalResourceId || !!row.catalog && `catalog:${row.catalog.catalogId}` === incident.canonicalResourceId);
  const view = incidentView(incident);
  const name = resource ? displayName(resource) : incident.resourceId ?? incident.scopeKey ?? incident.source;
  const ack = incident.acknowledgement;
  const stillOpen = incident.status === "open" || incident.status === "unknown";
  const sub = [INCIDENT_KINDS[incident.kind], ack ? `Reconocido por ${ack.by}${stillOpen ? " · sigue abierto" : ""}` : dateTime(incident.openedAt, app.now)].join(" · ");
  const panel = `incident-panel-${incident.id}`;
  return <div className={`act-incident${open ? " is-open" : ""}`} data-incident-id={incident.id}>
    <button type="button" className="v2-row act-incident__row" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <StateTile tone={view.tone} />
      <span className="v2-row__text"><span className="v2-row__title">{name}</span><span className="v2-row__sub">{sub}</span></span>
      <ResultTag tone={view.tone} label={view.label} age={age(incident.evidence.observedAt, app.now)} />
      <span className="act-incident__chev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></span>
    </button>
    {open && <div className="act-incident__panel" id={panel}>
      <Facts items={[
        { label: "Motivo", value: reasonLabel(incident.evidence.reasonCode) ?? incident.evidence.reasonCode },
        { label: "Evidencia", value: dateTime(incident.evidence.observedAt, app.now), age: age(incident.evidence.observedAt, app.now) },
        ...(incident.evidence.from !== undefined ? [{ label: "Transición", value: `${incident.evidence.from} → ${incident.evidence.to ?? "sin estado confirmado"}` }] : []),
        { label: "Abierto", value: dateTime(incident.openedAt, app.now) },
        ...(incident.resolvedAt ? [{ label: "Recuperado", value: dateTime(incident.resolvedAt, app.now) }] : []),
        ...(ack ? [{ label: "Reconocido", value: `${ack.by} · ${dateTime(ack.at, app.now)}` }] : []),
        { label: "Fuente", value: incident.source },
      ]} />
      {resource && <Link className="btn btn--block act-incident__go" to={{ name: "resource", id: resource.id }}>Ver {displayName(resource)}</Link>}
      <IncidentVersions incident={incident} />
    </div>}
  </div>;
}

function IncidentVersions({ incident }: { incident: OperationalIncident }) {
  const app = useAppState(); const { user, expire } = useSession();
  const feed = useFeed(query => provider.getIncidentVersions(incident.id, query), {}, page => page.events, row => String(row.version), { identity: JSON.stringify(["incident-versions", user?.name, user?.agent, incident.id, incident.version]), onUnauthorized: expire });
  return <div className="act-incident__versions">
    <h3 className="act-subhead">Versiones</h3>
    <ReadState read={feed} what="las versiones" rows={2} />
    {feed.rows.length > 0 && <div className="act-inset"><Rows label={`Versiones del incidente ${incident.id}`}>{feed.rows.map(version => {
      const view = incidentView(version);
      return <li key={version.version}><Row lead={<StateTile tone={view.tone} />} title={view.label} sub={`${dateTime(version.updatedAt, app.now)}${version.acknowledgement ? " · reconocido, el estado no cambia" : ""}`} age={`v${version.version}`} /></li>;
    })}</Rows></div>}
    {feed.data !== null && !feed.error && !feed.rows.length && <p className="act-reason">Sin versiones retenidas.</p>}
    <LoadMore more={feed.more} what="versiones" />
  </div>;
}
