import { useEffect, useRef, useState, type RefObject } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
import type { SecretApproval, SecretRequest, SecretScope } from "../contract.ts";
import { useRead } from "../hooks/useRead.ts";
import { age, dateTime, secretView } from "../lib/controlModel.ts";
import { destinationLabel, projectLabel, scopeLabel } from "../lib/secrets.ts";
import { countdown, deadlineText, needsProductionConfirm, scopeChoices, validPastedValue } from "../lib/agentsModel.ts";
import { Link } from "../lib/router.tsx";
import { Icon } from "../components/ui.tsx";
import { Card, Empty, Facts, IconTile, Pill, ScreenHead, Segmented, type V2Tone } from "../components/v2.tsx";
import { Declared, ReadGate, Ring, Verified } from "../components/ag-ui.tsx";
import { DecisionDialog } from "../components/DecisionDialog.tsx";

const TONE: Readonly<Record<string, V2Tone>> = { warn: "key", busy: "busy", on: "ok", off: "neutral", unk: "unc", bad: "bad" };

export function SecretRequestDetail({ id }: { id: string }) {
  const app = useAppState();
  const { expire } = useSession();
  const [poll, setPoll] = useState(true);
  const [decision, setDecision] = useState<SecretRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [retryAt, setRetryAt] = useState(0);
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmScope, setConfirmScope] = useState(false);
  const [mode, setMode] = useState<"paste" | "existing">("paste");
  const [value, setValue] = useState("");
  const [itemRef, setItemRef] = useState<string | null>(null);
  const [scope, setScope] = useState<SecretScope>("once");
  const outcome = useRef<HTMLDivElement>(null);
  const decided = useRef(false);
  const read = useRead(async () => { const request = await provider.getSecretRequest(id); setPoll(request.state === "pending" || request.state === "approved"); return request; }, true, poll ? 5000 : null, expire, true);
  const shared = app.secretRequests.data?.requests.find(r => r.id === id);
  const request = read.data && read.data.state !== "pending" ? read.data : decision ?? read.data ?? shared ?? null;
  const items = useRead(() => provider.getSecretItems(request!.project, request!.environment), request?.state === "pending" && mode === "existing", null, expire);
  useEffect(() => { if (request && request.state !== "pending") { setValue(""); setItemRef(null); setConfirmScope(false); } }, [request?.state]);
  // Tras decidir aquí, el resultado aparece donde estaba el formulario: se acerca sin saltar.
  useEffect(() => {
    if (!decided.current || !request || request.state === "pending") return;
    decided.current = false;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    outcome.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    outcome.current?.focus({ preventScroll: true });
  }, [request?.state]);
  const commit = (next: SecretRequest) => { decided.current = true; setDecision(next); read.setData(() => next); setPoll(next.state === "pending" || next.state === "approved"); app.secretRequests.refresh(); };
  const validPaste = validPastedValue(value);
  const selectedItem = itemRef !== null && !!items.data?.items.some(item => item.itemRef === itemRef) && !items.error && !items.loading;
  const reason = !request || request.state !== "pending" ? "Esta petición no espera una decisión." : !app.online ? "Sin conexión. No puedes decidir ahora." : !app.visible ? "Vuelve a la app para decidir." : busy ? "Hay una decisión en curso." : ambiguous ? "No se confirmó la respuesta anterior. Comprueba la petición antes de repetir." : app.now < retryAt ? "Respeta la espera del servidor." : read.error || !read.data ? "Primero comprueba el estado actual de la petición." : Date.parse(request.expiresAt) <= app.now ? "El plazo ya pasó. Espera el estado actualizado." : null;
  const fail = (failure: unknown) => {
    // Nunca se imprime el error recibido: puede contener el valor.
    setError("No se pudo confirmar la decisión. Revisa el estado de la petición.");
    if (failure instanceof ProviderError) {
      if (failure.status === 401) expire();
      if (failure.retryAfterSeconds) setRetryAt(Date.now() + failure.retryAfterSeconds * 1000);
      if (failure.ambiguous) setAmbiguous(true);
    }
    read.refresh(); app.secretRequests.refresh();
  };
  const approve = async (confirmed = false) => {
    if (!request || reason || lock.current || (mode === "paste" ? !validPaste : !selectedItem)) return;
    if (needsProductionConfirm(request.environment, scope) && !confirmed) { setConfirmScope(true); return; }
    const approval: SecretApproval = mode === "paste" ? { mode: "paste", value } : { mode: "existing", itemRef: itemRef! };
    lock.current = true; setBusy(true); setError(null); setConfirmScope(false);
    try { const result = provider.approveSecret(request.id, approval, scope); setValue(""); commit(await result); }
    catch (failure) { fail(failure); }
    finally { setValue(""); setBusy(false); lock.current = false; }
  };
  const deny = async () => {
    if (!request || reason || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setValue("");
    try { commit(await provider.denySecret(request.id)); }
    catch (failure) { fail(failure); }
    finally { setBusy(false); lock.current = false; }
  };

  const back = { to: { name: "agents" } as const, label: "Agentes" };
  if (!request) return <div className="page ag-req"><ScreenHead back={back} title="Petición de clave" /><div className="v2-grid"><ReadGate read={read} label="la petición" rows={4} /></div></div>;
  const pending = request.state === "pending";
  const view = secretView(request.state);
  const c = countdown(request, app.now);
  const missing = mode === "paste" ? !validPaste : !selectedItem;
  const head = pending
    ? <span className="ag-due">{c.known && <span className="ag-due__ring"><Ring fraction={c.fraction ?? 0} size={56} /><b>{c.minutes}</b></span>}<span className="ag-due__text"><b className={c.expired || !c.known ? undefined : "ag-urgent"}>{deadlineText(c)}</b><small>pedida {age(request.createdAt, app.now)}</small></span></span>
    : <span className="ag-due"><Pill tone={TONE[view.tone] ?? "neutral"}>{view.label}</Pill><small className="t-age">pedida {age(request.createdAt, app.now)}</small></span>;
  const facts = [
    { label: "Proyecto", value: projectLabel(request) },
    { label: "Destino", value: <span className="ag-mono">{destinationLabel(request.destination)}</span> },
    { label: "Equipo", value: <span className="ag-inline">{request.machine} <Verified /></span> },
    { label: "Agente", value: <span className="ag-inline">{request.agent} <Declared /></span> },
    { label: "Motivo", value: <span className="ag-inline">«{request.reason}» <Declared /></span> },
    ...(request.decidedAt ? [{ label: "Decidida", value: `${dateTime(request.decidedAt, app.now)}${request.auto ? " · por permiso" : ""}` }] : []),
    ...(request.deliveredAt ? [{ label: "Entregada", value: dateTime(request.deliveredAt, app.now) }] : []),
    ...(request.scope ? [{ label: "Alcance", value: scopeLabel(request.scope) }] : []),
  ];
  return <div className={`page ag-req${pending ? " ag-req--deciding" : ""}`}>
    <ScreenHead back={back} title={<>{request.machine} pide <span className="ag-mono ag-req__key">{request.name}</span></>} detail={head} />
    {!!read.error && !!read.data && <p className="ag-stale" role="status"><span>No pude actualizar la petición; ves la lectura anterior.</span></p>}
    <div className="v2-grid v2-grid--2">
      <Card flush label="Qué, quién y para qué" className="ag-req__facts"><div className="ag-pad"><Facts items={facts} /></div></Card>
      <div className="v2-stack v2-sticky">
        {pending ? <>
          <Card title="¿Qué le entregas?" id="ag-give">
            <Segmented label="Origen de la clave" value={mode} items={[{ key: "paste", label: "Pegar nueva" }, { key: "existing", label: "Elegir guardada" }]} onChange={key => { setMode(key); if (key === "paste") setItemRef(null); else setValue(""); }} />
            {mode === "paste" ? <label className="ag-field mt-12"><span className="ag-field__label">Valor de la clave</span><input className="ag-input ag-mono" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={value} onChange={event => setValue(event.target.value)} disabled={busy} /><span className={value && !validPaste ? "ag-field__hint ag-field__hint--bad" : "ag-field__hint"}>{value && !validPaste ? "Usa una sola línea de hasta 8 KB." : "Una línea, hasta 8 KB. Se borra al enviar."}</span></label>
              : <div className="mt-12"><ReadGate read={items} label="las claves guardadas" rows={2}>{items.data && (items.data.items.length > 0 ? <div className="ag-choices" role="radiogroup" aria-label="Clave guardada">{items.data.items.map(item => <label className="ag-choice" key={item.itemRef}><input type="radio" name="vault-item" checked={itemRef === item.itemRef} onChange={() => setItemRef(item.itemRef)} /><span className="ag-choice__text"><b className="ag-mono">{item.name}</b><small>actualizada {age(item.updatedAt, app.now)}</small></span></label>)}</div> : <Empty title="No hay claves guardadas aquí. Pega una nueva." />)}</ReadGate></div>}
          </Card>
          <Card title="¿Por cuánto tiempo?" id="ag-scope">
            <fieldset className="ag-choices ag-fieldset"><legend className="visually-hidden">Alcance del permiso</legend>{scopeChoices(request.machine).map(option => <label className="ag-choice" key={option.value}><input type="radio" name="secret-scope" value={option.value} checked={scope === option.value} onChange={() => setScope(option.value)} /><span className="ag-choice__text"><b>{option.label}</b><small>{option.hint}</small></span></label>)}</fieldset>
          </Card>
          <div className="ag-actions" role="group" aria-label="Decisión">
            {(reason || missing) && <p className="ag-actions__why" role="status">{reason ?? (mode === "paste" ? "Pega la clave para aprobar." : "Elige una clave guardada para aprobar.")}</p>}
            <div className="ag-actions__row"><button type="button" className="btn ag-btn" disabled={reason !== null} onClick={() => void deny()}>Denegar</button><button type="button" className="btn btn--primary ag-btn" disabled={reason !== null || missing} onClick={() => void approve()}>Aprobar y entregar</button></div>
          </div>
        </> : <Outcome refEl={outcome} request={request} />}
        {error && <p className="ag-line ag-line--bad" role="alert">{error}</p>}
        {ambiguous && <button className="btn ag-btn" type="button" disabled={!app.online || read.loading || app.now < read.retryAt} onClick={read.refresh}>Comprobar petición</button>}
      </div>
    </div>
    {confirmScope && <DecisionDialog title="¿Dar un permiso permanente en producción?" onCancel={() => setConfirmScope(false)} actions={<><button className="btn" type="button" onClick={() => setConfirmScope(false)}>Cancelar</button><button className="btn btn--primary" type="button" disabled={reason !== null} onClick={() => void approve(true)}>Confirmar permiso y entregar</button>{reason && <p className="t-small">{reason}</p>}</>}><p>{scopeLabel(scope)} permite entregas futuras sin preguntarte. Lo comparten todos los agentes de {request.machine}.</p></DecisionDialog>}
  </div>;
}

function Outcome({ request, refEl }: { request: SecretRequest; refEl: RefObject<HTMLDivElement | null> }) {
  const app = useAppState();
  const known: Record<string, { tone: V2Tone; icon: "key" | "info"; title: string; sub: string }> = {
    approved: { tone: "ok", icon: "key", title: "Aprobada", sub: `El agente la recogerá antes de ${dateTime(request.expiresAt, app.now)}.` },
    delivered: { tone: "ok", icon: "key", title: "El agente ya la tiene", sub: `La recogió ${request.deliveredAt ? age(request.deliveredAt, app.now) : "sin fecha registrada"}.` },
    denied: { tone: "neutral", icon: "info", title: "No le entregaste nada", sub: request.decidedAt ? `La denegaste ${dateTime(request.decidedAt, app.now)}.` : "La petición quedó cerrada." },
    expired: { tone: "stale", icon: "info", title: "Nadie decidió a tiempo", sub: "El agente debe pedirla otra vez." },
    failed: { tone: "bad", icon: "info", title: "La entrega no salió", sub: "No se reintenta sola. El agente debe pedirla otra vez." },
  };
  const view = known[request.state] ?? { tone: "unc" as const, icon: "info" as const, title: "Estado sin descripción", sub: "Las decisiones están deshabilitadas." };
  return <div ref={refEl} tabIndex={-1} className={`v2-card ag-outcome ag-outcome--${view.tone}`} role="status" aria-label="Resultado de la petición">
    <div className="ag-outcome__head"><IconTile tone={view.tone}><Icon name={view.icon} /></IconTile><span><b className="ag-outcome__title">{view.title}</b><span className="ag-outcome__sub">{view.sub}</span></span></div>
    <Link to={{ name: "agents" }} className="btn ag-btn ag-btn--block">Volver a Agentes</Link>
  </div>;
}

