import { useEffect, useState, type FormEvent } from "react";
import type { Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { age, operationView } from "../lib/controlModel.ts";
import { isActiveOperation, operationTitle } from "../lib/status.ts";
import { eventLabel } from "../lib/secrets.ts";
import { displayedOperation, useOperationalRefresh } from "../lib/activityRefresh.ts";
import { useFeed } from "../lib/activityFeed.ts";
import { activeMoreCount, activityQuery, auditTone, dayGroups, INCIDENT_KINDS, localTime, moreFields, ORDER_TYPES, orderTone, STATE_CHIPS, type ActivityFilters, type ActivityKind, type MoreFilters } from "../lib/activityModel.ts";
import { Card, Chip, Chips, Empty, Row, Rows, ScreenHead, SearchField, Segmented } from "../components/v2.tsx";
import { DayList, LoadMore, ReadState, ResultTag, StateTile } from "../components/act-ui.tsx";
import { IncidentLine } from "../components/IncidentLine.tsx";
export { OperationScreen } from "../components/act-operation.tsx";
export { operationResource, useOperationalRefresh } from "../lib/activityRefresh.ts";

/** Espera tras teclear antes de pedir al servidor; Intro aplica al instante. */
const TYPE_DELAY_MS = 350;

const REVIEW_SUB: Record<string, string> = { pending: "por revisar", reviewed: "revisada", superseded: "sustituida" };

/** Fila de orden. `sub="message"` muestra el mensaje (detalle de un equipo); por defecto, autor y hora local. */
function OrderRow({ operation, sub = "actor" }: { operation: Operation; sub?: "actor" | "message" }) {
  const app = useAppState();
  const view = operationView(operation.state);
  const kind = app.inventory.data?.resources.find(r => r.id === operation.resourceId)?.kind ?? null;
  const review = operation.review ? REVIEW_SUB[operation.review.disposition] : undefined;
  const line = sub === "message" ? operation.message : [operation.actor, localTime(operation.createdAt), review].filter(Boolean).join(" · ");
  return <Row to={{ name: "operation", id: operation.id }} lead={<StateTile tone={orderTone(operation.state)} />} title={operationTitle(operation, kind)} sub={line} trailing={<ResultTag tone={orderTone(operation.state)} label={view.label} age={age(operation.updatedAt, app.now)} />} dataId={`op-${operation.id}`} />;
}

/** Fila de orden para otras pantallas (p. ej. el detalle de un equipo). Va dentro de un `<li>` de `<Rows>`. */
export function OperationEntry({ operation }: { operation: Operation }) {
  const app = useAppState();
  const value = displayedOperation(operation, app.operations.data?.operations.find(row => row.id === operation.id));
  return <OrderRow operation={value} sub="message" />;
}

const KINDS = [{ key: "orders", label: "Órdenes" }, { key: "keys", label: "Claves" }, { key: "incidents", label: "Incidentes" }] as const;
const PLACEHOLDER: Record<ActivityKind, string> = { orders: "Buscar órdenes o equipos", keys: "Buscar claves o proyectos", incidents: "Buscar incidentes" };
const EMPTY_MORE: MoreFilters = { actor: "", type: "" };

export function Activity() {
  const app = useAppState(); const { user } = useSession();
  const personal = !!user && !user.agent;
  const [kind, setKind] = useState<ActivityKind>("orders");
  const [chip, setChip] = useState("all");
  const [search, setSearch] = useState("");
  const [more, setMore] = useState<MoreFilters>(EMPTY_MORE);
  const [typed, setTyped] = useState({ q: "", actor: "" });
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (typed.q === search && typed.actor === more.actor) return;
    const timer = window.setTimeout(() => setTyped({ q: search, actor: more.actor }), TYPE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search, more.actor, typed]);
  const filters = activityQuery(kind, chip, typed.q, { actor: typed.actor, type: more.type });
  const changeKind = (value: ActivityKind) => { setKind(value); setChip("all"); setSearch(""); setMore(EMPTY_MORE); setTyped({ q: "", actor: "" }); };
  const submit = (event: FormEvent) => { event.preventDefault(); setTyped({ q: search, actor: more.actor }); };
  const extra = activeMoreCount(kind, more);
  const counts = app.attention?.data?.counts;
  const unfiltered = !typed.q.trim() && !typed.actor.trim() && !more.type;
  const chipCount = (key: string): number | undefined => kind !== "orders" || !unfiltered || !counts ? undefined : key === "active" ? counts.active : key === "review" ? counts.pendingReviews : undefined;
  const jump = (nextKind: ActivityKind, nextChip: string) => { if (nextKind !== kind) changeKind(nextKind); setChip(nextChip); };

  return <div className="page act">
    <ScreenHead title="Actividad" avatar />
    <div className="act-kinds"><Segmented label="Tipo de actividad" value={kind} items={KINDS} onChange={changeKind} /></div>
    <div className="act-layout">
      <div className="act-top">
        <form role="search" onSubmit={submit}><SearchField label="Buscar en la actividad" placeholder={PLACEHOLDER[kind]} value={search} onChange={setSearch} /></form>
        <div className="act-filterbar">
          <Chips label="Estado">{STATE_CHIPS[kind].map(item => { const count = chipCount(item.key); return <Chip key={item.key} pressed={chip === item.key} count={count} onClick={() => setChip(item.key)}>{count !== undefined ? ` ${item.label}` : item.label}</Chip>; })}</Chips>
          <button type="button" className="v2-chip act-more-toggle" aria-expanded={moreOpen} aria-controls="act-more" onClick={() => setMoreOpen(value => !value)}>Más filtros{extra > 0 && <b className="act-more-toggle__n">{extra}</b>}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></button>
        </div>
      </div>
      <aside className="act-side" aria-label="Filtros y resumen">
        <MoreFiltersPanel kind={kind} open={moreOpen} value={more} onChange={setMore} />
        {counts && <Card title="Ahora" flush className="act-now">
          <Rows label="Resumen del servidor">
            <li><Row onClick={() => jump("orders", "active")} lead={<StateTile tone="busy" glyph="refresh" />} title="En curso" trailing={<b className="act-count">{counts.active}</b>} /></li>
            <li><Row onClick={() => jump("orders", "review")} lead={<StateTile tone="unc" />} title="Por revisar" trailing={<b className="act-count">{counts.pendingReviews}</b>} /></li>
            <li><Row onClick={() => jump("incidents", "open")} lead={<StateTile tone="stale" />} title="Incidentes abiertos" sub={counts.unknownIncidents ? `${counts.unknownIncidents} con estado desconocido` : undefined} trailing={<b className="act-count">{counts.openIncidents}</b>} /></li>
          </Rows>
        </Card>}
      </aside>
      <div className="act-list">
        {kind === "orders" ? <OrderCollection filters={filters} /> : kind === "keys" ? personal ? <AuditCollection filters={filters} /> : <div className="v2-card"><Empty title="La auditoría de claves requiere sesión personal." /></div> : <IncidentCollection filters={filters} />}
      </div>
    </div>
  </div>;
}

function MoreFiltersPanel({ kind, open, value, onChange }: { kind: ActivityKind; open: boolean; value: MoreFilters; onChange: (value: MoreFilters) => void }) {
  const fields = moreFields(kind);
  const used = activeMoreCount(kind, value) > 0;
  return <section id="act-more" className={`v2-card act-more${open ? " is-open" : ""}`} aria-labelledby="act-more-title">
    <h2 className="v2-card__title" id="act-more-title"><span>Más filtros</span>{used && <button type="button" className="v2-link" onClick={() => onChange(EMPTY_MORE)}>Quitar</button>}</h2>
    <div className="act-fields">
      {fields.actor && <label className="act-field"><span>Autor</span><input value={value.actor} onChange={event => onChange({ ...value, actor: event.target.value })} placeholder="Todos" autoCapitalize="none" spellCheck={false} /></label>}
      {fields.type && <label className="act-field"><span>Tipo</span><select value={value.type} onChange={event => onChange({ ...value, type: event.target.value })}><option value="">Todos</option>{kind === "orders" ? ORDER_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>) : Object.entries(INCIDENT_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
    </div>
  </section>;
}

function EmptyList({ what }: { what: string }) { return <div className="v2-card"><Empty title={`Sin ${what} con este filtro.`} /></div>; }

function OrderCollection({ filters }: { filters: ActivityFilters }) {
  const app = useAppState(); const { user, expire } = useSession();
  const { view, ...query } = filters;
  const feed = useFeed(args => view === "review" ? provider.getReviewOperations(args) : view === "active" ? provider.getActiveOperations(args) : provider.getOperations(args), query, page => page.operations, row => row.id, { identity: JSON.stringify(["activity:orders", user?.name, user?.agent, view ?? "history"]), onUnauthorized: expire });
  useOperationalRefresh(feed, feed.rows.some(isActiveOperation) ? 5000 : 60000);
  const shared = app.operations.data?.operations ?? [];
  const rows = feed.rows.map(row => displayedOperation(row, shared.find(item => item.id === row.id)));
  return <>
    <ReadState read={feed} what="las órdenes" />
    {rows.length > 0 && <DayList groups={dayGroups(rows, row => row.createdAt, app.now)} label="Órdenes" rowKey={row => row.id} render={row => <OrderRow operation={row} />} />}
    {feed.data !== null && !feed.error && !rows.length && <EmptyList what="órdenes" />}
    <LoadMore more={feed.more} what="órdenes" />
  </>;
}

function AuditCollection({ filters }: { filters: ActivityFilters }) {
  const app = useAppState(); const { user, expire } = useSession();
  const feed = useFeed(provider.getSecretAudit, filters, page => page.events, row => String(row.id), { identity: `activity:audit:${user?.name}`, onUnauthorized: expire });
  useOperationalRefresh(feed, 60000);
  return <>
    <ReadState read={feed} what="la auditoría de claves" />
    {feed.rows.length > 0 && <DayList groups={dayGroups(feed.rows, row => row.at, app.now)} label="Auditoría de claves" rowKey={row => String(row.id)} render={row => <Row to={row.requestId ? { name: "secretRequest", id: row.requestId } : undefined} lead={<StateTile tone={auditTone(row.event)} glyph={row.event === "created" ? "key" : undefined} />} title={eventLabel(row.event)} sub={`${row.actor} · ${localTime(row.at)}`} age={age(row.at, app.now)} dataId={`audit-${row.id}`} />} />}
    {feed.data !== null && !feed.error && !feed.rows.length && <EmptyList what="eventos" />}
    <LoadMore more={feed.more} what="eventos" />
  </>;
}

function IncidentCollection({ filters }: { filters: ActivityFilters }) {
  const app = useAppState(); const { user, expire } = useSession();
  const feed = useFeed(provider.getIncidentHistory, filters, page => page.incidents, row => row.id, { identity: JSON.stringify(["activity:incidents", user?.name, user?.agent]), onUnauthorized: expire });
  useOperationalRefresh(feed, 60000);
  return <>
    <ReadState read={feed} what="los incidentes" />
    {feed.rows.length > 0 && <DayList groups={dayGroups(feed.rows, row => row.openedAt, app.now)} label="Incidentes" rowKey={row => row.id} render={row => <IncidentLine incident={row} />} />}
    {feed.data !== null && !feed.error && !feed.rows.length && <EmptyList what="incidentes" />}
    <LoadMore more={feed.more} what="incidentes" />
  </>;
}
