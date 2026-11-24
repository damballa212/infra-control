import { useEffect, useRef, useState } from "react";
import type { DetailedResource, Operation, ReviewReason } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { useRead } from "../hooks/useRead.ts";
import { Link } from "../lib/router.tsx";
import { age, dateTime, operationView } from "../lib/controlModel.ts";
import { isActiveOperation, operationTitle } from "../lib/status.ts";
import { historySteps } from "../lib/insight.ts";
import { localClock, orderTone } from "../lib/activityModel.ts";
import { displayedOperation, operationResource, useOperationalRefresh } from "../lib/activityRefresh.ts";
import { Card, Facts, Pill, ScreenHead } from "./v2.tsx";
import { ReadState } from "./act-ui.tsx";
import { OrderStages } from "./Stages.tsx";
import { DecisionDialog } from "./DecisionDialog.tsx";

/** Pasos visibles antes de «Ver todo»: la línea de tiempo nunca se pagina. */
const STEPS_SHOWN = 12;

export function OperationScreen({ id }: { id: string }) { return <OperationDetail key={id} id={id} />; }

const DISPOSITION: Record<string, { label: string; tone: "unc" | "ok" | "neutral" }> = { pending: { label: "Por revisar", tone: "unc" }, reviewed: { label: "Revisada", tone: "ok" }, superseded: { label: "Sustituida", tone: "neutral" } };
const REASONS: Record<string, string> = { execution_not_confirmed: "La ejecución no quedó confirmada.", checked_state: "Comprobaste el estado.", accepted_uncertainty: "Aceptaste la incertidumbre.", no_further_action: "Decidiste no actuar de nuevo.", later_confirmed_same_target: "Una orden posterior confirmó el mismo destino.", later_confirmed_new_power_intention: "Una orden posterior confirmó otro destino de energía." };

/** Disposición de la revisión humana: no cambia el resultado histórico de la orden. */
function Disposition({ operation }: { operation: Operation }) {
  const app = useAppState();
  const review = operation.review;
  if (!review) return null;
  const view = DISPOSITION[review.disposition] ?? { label: "Revisión", tone: "neutral" as const };
  return <div className="act-disp" data-operation-disposition={review.disposition}>
    <div className="act-disp__head"><Pill tone={view.tone}>{view.label}</Pill>{review.reviewedAt && <span className="t-age">{review.reviewedBy} · {dateTime(review.reviewedAt, app.now)}</span>}</div>
    <p className="act-disp__reason">{REASONS[review.reason] ?? `Motivo registrado: ${review.reason}`}</p>
    {review.supersededByOperationId && <Link className="act-inline-link" to={{ name: "operation", id: review.supersededByOperationId }}>Ver decisión posterior</Link>}
  </div>;
}

function OperationDetail({ id }: { id: string }) {
  const app = useAppState(); const { user, expire } = useSession();
  const shared = app.operations.data?.operations.find(row => row.id === id);
  const [poll, setPoll] = useState(true);
  // Todas las lecturas individuales siguen pasando por el lector compartido y su singleflight.
  const query = useRead(async () => { const value = await app.readOperation(id); setPoll(isActiveOperation(value)); return value; }, !shared, poll ? 5000 : null, expire, true, { identity: `operation:${id}` });
  const operation = shared ? displayedOperation(shared, query.data ?? undefined) : query.data;
  const active = operation ? isActiveOperation(operation) : false;
  const history = useRead(() => provider.getOperationHistory(id), true, null, expire, true, { identity: `operation-history:${id}` });
  useOperationalRefresh(history, active ? 5000 : 60000);
  const state = operation?.state, reviewVersion = operation?.review?.version;
  useEffect(() => { if (state) history.refresh(); }, [state, reviewVersion, history.refresh]);
  const [checked, setChecked] = useState(false);
  const [decision, setDecision] = useState<{ version: number; state: Operation["state"] } | null>(null);
  const [reason, setReason] = useState<ReviewReason | "">("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [feedback, setFeedback] = useState<string | null>(null);
  const [mustRead, setMustRead] = useState(false), [retryAt, setRetryAt] = useState(0);
  const [allSteps, setAllSteps] = useState(false);
  const lock = useRef(false), alive = useRef(false), deadline = useRef(0);
  const context = useRef({ user, online: app.online, visible: app.visible, operation });
  context.current = { user, online: app.online, visible: app.visible, operation };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const personal = user?.name === "Admin" && !user.agent;
  // La espera de la lectura individual solo cuenta mientras esa lectura es la fuente (sin copia compartida).
  const queryWait = () => shared ? 0 : query.retryAt;
  const stillHere = (startedUser: typeof user) => alive.current && context.current.user === startedUser;
  const available = () => alive.current && context.current.user?.name === "Admin" && !context.current.user.agent && context.current.online && context.current.visible && navigator.onLine && document.visibilityState !== "hidden" && Date.now() >= deadline.current;
  const handleFailure = (failure: unknown) => {
    if (failure instanceof ProviderError && failure.status === 401) { expire(); return; }
    if (failure instanceof ProviderError && failure.retryAfterSeconds !== null) { deadline.current = Math.max(deadline.current, Date.now() + failure.retryAfterSeconds * 1000); setRetryAt(deadline.current); }
    if (!(failure instanceof ProviderError) || failure.ambiguous || failure.status === 409) {
      setMustRead(true);
      setError(failure instanceof ProviderError && failure.status === 409 ? "La revisión cambió. Vuelve a leerla antes de decidir." : "No se confirmó la revisión. Vuelve a leerla antes de repetir; no se reenvía automáticamente.");
    } else setError(failure.status === 403 ? "Esta decisión requiere una sesión personal autorizada." : "No se pudo guardar la revisión. Respeta la espera antes de volver a decidir.");
  };
  const reread = async (openDecision: boolean) => {
    if (lock.current || !available() || Date.now() < queryWait()) return;
    const startedUser = context.current.user;
    lock.current = true; setBusy(true); setError(null); setFeedback(null);
    try {
      const value = await app.readOperation(id);
      if (!stillHere(startedUser)) return;
      app.attach(value); query.setData(() => value); history.refresh(); setMustRead(false);
      if (openDecision && value.review?.disposition === "pending" && available()) { setReason(""); setDecision({ version: value.review.version, state: value.state }); }
      else if (openDecision) setFeedback("La revisión ya no está pendiente. Se muestra la disposición recibida.");
      else setFeedback("Revisión consultada. No se envió ninguna decisión ni orden de energía.");
    } catch (failure) { if (stillHere(startedUser)) handleFailure(failure); }
    finally { lock.current = false; if (stillHere(startedUser)) setBusy(false); }
  };
  const saveReview = async () => {
    const latest = context.current.operation;
    if (lock.current || !available() || mustRead || !decision || !reason) return;
    if (latest?.review?.disposition !== "pending" || latest.review.version !== decision.version) { setDecision(null); setMustRead(true); setError("La revisión cambió mientras decidías. Vuelve a leerla."); return; }
    const startedUser = context.current.user, submitted = decision;
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await provider.reviewOperation(id, submitted.version, reason);
      if (!stillHere(startedUser)) return;
      if (result.id !== id || result.state !== submitted.state || result.review?.disposition !== "reviewed") throw new Error("Respuesta de revisión inconsistente");
      app.attach(result); query.setData(() => result); app.operations.refresh(); app.inventory.refresh(); history.refresh();
      setDecision(null); setMustRead(false); setFeedback("Revisión guardada. El resultado histórico se conserva.");
      window.dispatchEvent(new Event("infra:operation-review"));
    } catch (failure) { if (stillHere(startedUser)) { setDecision(null); handleFailure(failure); } }
    finally { lock.current = false; if (stillHere(startedUser)) setBusy(false); }
  };
  const resource = operationResource(operation, app.inventory.data?.resources ?? []);
  const steps = historySteps([...(history.data?.events ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id));
  const shownSteps = allSteps ? steps : steps.slice(-STEPS_SHOWN);
  const view = operation ? operationView(operation.state) : null;
  const doubtful = operation?.state === "uncertain" || operation?.state === "failed";
  const check = () => { setChecked(true); app.inventory.refresh(); app.operations.refresh(); query.refresh(); };
  const waiting = app.now < Math.max(retryAt, shared ? 0 : query.retryAt);
  const reviewBlocked = !personal || !app.online || !app.visible || busy || waiting;
  const tone = operation ? orderTone(operation.state) : "neutral";

  return <div className={`page act-op act-op--${tone}`}>
    <ScreenHead back={{ to: { name: "activity" }, label: "Actividad" }} eyebrow={operation ? `Orden · ${resource?.name ?? operation.resourceName}` : "Orden"} title={operation ? operationTitle(operation, resource?.kind ?? null) : "Orden"} detail={operation && view ? <span className="act-op__status"><Pill tone={tone}>{view.label}</Pill><span className="t-age">{active ? "en curso" : "actualizada"} {age(operation.updatedAt, app.now)}</span></span> : undefined} />
    {!shared && <div className="act-op__read"><ReadState read={query} what="la orden" rows={3} /></div>}
    {operation && view && <>
      {(doubtful || operation.review) && <section className={`v2-card act-callout act-callout--${doubtful ? tone : "neutral"}`} aria-label="Revisión">
        {doubtful && <p className="act-callout__lead"><strong>{operation.state === "uncertain" ? "No sabemos si se aplicó." : "Falló."}</strong> {operation.state === "uncertain" ? "No la repitas: comprueba el estado primero." : "Comprueba el estado antes de otra acción."}</p>}
        <Disposition operation={operation} />
        {operation.review && <div className="act-callout__actions">
          {operation.review.disposition === "pending" && personal && <button className="btn btn--primary" type="button" disabled={reviewBlocked || mustRead} onClick={() => void reread(true)}>Marcar como revisada</button>}
          {mustRead && personal && <button className="btn" type="button" disabled={reviewBlocked} onClick={() => void reread(false)}>Comprobar revisión guardada</button>}
        </div>}
        {operation.review?.disposition === "pending" && !personal && <p className="act-reason">La revisión durable corresponde a una sesión personal.</p>}
        {waiting && <p className="act-reason">Respeta la espera del servidor antes de volver a consultar o decidir.</p>}
        {error && <p className="act-error" role="alert">{error}</p>}{feedback && <p className="act-reason" role="status">{feedback}</p>}
      </section>}
      <div className="v2-grid v2-grid--2 act-op__grid">
        <div className="v2-stack">
          <Card title={active ? "Ejecución" : "Resultado"} meta={dateTime(operation.createdAt, app.now)}>
            <OrderStages state={operation.state} />
            <p className="act-op__msg" role="status">{operation.message}</p>
          </Card>
          <Card title="Qué pasó" meta="hora local">
            <ReadState read={history} what="el historial" rows={2} />
            {steps.length > 0 && <ol className="act-timeline">{shownSteps.map((step, index) => <li key={step.id} className={index === shownSteps.length - 1 ? `is-last is-${tone}` : ""}>
              <time dateTime={step.at} title={dateTime(step.at, app.now)}>{localClock(step.at)}</time><span className="act-timeline__dot" aria-hidden="true" /><span className="act-timeline__text"><span className="act-timeline__label">{step.label}</span>{step.message && <span className="act-timeline__msg">{step.message}</span>}</span>
            </li>)}</ol>}
            {steps.length > STEPS_SHOWN && <button type="button" className="v2-link act-timeline__all" onClick={() => setAllSteps(value => !value)}>{allSteps ? "Ver solo los últimos" : `Ver todo (${steps.length})`}</button>}
            {history.data && !history.loading && !history.error && !steps.length && <p className="act-reason">Sin eventos de estado en el historial recibido.</p>}
          </Card>
        </div>
        <div className="v2-stack">
          {doubtful && <Evidence operation={operation} resource={resource} checked={checked} onCheck={check} />}
          <Card title="Quién y desde dónde">
            <Facts items={[
              { label: "Autor", value: operation.actor },
              { label: "Equipo", value: resource ? <Link className="act-inline-link" to={{ name: "resource", id: resource.id }}>{resource.name}</Link> : operation.resourceName },
              { label: "Registrada", value: dateTime(operation.createdAt, app.now) },
              { label: "Actualizada", value: dateTime(operation.updatedAt, app.now), age: age(operation.updatedAt, app.now) },
            ]} />
          </Card>
          <details className="v2-card act-tech"><summary>Datos técnicos</summary><Facts items={[{ label: "ID orden", value: operation.id }, { label: "Recurso", value: operation.resourceId }, { label: "Acción", value: operation.action }, { label: "Estado recibido", value: operation.state }]} /></details>
        </div>
      </div>
      {decision && <DecisionDialog title="¿Marcar esta orden como revisada?" onCancel={() => { if (!busy) setDecision(null); }} actions={<><button className="btn" type="button" disabled={busy} onClick={() => setDecision(null)}>Cancelar</button><button className="btn btn--primary" type="button" disabled={reviewBlocked || !reason || mustRead || operation.review?.version !== decision.version} onClick={() => void saveReview()}>Confirmar revisión</button></>}><p>Se guarda tu decisión. No confirma la ejecución, no declara recuperación y no envía otra orden de energía.</p><label className="field mt-12"><span>Motivo de revisión</span><select className="act-select" value={reason} disabled={busy} onChange={event => setReason(event.target.value as ReviewReason | "")}><option value="">Elige un motivo</option><option value="checked_state">He comprobado el estado</option><option value="accepted_uncertainty">Acepto la incertidumbre</option><option value="no_further_action">No requiere otra acción</option></select></label>{operation.review?.version !== decision.version && <p role="status" className="t-small mt-8">La disposición cambió; cancela y vuelve a leerla.</p>}</DecisionDialog>}
    </>}
  </div>;
}

/** Lo esperado frente a lo observado. Consultar no marca la orden como revisada ni confirma su ejecución. */
function Evidence({ operation, resource, checked, onCheck }: { operation: Operation; resource: DetailedResource | undefined; checked: boolean; onCheck: () => void }) {
  const app = useAppState();
  const expected = operation.action === "start" ? "Encendida" : operation.action === "stop" ? "Detenida" : "Lo que pidió la orden";
  const reading = app.inventory.loading || app.now < app.inventory.retryAt;
  return <Card title="Evidencia posterior" meta={resource ? age(resource.observedAt, app.now) : undefined}>
    <Facts items={[
      { label: "Esperado", value: expected },
      { label: "Observado", value: resource?.state ?? "Sin equipo con identidad acreditada", age: resource ? age(resource.observedAt, app.now) : undefined },
      { label: "Transición", value: resource?.stateChangedAt ? dateTime(resource.stateChangedAt, app.now) : "Sin transición observada" },
    ]} />
    <button type="button" className="btn btn--block act-evidence__check" disabled={!app.online || !app.visible || reading} onClick={onCheck}>{reading && checked ? "Consultando…" : `Consultar estado de ${operation.resourceName}`}</button>
    {checked && !reading && (app.inventory.error ? <p className="act-error" role="status">No pude leer el estado. Vuelve a intentarlo.</p> : <p className="act-reason" role="status">Consultado. Esto no marca la orden como revisada.</p>)}
  </Card>;
}
