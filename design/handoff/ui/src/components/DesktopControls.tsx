import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Action, DetailedResource, Operation } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { actionBlocker } from "../lib/controlModel.ts";
import { isActiveOperation } from "../lib/status.ts";
import { navigate } from "../lib/router.tsx";
import { Icon } from "./ui.tsx";
import { ConfirmPowerDialog, SystemPickerDialog } from "./Dialog.tsx";
import { StopDialog } from "./StopDialog.tsx";
import { InvProgress } from "./inv-rows.tsx";

export interface PcControl {
  active: Operation | undefined;
  running: boolean;
  canPick: boolean;
  system: string | null;
  powerReason: string | null;
  systemReason: string | null;
  openPower: () => void;
  openPicker: () => void;
  dialogs: ReactElement;
}

/**
 * Lógica compartida de energía de la PC. `Resource.actions` decide qué se habilita y cada envío
 * revalida el bloqueo con el estado más reciente. `stay` mantiene la vista actual tras aceptar la orden.
 */
export function usePcControl(resource: DetailedResource, { stay = false }: { stay?: boolean } = {}): PcControl {
  const app = useAppState();
  const [confirm, setConfirm] = useState(false); const [picker, setPicker] = useState(false);
  const latest = useRef({ app, resource }); latest.current = { app, resource };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const operations = app.operations.data?.operations ?? [];
  const active = operations.find(o => o.resourceId === resource.id && isActiveOperation(o));
  const running = resource.state === "running";
  const bootActions = resource.actions.filter(a => a === "boot-windows" || a === "boot-cachyos");
  const permittedBoots = bootActions.filter(action => actionBlocker(resource, action, app, operations) === null);
  const canPick = !running && bootActions.length > 0;
  const systemReason = permittedBoots.length ? null : bootActions.length ? actionBlocker(resource, bootActions[0]!, app, operations) : "El proveedor no ofrece selección de sistema para este estado.";
  const primary: Action = running ? "stop" : "start";
  const powerReason = canPick ? systemReason : actionBlocker(resource, primary, app, operations);
  const send = async (action: Action) => {
    if (!mounted.current) return;
    const current = latest.current;
    const actual = current.app.inventory.data?.resources.find(row => row.id === current.resource.id);
    if (!actual) return;
    const blocker = typeof current.app.currentBlocker === "function" ? current.app.currentBlocker(actual.id, action) : actionBlocker(actual, action, { ...current.app, now: Date.now(), online: current.app.online && navigator.onLine, visible: current.app.visible && document.visibilityState !== "hidden" }, current.app.operations.data?.operations ?? []);
    if (blocker) return;
    try { const operation = await current.app.submit({ resourceId: actual.id, action, confirmed: true }); if (!mounted.current) return; setConfirm(false); setPicker(false); if (!stay) navigate({ name: "operation", id: operation.id }); }
    catch { if (mounted.current) { setConfirm(false); setPicker(false); } }
  };
  const system = resource.system === "windows" ? "Windows" : resource.system === "cachyos" ? "CachyOS" : null;
  const followUp = stay ? "La aceptación no confirma el encendido; lo verás avanzar aquí." : "La aceptación no confirma el encendido; sigue la orden en Actividad.";
  const dialogs = <>{confirm && running && <StopDialog busy={app.sending || powerReason !== null} onCancel={() => setConfirm(false)} onStop={() => void send("stop")} />}{confirm && !running && <ConfirmPowerDialog title="¿Encender la PC?" lines={["Arrancará con su sistema predeterminado.", followUp]} confirmLabel="Sí, encender" showSleepingHermes={false} busy={app.sending || powerReason !== null} onCancel={() => setConfirm(false)} onConfirm={() => void send("start")} />}{picker && <SystemPickerDialog current={resource.system} running={running} actions={permittedBoots} busy={app.sending} onCancel={() => setPicker(false)} onChoose={chosen => void send(chosen === "windows" ? "boot-windows" : "boot-cachyos")} />}</>;
  return { active, running, canPick, system, powerReason, systemReason, openPower: () => canPick ? setPicker(true) : setConfirm(true), openPicker: () => setPicker(true), dialogs };
}

/**
 * Encendido de la PC en el detalle: acción principal arriba, motivo en una línea y progreso en el sitio
 * (`stay`), igual que en Hoy. «Por conectar» o «Sin señal» nunca se presenta como apagada.
 */
export function DesktopControls({ resource }: { resource: DetailedResource }) {
  const { active, running, canPick, system, powerReason, systemReason, openPower, openPicker, dialogs } = usePcControl(resource, { stay: true });
  return <div className="inv-actions inv-pc" aria-label={`Energía de ${resource.name}`} role="group">
    {active ? <InvProgress operation={active} /> : <>
      <div className="inv-actions__row">
        <button type="button" className={running ? "btn inv-btn" : "v2-go inv-btn"} disabled={powerReason !== null} onClick={openPower}><Icon name="power" />{running ? "Apagar" : "Encender"}</button>
        {!canPick && <button type="button" className="btn inv-btn" disabled={systemReason !== null} onClick={openPicker}>Sistema{running && system ? `: ${system}` : ""} ▾</button>}
      </div>
      {powerReason && <p className="inv-reason">{powerReason}</p>}
      {!canPick && systemReason && powerReason === null && <p className="inv-reason">Sistema: {systemReason}</p>}
    </>}
    {dialogs}
  </div>;
}
