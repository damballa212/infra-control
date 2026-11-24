import { useEffect, type ReactNode } from "react";
import type { CostReport, DetailedResource, Operation, OperationalIncident, SecretRequest } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { useRead } from "../hooks/useRead.ts";
import { usePagedRead } from "../hooks/usePagedRead.ts";
import { useOperationalRefresh } from "./Activity.tsx";
import { Link, type Route } from "../lib/router.tsx";
import { age, dailyCosts, money, operationView } from "../lib/controlModel.ts";
import { summarizeCosts } from "../lib/costs.ts";
import { projectLabel } from "../lib/secrets.ts";
import { buildFleet, verdict, verdictDetail, type FleetCounts, type Verdict } from "../lib/hoyModel.ts";
import { describeResourceState, displayName, isActiveOperation, operationTitle } from "../lib/status.ts";
import { AvatarLink, Icon, Chevron, StatusDot, dotTone } from "../components/ui.tsx";
import { FleetScene } from "../components/FleetScene.tsx";
import { usePcControl } from "../components/DesktopControls.tsx";

/** Cuántas tareas caben en Hoy; el resto se abre en su lista completa, nunca con paginadores aquí. */
const MAX_TASKS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEVICES = 4;

type Tone = "key" | "bad" | "unc" | "stale";
interface Task { id: string; tone: Tone; title: string; sub: ReactNode; to: Route; age?: string; action?: string; ring?: number }

export function Hoy() {
  const app = useAppState();
  const { expire, user } = useSession();
  const scope = JSON.stringify([user?.name, user?.agent ?? false]);
  const personal = !!user && !user.agent;
  const fallbackSummary = useRead(provider.getAttentionSummary, !app.attention, null, expire, true, { identity: `hoy:summary:${scope}` });
  const summary = app.attention ?? fallbackSummary;
  const pending = usePagedRead(provider.getPendingSecretRequests, {}, { identity: `hoy:pending:${scope}`, onUnauthorized: expire, enabled: personal });
  const review = usePagedRead(provider.getReviewOperations, {}, { identity: `hoy:review:${scope}`, onUnauthorized: expire });
  const active = usePagedRead(provider.getActiveOperations, {}, { identity: `hoy:active:${scope}`, onUnauthorized: expire });
  const incidents = usePagedRead(provider.getCurrentIncidents, {}, { identity: `hoy:incidents:${scope}`, onUnauthorized: expire });
  useOperationalRefresh(summary, 60000, !app.attention);
  useOperationalRefresh(pending, 60000, personal);
  useOperationalRefresh(review, 60000);
  const executing = (summary.data?.counts.active ?? 0) > 0 || !!active.data?.operations.some(isActiveOperation);
  useOperationalRefresh(active, executing ? 5000 : 60000);
  useOperationalRefresh(incidents, 60000);
  useEffect(() => { app.enableCosts(true); }, [app.enableCosts]);

  const resources = app.inventory.data?.resources ?? [];
  const operations = app.operations.data?.operations ?? [];
  const fleet = buildFleet(resources, operations, app.now);
  const pendingCount = personal && pending.data && !pending.error ? pending.data.pendingCount : null;
  const activeOps = (active.data?.operations ?? []).filter(isActiveOperation);
  const input = { summary: summary.data, summaryError: !!summary.error, pendingCount, pendingError: personal && !!pending.error && !pending.data, personal, activeOperations: activeOps, fleet: fleet.counts, inventoryReady: !!app.inventory.data && !app.inventory.error };
  const v = verdict(input);
  const pc = resources.find(r => r.id === "computer:desktop");
  const tasks = [
    ...(personal ? (pending.data?.requests ?? []).map(r => keyTask(r, app.now)) : []),
    ...(review.data?.operations ?? []).map(o => reviewTask(o, resources, app.now)),
    ...(incidents.data?.incidents ?? []).filter(i => i.actionable && (i.status === "open" || i.status === "unknown")).map(i => incidentTask(i, resources, app.now)),
  ];
  const readFailed = [personal && pending, review, incidents].some(read => read && !!read.error);
  const loading = !summary.data && !summary.error;

  return <div className={`page hoy hoy--${v.kind}`}>
    <div className="hoy__ambient" aria-hidden="true" />
    <h1 className="visually-hidden">Hoy</h1>
    <HoyHead verdict={v} detail={verdictDetail(v, input)} fetchedAt={summary.data?.fetchedAt ?? null} stale={!!summary.error} coverage={summary.data && summary.data.coverage.scopes > 0 ? summary.data.counts.coverageProblems : null} onRetry={summary.refresh} />
    <div className="hoy__grid">
      <FleetPanel zones={fleet.zones} counts={fleet.counts} ready={!!app.inventory.data} />
      <div className="hoy__main">
        {(v.total ?? 0) > 0 || tasks.length > 0 || readFailed ? <TaskList tasks={tasks} total={v.total} pendingCount={pendingCount} attentionGroups={summary.data?.counts.attentionGroups ?? null} failed={readFailed} /> : loading ? <SkeletonCard rows={2} /> : null}
        {pc && <PcCard resource={pc} />}
        <CasaDevices resources={resources.filter(r => r.kind === "router" || (r.kind === "computer" && r.id !== pc?.id))} />
        <ActiveList operations={activeOps.filter(o => o.resourceId !== pc?.id)} resources={resources} />
        <div className="hoy__pair">
          <MonthCard costs={app.costs.data} error={!!app.costs.error} />
          <RecentCard operations={operations} resources={resources} />
        </div>
      </div>
    </div>
  </div>;
}

/** `coverage` es null si no hay resumen o ninguna fuente comprobada: nunca se muestra como sana. */
function HoyHead({ verdict: v, detail, fetchedAt, stale, coverage: coverageProblems, onRetry }: { verdict: Verdict; detail: string; fetchedAt: string | null; stale: boolean; coverage: number | null; onRetry: () => void }) {
  const app = useAppState();
  const when = fetchedAt ? age(fetchedAt, app.now) : null;
  const eyebrow = !app.online ? `Sin conexión${when ? ` · lectura ${when}` : ""}` : stale ? `Lectura anterior${when ? ` · ${when}` : ""}` : when ? `En vivo · ${when}` : "Conectando";
  return <header className="hoy-head">
    <div className="grow">
      <p className="hoy-head__eyebrow"><span className={`hoy-live${!app.online || stale ? " hoy-live--off" : ""}`} aria-hidden="true" />{eyebrow}</p>
      <h2 className="hoy-head__verdict" aria-live="polite">{v.title}{v.kind === "ok" && <span className="hoy-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg></span>}</h2>
      {detail && <p className="hoy-head__detail">{detail}</p>}
      <Link to={{ name: "me", tab: "system" }} className="hoy-coverage">Cobertura · {coverageProblems === null ? "sin comprobar" : coverageProblems === 0 ? "todas las fuentes leen bien" : coverageProblems === 1 ? "1 fuente con problemas" : `${coverageProblems} fuentes con problemas`} ›</Link>
      {v.kind === "unknown" && <button type="button" className="btn btn--sm mt-12" onClick={onRetry}>Volver a consultar</button>}
    </div>
    <AvatarLink />
  </header>;
}

function FleetPanel({ zones, counts, ready }: { zones: Parameters<typeof FleetScene>[0]["zones"]; counts: FleetCounts; ready: boolean }) {
  // Los chips que señalan un problema abren el inventario ya filtrado: tocar «1 falla» muestra cuál es.
  const chips: { key: string; tone: string; n: number; label: string; problems: boolean }[] = [
    { key: "ok", tone: "ok", n: counts.ok, label: "bien", problems: false },
    { key: "bad", tone: "bad", n: counts.bad, label: counts.bad === 1 ? "falla" : "fallan", problems: true },
    { key: "busy", tone: "busy", n: counts.busy, label: "en curso", problems: false },
    { key: "att", tone: "stale", n: counts.attention, label: "por revisar", problems: true },
    { key: "off", tone: "off", n: counts.off, label: counts.off === 1 ? "apagado" : "apagados", problems: false },
    { key: "unk", tone: "unk", n: counts.unknown, label: "sin datos", problems: true },
  ].filter(chip => chip.n > 0);
  return <section className="hoy-scene" aria-label="Tus equipos">
    <div className="hoy-scene__bar"><span>Tus equipos · en vivo</span><Link to={{ name: "inventory", view: "map" }} className="hoy-link">Abrir mapa ›</Link></div>
    <Link to={{ name: "inventory", view: "map" }} className="hoy-scene__art" aria-label={`Abrir el mapa: ${counts.total} equipos`}>
      {ready ? <><span className="hoy-scene__art--sm"><FleetScene zones={zones} width={300} /></span><span className="hoy-scene__art--lg"><FleetScene zones={zones} width={480} callouts /></span></> : <span className="skeleton hoy-scene__skeleton" />}
    </Link>
    {chips.length > 0 && <ul className="hoy-legend" aria-label="Resumen de equipos">{chips.map(chip => <li key={chip.key}><Link to={{ name: "inventory", view: "devices", problems: chip.problems || undefined }} className="hoy-chip"><StatusDot tone={chip.tone as Parameters<typeof StatusDot>[0]["tone"]} small /><b>{chip.n}</b> {chip.label}</Link></li>)}</ul>}
  </section>;
}

function TaskList({ tasks, total, pendingCount, attentionGroups, failed }: { tasks: Task[]; total: number | null; pendingCount: number | null; attentionGroups: number | null; failed: boolean }) {
  const shown = tasks.slice(0, MAX_TASKS);
  const shownKeys = shown.filter(t => t.tone === "key").length;
  const morePending = pendingCount !== null ? pendingCount - shownKeys : 0;
  const moreOther = attentionGroups !== null ? attentionGroups - (shown.length - shownKeys) : 0;
  return <section className="hoy-card" aria-labelledby="hoy-tasks">
    <h2 className="hoy-card__title" id="hoy-tasks"><span>Te toca</span>{total !== null && total > 0 && <span className="hoy-card__meta">{total}</span>}</h2>
    <ul className="hoy-tasks">{shown.map(task => <li key={task.id}><TaskRow task={task} /></li>)}</ul>
    {failed && <p className="hoy-card__note">Una lista no respondió; el total de arriba viene del resumen del panel.</p>}
    {(morePending > 0 || moreOther > 0) && <div className="hoy-more">
      {morePending > 0 && <Link to={{ name: "agents" }} className="hoy-link">{morePending === 1 ? "1 petición más" : `${morePending} peticiones más`} ›</Link>}
      {moreOther > 0 && <Link to={{ name: "activity" }} className="hoy-link">{moreOther === 1 ? "1 asunto más" : `${moreOther} asuntos más`} en Actividad ›</Link>}
    </div>}
  </section>;
}

const TASK_ICON: Record<Tone, "key" | "info" | "pulse"> = { key: "key", bad: "info", unc: "info", stale: "pulse" };
function TaskRow({ task }: { task: Task }) {
  return <Link to={task.to} className={`hoy-task hoy-task--${task.tone}`}>
    <span className="hoy-task__icon" aria-hidden="true">{task.ring !== undefined && <Ring fraction={task.ring} />}{task.tone === "unc" ? <span className="hoy-task__q">?</span> : <Icon name={TASK_ICON[task.tone]} />}</span>
    <span className="hoy-task__text"><span className="hoy-task__title">{task.title}</span><span className="hoy-task__sub">{task.sub}</span></span>
    {task.age && <span className="t-age">{task.age}</span>}
    {task.action && <span className="hoy-pill">{task.action}</span>}<span className={task.action ? "hoy-task__chev hoy-task__chev--alt" : "hoy-task__chev"}><Chevron /></span>
  </Link>;
}

function Ring({ fraction }: { fraction: number }) {
  const r = 22; const c = 2 * Math.PI * r; const f = Math.min(1, Math.max(0, fraction));
  return <svg className="hoy-ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r={r} className="hoy-ring__track" /><circle cx="24" cy="24" r={r} className="hoy-ring__arc" strokeDasharray={`${(c * f).toFixed(1)} ${c.toFixed(1)}`} /></svg>;
}

function keyTask(request: SecretRequest, now: number): Task {
  const end = Date.parse(request.expiresAt); const start = Date.parse(request.createdAt);
  const known = Number.isFinite(end);
  const left = end - now; const minutes = Math.max(0, Math.ceil(left / 60000));
  const deadline = !known ? "plazo sin comprobar" : left > 0 ? <b className="hoy-urgent">{minutes} min</b> : "plazo cumplido";
  return { id: `key:${request.id}`, tone: "key", title: `${request.machine} pide una clave`, sub: <>{request.name} · {projectLabel(request)} · {deadline}</>, to: { name: "secretRequest", id: request.id }, action: "Revisar", ring: known && Number.isFinite(start) && left > 0 && end > start ? left / (end - start) : undefined };
}

function reviewTask(operation: Operation, resources: readonly DetailedResource[], now: number): Task {
  const kind = resources.find(r => r.id === operation.resourceId)?.kind ?? null;
  const uncertain = operation.state === "uncertain";
  return { id: `op:${operation.id}`, tone: uncertain ? "unc" : "bad", title: operationTitle(operation, kind), sub: uncertain ? "Sin confirmar · revisa antes de repetirla" : "Falló · comprueba el estado antes de otra acción", to: { name: "operation", id: operation.id }, age: age(operation.updatedAt, now) };
}

const INCIDENT_KIND: Record<OperationalIncident["kind"], string> = { application: "La app falla", observability: "Sin observación", availability: "Debería estar encendido", coverage: "Fuente con problemas", budget: "Presupuesto", change: "Cambio externo" };
function incidentTask(incident: OperationalIncident, resources: readonly DetailedResource[], now: number): Task {
  const resource = resources.find(r => r.id === incident.resourceId || r.id === incident.canonicalResourceId);
  const severe = incident.kind === "application" || incident.kind === "availability";
  return { id: `inc:${incident.id}`, tone: severe ? "bad" : "stale", title: `${resource ? displayName(resource) : incident.resourceId ?? incident.scopeKey ?? incident.source}`, sub: incident.status === "unknown" ? `${INCIDENT_KIND[incident.kind]} · estado desconocido` : INCIDENT_KIND[incident.kind], to: resource ? { name: "resource", id: resource.id } : { name: "activity" }, age: age(incident.evidence.observedAt, now) };
}

function PcCard({ resource }: { resource: DetailedResource }) {
  const app = useAppState();
  const control = usePcControl(resource, { stay: true });
  const view = describeResourceState(resource, app.now);
  const op = control.active;
  const stage = op ? operationView(op.state).stage : 0;
  const status = op ? `${operationTitle(op, "computer")} · ${operationView(op.state).label.toLocaleLowerCase("es")}` : view.hint ? `${view.label} · ${view.hint.toLocaleLowerCase("es")}` : view.label;
  return <section className={`hoy-card hoy-pc${op ? " hoy-pc--busy" : ""}`} aria-label={resource.name}>
    <div className="hoy-pc__head">
      <span className="hoy-pc__icon" aria-hidden="true"><Icon name="pc" /></span>
      <span className="grow"><Link to={{ name: "resource", id: resource.id }} className="hoy-pc__name">{resource.name}</Link><span className="hoy-pc__sub">{status}{!op && control.running && control.system && <> · <span>{control.system}</span></>} · <span className="t-age">{age(resource.observedAt, app.now)}</span></span></span>
    </div>
    {op ? <div className="hoy-steps" role="status" aria-label={`Orden ${operationView(op.state).label}`}>
      <div className="hoy-steps__bars">{[1, 2, 3].map(n => <span key={n} className={n < stage ? "is-done" : n === stage ? "is-now" : ""} />)}</div>
      <div className="hoy-steps__labels"><span>Registrada</span><span>En curso</span><span>Resultado</span></div>
      <div className="hoy-steps__foot"><span>{op.message}</span><Link to={{ name: "operation", id: op.id }} className="hoy-pill">Detalle</Link></div>
    </div> : <div className="hoy-pc__actions">
      <button type="button" className={control.running ? "btn btn--secondary btn--block" : "hoy-go"} disabled={control.powerReason !== null} onClick={control.openPower}><Icon name="power" />{control.running ? "Apagar" : "Encender la PC"}</button>
      {!control.canPick && control.running && <button type="button" className="btn btn--block" disabled={control.systemReason !== null} onClick={control.openPicker}>Sistema{control.system ? `: ${control.system}` : ""} ▾</button>}
      {control.powerReason && <p className="hoy-reason">{control.powerReason}</p>}
      {!control.canPick && control.running && control.systemReason && control.systemReason !== control.powerReason && <p className="hoy-reason">Sistema: {control.systemReason}</p>}
    </div>}
    {control.dialogs}
  </section>;
}

function CasaDevices({ resources }: { resources: DetailedResource[] }) {
  const app = useAppState();
  if (!resources.length) return null;
  const extra = resources.length - MAX_DEVICES;
  return <><ul className="hoy-devices" aria-label="Otros equipos de casa">{resources.slice(0, MAX_DEVICES).map(resource => {
    const view = describeResourceState(resource, app.now);
    return <li key={resource.id}><Link to={{ name: "resource", id: resource.id }} className="hoy-device"><StatusDot tone={dotTone(view.tone, view.glyph)} /><span className="grow"><span className="hoy-device__name">{displayName(resource)}</span><span className="hoy-device__state">{view.label} · <span className="t-age">{age(resource.observedAt, app.now)}</span></span></span></Link></li>;
  })}</ul>{extra > 0 && <Link to={{ name: "inventory", view: "devices" }} className="hoy-link">{extra === 1 ? "1 equipo más" : `${extra} equipos más`} ›</Link>}</>;
}

function ActiveList({ operations, resources }: { operations: Operation[]; resources: readonly DetailedResource[] }) {
  if (!operations.length) return null;
  return <section className="hoy-card" aria-labelledby="hoy-active"><h2 className="hoy-card__title" id="hoy-active"><span>En curso</span></h2>
    <ul className="hoy-tasks">{operations.slice(0, 3).map(op => <li key={op.id}><Link to={{ name: "operation", id: op.id }} className="hoy-task hoy-task--busy"><span className="hoy-task__icon" aria-hidden="true"><span className="hoy-spinner" /></span><span className="hoy-task__text"><span className="hoy-task__title">{operationTitle(op, resources.find(r => r.id === op.resourceId)?.kind ?? null)}</span><span className="hoy-task__sub">{operationView(op.state).label}</span></span><Chevron /></Link></li>)}</ul>
  </section>;
}

function MonthCard({ costs, error }: { costs: CostReport | null; error: boolean }) {
  const app = useAppState();
  if (!costs) return <Link to={{ name: "costs" }} className="hoy-card hoy-month">{error ? <><span className="hoy-card__title"><span>Este mes</span></span><span className="hoy-month__sub">No pude leer los costes.</span></> : <SkeletonLines />}</Link>;
  const total = summarizeCosts(costs.accounts);
  const over = costs.accounts.flatMap(a => a.budgets.filter(b => b.limit !== null && b.forecast !== null && b.forecast > b.limit).map(b => ({ account: a.account, by: b.forecast! - b.limit!, currency: b.currency })));
  const points = dailyCosts(costs.accounts).map(d => d.amount).filter((n): n is number => n !== null);
  return <Link to={{ name: "costs" }} className="hoy-card hoy-month">
    <span className="hoy-card__title"><span>Este mes</span><span className="hoy-link">Costes ›</span></span>
    <span className="hoy-month__row"><span><span className="hoy-month__total">{money(total.net, "USD")}</span><span className="hoy-month__sub">Neto estimado · {total.complete ? `${total.count} ${total.count === 1 ? "cuenta" : "cuentas"}` : `suma ${total.count} de ${costs.accounts.length} cuentas`} · <span className="t-age">{age(costs.fetchedAt, app.now)}</span></span></span>{points.length > 1 && <Spark values={points} />}</span>
    {over[0] && <span className="hoy-month__warn">{over[0].account} se pasa {money(over[0].by, over[0].currency)}{over.length > 1 ? ` · y ${over.length - 1} más` : ""}</span>}
  </Link>;
}

function Spark({ values }: { values: number[] }) {
  const w = 120, h = 40, max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  const line = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 4 - (v - min) / span * (h - 8)).toFixed(1)}`).join(" ");
  return <svg className="hoy-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true"><polygon points={`0,${h} ${line} ${w},${h}`} className="hoy-spark__area" /><polyline points={line} className="hoy-spark__line" /></svg>;
}

function RecentCard({ operations, resources }: { operations: readonly Operation[]; resources: readonly DetailedResource[] }) {
  const app = useAppState();
  const recent = operations.filter(o => !isActiveOperation(o) && app.now - Date.parse(o.updatedAt) < DAY_MS).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3);
  return <section className="hoy-card hoy-recent" aria-labelledby="hoy-recent"><h2 className="hoy-card__title" id="hoy-recent"><span>Últimas 24 h</span><Link to={{ name: "activity" }} className="hoy-link">Actividad ›</Link></h2>
    {recent.length ? <ul className="hoy-recent__list">{recent.map(op => { const view = operationView(op.state); return <li key={op.id}><Link to={{ name: "operation", id: op.id }} className="hoy-recent__row"><StatusDot tone={dotTone(view.tone, view.glyph)} small /><span className="grow">{operationTitle(op, resources.find(r => r.id === op.resourceId)?.kind ?? null)} <span className="hoy-recent__state">· {view.label.toLocaleLowerCase("es")}</span></span><span className="t-age">{age(op.updatedAt, app.now)}</span></Link></li>; })}</ul> : <p className="hoy-card__note">{app.operations.data ? "Sin órdenes en las últimas 24 h." : "Leyendo la actividad…"}</p>}
  </section>;
}

function SkeletonCard({ rows }: { rows: number }) {
  return <div className="hoy-card" aria-busy="true" aria-label="Cargando">{Array.from({ length: rows }, (_, i) => <div key={i} className="hoy-skeleton-row"><span className="skeleton hoy-skeleton-row__icon" /><span className="grow"><span className="skeleton hoy-skeleton-row__l1" /><span className="skeleton hoy-skeleton-row__l2" /></span></div>)}</div>;
}
function SkeletonLines() {
  return <span className="hoy-skeleton-lines" aria-busy="true" aria-label="Cargando costes"><span className="skeleton" /><span className="skeleton" /></span>;
}
