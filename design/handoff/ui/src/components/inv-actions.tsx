import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Action, DetailedResource, Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { actionBlocker } from "../lib/controlModel.ts";
import { isActiveOperation, isHermes, powerAction } from "../lib/status.ts";
import { ConfirmPowerDialog } from "./Dialog.tsx";
import { Icon } from "./ui.tsx";
import { InvProgress } from "./inv-rows.tsx";

export interface ResourceActionsState {
  active: Operation | undefined;
  energy: "start" | "stop" | null;
  refreshReason: string | null;
  energyReason: string | null;
  refresh: () => void;
  openPower: () => void;
  dialog: ReactElement | null;
}

/**
 * Consultar y energía de un recurso (no la PC). `Resource.actions` habilita; cada envío revalida el bloqueo con
 * el estado más reciente. La orden aceptada se sigue aquí mismo: 202 no es éxito.
 */
export function useResourceActions(resource: DetailedResource, critical = false): ResourceActionsState {
  const app = useAppState();
  const [confirm, setConfirm] = useState(false);
  const latest = useRef({ app, resource }); latest.current = { app, resource };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const operations = app.operations.data?.operations ?? [];
  const active = operations.find(o => o.resourceId === resource.id && isActiveOperation(o));
  const energy = powerAction(resource);
  const refreshReason = actionBlocker(resource, "refresh", app, operations);
  const energyReason = energy ? actionBlocker(resource, energy, app, operations) : null;
  const send = async (action: Action) => {
    const current = latest.current;
    const actual = current.app.inventory.data?.resources.find(row => row.id === current.resource.id);
    if (!actual) return;
    const blocker = typeof current.app.currentBlocker === "function" ? current.app.currentBlocker(actual.id, action) : actionBlocker(actual, action, current.app, current.app.operations.data?.operations ?? []);
    if (blocker) { if (mounted.current) setConfirm(false); return; }
    try { await current.app.submit({ resourceId: actual.id, action, ...(action === "refresh" ? {} : { confirmed: true }) }); }
    catch { /* El aviso global muestra el fallo de escritura. */ }
    finally { if (mounted.current) setConfirm(false); }
  };
  const stopping = energy === "stop";
  const dialog = confirm && energy ? <ConfirmPowerDialog
    title={`${stopping ? "¿Apagar" : "¿Encender"} ${resource.name}?`}
    lines={[isHermes(resource) && stopping ? "Se detendrá el host que aloja Hermes. El panel seguirá disponible." : `Se enviará una orden a ${resource.name}.`, "Aceptarla no confirma el resultado; lo verás avanzar aquí."]}
    confirmLabel={stopping ? "Sí, apagar" : "Sí, encender"}
    showSleepingHermes={false}
    busy={app.sending || energyReason !== null}
    holdMs={stopping ? critical || isHermes(resource) ? 1500 : 1000 : undefined}
    onCancel={() => setConfirm(false)}
    onConfirm={() => void send(energy)} /> : null;
  return { active, energy, refreshReason, energyReason, refresh: () => void send("refresh"), openPower: () => setConfirm(true), dialog };
}

/** Acciones arriba del detalle; si algo falta, una línea dice por qué. */
export function ResourceActions({ resource, critical = false }: { resource: DetailedResource; critical?: boolean }) {
  const actions = useResourceActions(resource, critical);
  const { active, energy, refreshReason, energyReason } = actions;
  const reasons = refreshReason && energyReason && refreshReason === energyReason ? [refreshReason] : [refreshReason && `Consultar: ${refreshReason}`, energyReason && `Energía: ${energyReason}`].filter((r): r is string => !!r);
  return <div className="inv-actions">
    {active ? <InvProgress operation={active} /> : <>
      <div className="inv-actions__row">
        <button type="button" className="btn btn--primary inv-btn" disabled={refreshReason !== null} onClick={actions.refresh}><Icon name="refresh" />{resource.kind === "router" ? "Leer ahora" : "Consultar ahora"}</button>
        {energy && <button type="button" className="btn inv-btn" disabled={energyReason !== null} onClick={actions.openPower}><Icon name="power" />{energy === "stop" ? "Apagar" : "Encender"}</button>}
      </div>
      {reasons.map(reason => <p key={reason} className="inv-reason">{reason}</p>)}
    </>}
    {actions.dialog}
  </div>;
}
