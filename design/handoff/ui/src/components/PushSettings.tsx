import { useEffect, useRef, useState } from "react";
import { provider } from "../app/providers.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { useRead } from "../hooks/useRead.ts";
import { useNow } from "../hooks/usePlatform.ts";
import { ProviderError } from "../../../integration/provider.ts";
import type { PushCategory, PushDevice } from "../contract.ts";
import { currentSubscription, pushBlocker, subscribeThisDevice, unsubscribeThisDevice } from "../lib/push.ts";
import { pushDisabled, setPushDisabled } from "../lib/pushIntent.ts";
import { age } from "../lib/controlModel.ts";
import { Link } from "../lib/router.tsx";
import { Icon } from "./ui.tsx";
import { Card, IconTile, Pill, Row, Rows, type V2Tone } from "./v2.tsx";
import { ReadGate } from "./ag-ui.tsx";

type Phase = { kind: "server-off" | "unsupported" | "denied" } | { kind: "off"; key: string } | { kind: "on"; key: string; device: PushDevice };
type Mutation = "preferences" | "register" | "test" | "remove";
const CATEGORIES: readonly { id: PushCategory; label: string }[] = [{ id: "operations", label: "Órdenes terminadas" }, { id: "devices", label: "PC y MacBook" }, { id: "router", label: "Router" }, { id: "infrastructure", label: "Servidores y servicios" }, { id: "budgets", label: "Presupuestos" }, { id: "secrets", label: "Claves que piden los agentes" }, { id: "secretDeliveries", label: "Claves entregadas sin pedirte" }];
function completeDevice(device: PushDevice): boolean { return typeof device.id === "string" && !!device.preferences && CATEGORIES.every(category => typeof device.preferences[category.id] === "boolean"); }
export function PushSettings() {
  const app = useAppState(); const { expire } = useSession(); const now = useNow(1000);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [retryAt, setRetryAt] = useState(0); const deadline = useRef(0);
  const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState(false);
  const [reconciling, setReconciling] = useState(false); const reconciliation = useRef<Mutation | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latestApp = useRef(app); latestApp.current = app;
  const read = useRead<Phase>(async () => {
    if (Date.now() < deadline.current) throw new ProviderError({ kind: "http", status: 429, retryAfterSeconds: Math.ceil((deadline.current - Date.now()) / 1000), message: "Espera antes de comprobar los avisos" });
    const config = await provider.getPushConfig();
    if (!config.enabled || !config.vapidPublicKey) return { kind: "server-off" };
    const browserBlocker = pushBlocker(); if (browserBlocker) return { kind: browserBlocker };
    if (pushDisabled()) return { kind: "off", key: config.vapidPublicKey };
    let subscription;
    try { subscription = await currentSubscription(); }
    catch (failure) { if (failure instanceof Error && failure.message === "no-service-worker") subscription = null; else throw failure; }
    if (!subscription) {
      if (reconciliation.current === null) return { kind: "off", key: config.vapidPublicKey };
      throw new Error("No hay suscripción local con la que reconciliar el estado del servidor");
    }
    // Endpoint real, idempotente por endpoint: devuelve el objeto completo vigente.
    if (pushDisabled()) return { kind: "off", key: config.vapidPublicKey };
    const device = await provider.registerPush(subscription);
    if (!completeDevice(device)) throw new Error("incomplete-device");
    if (mounted.current) { reconciliation.current = null; setReconciling(false); }
    return { kind: "on", key: config.vapidPublicKey, device };
  }, !busy && !unavailable && now >= retryAt, null, expire, true);
  const phase = read.data;
  const currentBlocker = () => {
    const context = latestApp.current; const state = read.getState();
    if (!mounted.current || !context.online || !navigator.onLine) return "Sin conexión. No puedes cambiar los avisos.";
    if (!context.visible || document.visibilityState === "hidden") return "Vuelve a la app para cambiarlos.";
    if (lock.current) return "Hay un cambio en curso.";
    if (Date.now() < deadline.current || Date.now() < state.retryAt) return "El servidor pidió esperar antes de otro cambio.";
    if (reconciliation.current !== null) return unavailable ? "No hay un endpoint de lectura que confirme esta eliminación. Las mutaciones quedan bloqueadas; no se vuelve a registrar la suscripción." : "Comprobando las preferencias vigentes antes de permitir otro cambio.";
    if (state.loading || state.error || !state.data) return "Primero comprueba el estado de los avisos.";
    return null;
  };
  const blocker = currentBlocker();
  const run = async (kind: Mutation, task: (current: Phase) => Promise<Phase | void>, success: string | null) => {
    if (currentBlocker()) return;
    const current = read.getState().data;
    if (!current) return;
    lock.current = true; setBusy(true); setMessage(null); setError(false);
    try {
      const next = await task(current);
      if (!mounted.current) return;
      if (next) read.setData(() => next);
      setMessage(success);
    } catch (failure) {
      if (failure instanceof ProviderError && failure.retryAfterSeconds !== null) deadline.current = Math.max(deadline.current, Date.now() + failure.retryAfterSeconds * 1000);
      if (!mounted.current) return;
      setRetryAt(deadline.current); setError(true);
      setMessage(failure instanceof Error && failure.message === "permission-denied" ? "El permiso de notificaciones está bloqueado. Revísalo en los ajustes de este navegador." : "No se pudo confirmar el cambio de avisos. No se repite automáticamente.");
      if (failure instanceof ProviderError && failure.status === 401) expire();
      if (failure instanceof ProviderError && failure.ambiguous) {
        if (kind === "register" && pushDisabled()) {
          // El opt-out prohíbe reconciliar por registro automático: solo otro gesto humano.
          reconciliation.current = null; setReconciling(false);
          setMessage("No se confirmó la activación. Puedes volver a activarlos explícitamente; no se reintenta automáticamente.");
        } else {
          reconciliation.current = kind; setReconciling(true);
          if (kind === "remove") setUnavailable(true);
          else read.refresh();
        }
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const register = () => void run("register", async current => { if (current.kind !== "off") return; const subscription = await subscribeThisDevice(current.key); if (!mounted.current || !latestApp.current.online || !navigator.onLine || !latestApp.current.visible || document.visibilityState === "hidden" || Date.now() < deadline.current) throw new Error("Contexto cambiado antes de registrar"); const device = await provider.registerPush(subscription); if (!completeDevice(device)) throw new Error("incomplete-device"); setPushDisabled(false); return { kind: "on", key: current.key, device }; }, "Avisos activados en este teléfono.");
  const toggle = (category: PushCategory) => void run("preferences", async current => { if (current.kind !== "on") return; const preferences = { ...current.device.preferences, [category]: !current.device.preferences[category] }; await provider.updatePushPreferences(current.device.id, preferences); return { ...current, device: { ...current.device, preferences } }; }, null);
  const test = () => void run("test", async current => { if (current.kind === "on") await provider.testPush(current.device.id); }, "Prueba enviada. Que salga no confirma que llegue: revisa este teléfono.");
  const remove = () => void run("remove", async current => { if (current.kind !== "on") return; setPushDisabled(true); try { await provider.removePush(current.device.id); } catch (failure) { try { await unsubscribeThisDevice(); } catch { /* El opt-out impide recrear la suscripción incluso si falla la baja local. */ } throw failure; } await unsubscribeThisDevice(); return { kind: "off", key: current.key }; }, "Avisos desactivados en este navegador.");
  const status = <>
    {blocker && <p className="ag-line">{blocker}</p>}
    {reconciling && !unavailable && <button type="button" className="btn ag-btn ag-btn--block" disabled={!app.online || !app.visible || busy || read.loading || now < Math.max(retryAt, read.retryAt)} onClick={read.refresh}>Comprobar preferencias vigentes</button>}
    {message && <p className={error ? "ag-line ag-line--bad" : "ag-line"} role={error ? "alert" : "status"}>{message}</p>}
  </>;
  const bell = (tone: V2Tone) => <IconTile tone={tone}><Icon name="bell" /></IconTile>;
  return <>
    <Card title="Este navegador" flush id="me-push" className="sc-push-settings">
      <ReadGate read={read} label="los avisos">
        {phase?.kind === "server-off" && <Rows><li><Row lead={bell("off")} title="Avisos sin configurar" sub="El servidor aún no tiene avisos." /></li></Rows>}
        {phase?.kind === "unsupported" && <><Rows><li><Row lead={bell("off")} title="Este navegador no recibe avisos" sub="En iPhone, primero instala la app." /></li></Rows><div className="ag-pad"><Link className="btn ag-btn ag-btn--block" to={{ name: "install" }}>Instalar en el teléfono</Link></div></>}
        {phase?.kind === "denied" && <Rows><li><Row lead={bell("stale")} title="Notificaciones bloqueadas" sub="El permiso de notificaciones está bloqueado. Actívalo en los ajustes del teléfono." /></li></Rows>}
        {phase?.kind === "off" && <><Rows><li><Row lead={bell("neutral")} title="Sin avisos aquí" sub="Los avisos nunca incluyen valores de claves." /></li></Rows><div className="ag-pad"><button className="btn btn--primary ag-btn ag-btn--block" type="button" disabled={blocker !== null} onClick={register}>Activar avisos en este teléfono</button></div></>}
        {phase?.kind === "on" && <Rows><li><Row lead={bell("ok")} title="Recibe avisos" sub={phase.device.lastSuccessAt ? `Último aviso entregado ${age(phase.device.lastSuccessAt, app.now)}` : "Aún sin entregas registradas"} trailing={<Pill tone="ok">Activos</Pill>} /></li></Rows>}
        {phase?.kind !== "on" && <div className="ag-pad ag-pad--top0">{status}</div>}
      </ReadGate>
    </Card>
    {phase?.kind === "on" && <div className="v2-stack">
      <Card title="Qué te avisa" flush id="me-push-categories">
        <ul className="v2-rows" aria-label="Categorías de avisos">{CATEGORIES.map(category => <li key={category.id}><label className="me-toggle"><span>{category.label}</span><input className="toggle" type="checkbox" checked={phase.device.preferences[category.id]} disabled={blocker !== null} onChange={() => toggle(category.id)} /></label></li>)}</ul>
      </Card>
      <div className="me-push-actions">
        <button type="button" className="btn ag-btn ag-btn--block" disabled={blocker !== null} onClick={test}>Enviar aviso de prueba</button>
        <button type="button" className="btn ag-btn ag-btn--block ag-btn--danger" disabled={blocker !== null} onClick={remove}>Desactivar en este teléfono</button>
        {status}
      </div>
    </div>}
  </>;
}
